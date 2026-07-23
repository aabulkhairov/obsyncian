import { App, Notice, TFile, normalizePath } from "obsidian";
import { ApiClient, ApiError, ChangeRecord } from "./api";
import { BaseStore } from "./basestore";
import { ConfigFile, ConfigStore } from "./configstore";
import { Codec } from "./codec";
import { isMergeablePath, merge3Markers, tryDecodeUtf8 } from "./merge";
import { conflictPath, dirname, hasForbiddenNameChars, sha256Hex } from "./util";

export interface IndexEntry {
  path: string;
  version: number;
  localHash: string; // hash of plaintext on disk at last sync
  remoteHash: string | null; // server-side ciphertext_hash at last sync
  mtime: number;
  size: number;
}

export interface SyncState {
  cursor: number;
  files: Record<string, IndexEntry>; // keyed by file_id
  lastSyncAt?: number; // epoch ms of the last successful sync
}

export function emptySyncState(): SyncState {
  return { cursor: 0, files: {} };
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  merged: number; // concurrent edits resolved by a clean 3-way merge
  errors: string[];
  // The vault owner ran out of storage mid-push (server said quota_exceeded).
  // Account-level, so the push halts and the plugin pauses auto-sync until the
  // user pays and manually re-syncs — see SyncEngine.push and main's syncNow.
  quotaBlocked: boolean;
  // Remote files this device can never write: their names contain
  // characters Obsidian forbids (created outside Obsidian on the source
  // device). Skipped up front — no download, no per-cycle error spam.
  unwritablePaths: string[];
}

// How overlapping edits (same lines changed on two devices) are resolved:
// "merge" keeps a single file with inline conflict markers; "conflictFile"
// keeps the local file and parks the remote version in a "(conflict …)" copy.
export type ConflictMode = "merge" | "conflictFile";

interface SyncCallbacks {
  onStatus(text: string): void;
  saveState(): Promise<void>;
  excludes(): string[]; // folder prefixes to skip, e.g. ["Private", "Attachments/Huge"]
  syncConfig(): boolean; // sync the .obsidian config folder (plugins/themes/settings)?
  conflictMode(): ConflictMode; // how to resolve overlapping concurrent edits
}

export function isExcluded(path: string, excludes: string[]): boolean {
  return excludes.some((prefix) => {
    const clean = prefix.replace(/\/+$/, "");
    return clean !== "" && (path === clean || path.startsWith(clean + "/"));
  });
}

const MAX_FILE_SIZE = 200 * 1024 * 1024;
// A single oversized file: skip just it and keep syncing the rest. It'll
// keep failing every cycle until the file itself changes or the owner's plan
// does, so don't re-attempt it in between (that'd be pure waste and, left
// unchecked, a self-sustaining hammer on the server). quota_exceeded is NOT
// here: it's account-level, not per-file, so it halts the whole push instead
// — see the catch in push().
const PERMANENT_ERROR_CODES = new Set(["file_too_large"]);
const DOWNLOAD_BATCH = 100; // matches server MAX_BATCH in downloads_controller.rb
const DOWNLOAD_CONCURRENCY = 8;
const PUSH_CONCURRENCY = 6;
const PROGRESS_BAR_WIDTH = 10;
// How often (in processed items) pull/push force a real event-loop yield so
// the status bar/sidebar actually repaints mid-run — see the comments at
// each call site for why this is needed at all.
const PROGRESS_YIELD_EVERY = 25;

function progressText(prefix: string, current: number, total: number): string {
  if (total <= 0) return prefix;
  const pct = Math.min(100, Math.round((current / total) * 100));
  const filled = Math.round((PROGRESS_BAR_WIDTH * pct) / 100);
  const bar = "▰".repeat(filled) + "▱".repeat(PROGRESS_BAR_WIDTH - filled);
  return `${prefix} ${bar} ${current}/${total}`;
}

// A plain `await Promise.resolve()` only flushes the microtask queue, which
// isn't enough to let Obsidian's renderer actually paint a DOM update — a
// real macrotask boundary (setTimeout) is what's needed.
function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// One pull+push cycle over the whole vault. No CRDTs: concurrent edits to a
// text file are resolved with a line-based 3-way merge against the shadow
// base (last-synced plaintext); overlapping edits — and everything
// non-mergeable — still produce a "(conflict …)" copy where both versions
// survive. A local rename is pushed as delete+create (no history linkage).
export class SyncEngine {
  private running = false;
  private codec!: Codec;
  // Paths that just hit a permanent per-file limit, keyed to the exact
  // size+mtime that failed — deliberately in-memory only (not persisted):
  // it resets on plugin reload/Obsidian restart, which is enough of a
  // periodic retry to notice a plan upgrade without re-hammering the
  // server every cycle in between. clearBlocked() forces an earlier retry
  // (e.g. right after the user upgrades) without waiting for a restart.
  private blocked = new Map<string, { size: number; mtime: number }>();

  constructor(
    private app: App,
    private api: ApiClient,
    // Resolved at the start of every cycle: throws while the E2EE vault is
    // locked (no/wrong passphrase), which aborts the sync loudly.
    private codecProvider: () => Promise<Codec>,
    private vaultId: () => string,
    private state: SyncState,
    private base: BaseStore,
    private configStore: ConfigStore,
    private cb: SyncCallbacks
  ) {}

  get busy(): boolean {
    return this.running;
  }

  // Forces the next cycle to retry every permanently-blocked file, even if
  // it hasn't changed — used when the user explicitly asks to sync (e.g.
  // right after upgrading their plan), so they don't have to edit the file
  // or restart Obsidian just to prove the limit is gone.
  clearBlocked(): void {
    this.blocked.clear();
  }

  async sync(): Promise<SyncReport | null> {
    if (this.running) return null;
    this.running = true;
    const report: SyncReport = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, merged: 0, errors: [], unwritablePaths: [], quotaBlocked: false };
    try {
      this.codec = await this.codecProvider();
      this.cb.onStatus("pulling…");
      await this.pull(report);
      this.cb.onStatus("pushing…");
      await this.push(report);
      // Once the account is over quota every further push fails identically,
      // so don't even attempt the config pass — the vault push already flagged
      // it and that's enough to pause the plugin.
      if (this.cb.syncConfig() && !report.quotaBlocked) await this.pushConfig(report);
      this.state.lastSyncAt = Date.now();
      await this.cb.saveState();
      const at = new Date().toTimeString().slice(0, 5);
      // Flip `running` false *before* announcing the terminal status — the
      // sidebar re-renders in response to onStatus, reading `busy` at that
      // exact moment. Doing this after (as the old `finally` block did) let
      // a render land showing "synced HH:MM" (implying done) with the
      // button still saying "Syncing…" (still busy) — an inconsistent
      // snapshot that stuck until some unrelated later render corrected it.
      this.running = false;
      this.cb.onStatus(report.errors.length ? `errors (${report.errors.length})` : `synced ${at}`);
      return report;
    } catch (e) {
      report.errors.push(String(e));
      this.running = false;
      this.cb.onStatus("sync failed");
      throw e;
    } finally {
      this.running = false;
      await this.cb.saveState();
    }
  }

  // ---- pull ----------------------------------------------------------------

  private async pull(report: SyncReport): Promise<void> {
    const startCursor = this.state.cursor;
    let processed = 0;
    for (;;) {
      const page = await this.api.changes(this.vaultId(), this.state.cursor);
      // Recomputed per page in case latest_revision creeps forward from a
      // concurrent commit mid-pull — good enough for a progress estimate.
      const total = Math.max(page.changes.length, page.latest_revision - startCursor);
      const blobs = await this.prefetchBlobs(page.changes, report);
      for (const change of page.changes) {
        try {
          await this.applyRemoteChange(change, report, blobs);
        } catch (e) {
          report.errors.push(`pull ${change.file_id}: ${e}`);
        }
        this.state.cursor = Math.max(this.state.cursor, change.revision);
        processed++;
        if (processed % 5 === 0 || processed === total) {
          this.cb.onStatus(progressText("pulling", processed, total));
        }
        // Applying an already-known change (self-echo, matching hash) never
        // awaits real network/disk I/O, so a big run of them can process a
        // whole page without the event loop ever getting back to the
        // renderer — the status text updates in the DOM, but the screen
        // never repaints until something actually yields, making progress
        // look like it jumps in page-sized (500) chunks instead of
        // counting up smoothly. A periodic real yield fixes that.
        if (processed % PROGRESS_YIELD_EVERY === 0) await yieldToRenderer();
      }
      await this.cb.saveState();
      if (!page.has_more) {
        this.state.cursor = Math.max(this.state.cursor, page.latest_revision);
        break;
      }
    }
  }

  // Presigns and downloads every blob a page's changes will actually need,
  // in batches of DOWNLOAD_BATCH with DOWNLOAD_CONCURRENCY parallel fetches —
  // instead of one presign+GET round trip per file (the old behavior), which
  // serializes the whole pull behind per-request latency. Skips anything
  // applyRemoteChange would skip anyway (self-echo, pure renames).
  private async prefetchBlobs(changes: ChangeRecord[], report: SyncReport): Promise<Map<string, ArrayBuffer>> {
    const blobs = new Map<string, ArrayBuffer>();
    const candidates = changes.filter((c) => {
      if (c.deleted) return false;
      const entry = this.state.files[c.file_id];
      if (entry && entry.version >= c.version) return false;
      if (entry && entry.remoteHash === c.ciphertext_hash) return false;
      return true;
    });

    // Filter out files this device can never write BEFORE downloading —
    // otherwise their blobs get re-fetched every single cycle (the write
    // fails, the index never advances). Decoding a path is just a small
    // AES operation; downloading a blob is real bandwidth.
    const need: ChangeRecord[] = [];
    for (const c of candidates) {
      const path = await this.codec.decodePath(c.encrypted_path);
      // Config files when the toggle is off: never applied, so don't spend
      // bandwidth fetching their blobs (the change is skipped and the cursor
      // advances regardless).
      if (this.configStore.owns(path) && !this.cb.syncConfig()) continue;
      if (hasForbiddenNameChars(path)) {
        if (!report.unwritablePaths.includes(path)) report.unwritablePaths.push(path);
      } else {
        need.push(c);
      }
    }
    if (!need.length) return blobs;

    const urls = new Map<string, string>();
    for (let i = 0; i < need.length; i += DOWNLOAD_BATCH) {
      const batch = need.slice(i, i + DOWNLOAD_BATCH);
      const { downloads } = await this.api.presignDownloads(this.vaultId(), batch.map((c) => c.file_id));
      for (const d of downloads) urls.set(d.file_id, d.get_url);
    }

    const queue = [...urls.entries()];
    const worker = async () => {
      let item: [string, string] | undefined;
      while ((item = queue.pop())) {
        const [fileId, url] = item;
        try {
          blobs.set(fileId, await this.api.getBlob(url));
        } catch (e) {
          report.errors.push(`download ${fileId}: ${e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, worker));
    return blobs;
  }

  private async applyRemoteChange(
    change: ChangeRecord,
    report: SyncReport,
    blobs: Map<string, ArrayBuffer>
  ): Promise<void> {
    const entry = this.state.files[change.file_id];
    // Self-echo: our own committed version coming back on the next pull.
    if (entry && entry.version >= change.version) return;

    if (change.deleted) {
      await this.applyRemoteDelete(change, entry, report);
      return;
    }

    // Remote paths come from another device — normalize before touching disk.
    const path = normalizePath(await this.codec.decodePath(change.encrypted_path));

    // Config files (.obsidian/…) live outside the Vault file tree and take a
    // separate adapter-based path. When the toggle is off we ignore them
    // entirely (the cursor still advances, so we don't re-see them).
    if (this.configStore.owns(path)) {
      if (this.cb.syncConfig()) await this.applyRemoteConfigChange(change, entry, path, report, blobs);
      return;
    }

    if (isExcluded(path, this.cb.excludes())) return;
    // Covers the paths prefetch already skipped, plus renames TO a
    // forbidden name (which need no blob but would still fail to write).
    if (hasForbiddenNameChars(path)) {
      if (!report.unwritablePaths.includes(path)) report.unwritablePaths.push(path);
      return;
    }

    // Pure rename: same content, new path.
    if (entry && entry.remoteHash === change.ciphertext_hash && entry.path !== path) {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (file instanceof TFile) {
        await this.ensureFolder(path);
        await this.app.fileManager.renameFile(file, path);
      }
      this.updateEntry(change.file_id, { ...entry, path, version: change.version });
      report.pulled++;
      return;
    }

    const remoteBytes = blobs.get(change.file_id);
    if (!remoteBytes) return; // presign/fetch failed — already recorded in report.errors
    const plaintext = await this.codec.decodeContent(remoteBytes);
    const localFile = this.app.vault.getAbstractFileByPath(path);

    if (localFile instanceof TFile) {
      const localBytes = await this.app.vault.readBinary(localFile);
      const localHash = await sha256Hex(localBytes);
      const remotePlainHash = await sha256Hex(plaintext);

      if (localHash === remotePlainHash) {
        // Same content already present (e.g. two devices made the same edit).
        this.updateEntry(change.file_id, {
          path, version: change.version, localHash,
          remoteHash: change.ciphertext_hash,
          mtime: localFile.stat.mtime, size: localFile.stat.size,
        });
        await this.saveBase(change.file_id, path, plaintext);
        return;
      }

      const locallyModified = !entry || entry.localHash !== localHash || entry.path !== path;
      if (locallyModified) {
        // Both sides changed. For text files, do a line-based 3-way merge
        // against the shadow base (the last plaintext both sides agreed on).
        // Disjoint edits merge cleanly. Overlapping edits either merge inline
        // with conflict markers ("Automatically merge") or fall through to a
        // conflict copy ("Create conflict file") — chosen in settings.
        const merged = entry && isMergeablePath(path)
          ? await this.tryMerge(change.file_id, entry, localBytes, plaintext)
          : null;
        if (merged && (!merged.conflict || this.cb.conflictMode() === "merge")) {
          await this.writeLocal(path, merged.bytes);
          this.updateEntry(change.file_id, {
            path, version: change.version,
            localHash: remotePlainHash, // remote is the new synced base…
            remoteHash: change.ciphertext_hash,
            mtime: 0, size: -1, // …force the push scan to re-hash and upload the merge
          });
          await this.base.write(change.file_id, plaintext);
          report.merged++;
          new Notice(
            merged.conflict
              ? `Syncian: merged concurrent edits in ${path} — review the conflict markers (search “<<<<<<<”).`
              : `Syncian: auto-merged concurrent edits in ${path}.`
          );
          return;
        }

        // "Create conflict file" mode with overlapping edits, or unmergeable
        // content: keep the local file (it will be pushed as the next
        // version), park the remote version in a conflict copy.
        const copy = normalizePath(conflictPath(path));
        await this.app.vault.createBinary(copy, plaintext);
        this.updateEntry(change.file_id, {
          path, version: change.version,
          localHash: remotePlainHash, // pretend remote is the synced base…
          remoteHash: change.ciphertext_hash,
          mtime: 0, size: -1, // …but force the push scan to re-hash and upload local
        });
        await this.saveBase(change.file_id, path, plaintext);
        report.conflicts++;
        new Notice(`Syncian: conflict on ${path} — saved a conflict copy.`);
        return;
      }
    }

    await this.writeLocal(path, plaintext);
    const written = this.app.vault.getAbstractFileByPath(path);
    if (!(written instanceof TFile)) {
      report.errors.push(`pull ${change.file_id}: wrote ${path} but can't stat it back`);
      return;
    }
    this.updateEntry(change.file_id, {
      path, version: change.version,
      localHash: await sha256Hex(plaintext),
      remoteHash: change.ciphertext_hash,
      mtime: written.stat.mtime, size: written.stat.size,
    });
    await this.saveBase(change.file_id, path, plaintext);
    report.pulled++;
  }

  // Config files (.obsidian/…) applied through the adapter. Non-mergeable by
  // nature (.json/.js), so no 3-way merge and no shadow base — overlapping
  // edits produce a conflict copy, same as binaries.
  private async applyRemoteConfigChange(
    change: ChangeRecord,
    entry: IndexEntry | undefined,
    path: string,
    report: SyncReport,
    blobs: Map<string, ArrayBuffer>
  ): Promise<void> {
    // Pure rename: same content, new path. Move the old file's bytes over
    // (rename blobs aren't prefetched, so we must reuse what's on disk).
    if (entry && entry.remoteHash === change.ciphertext_hash && entry.path !== path) {
      const bytes = await this.configStore.read(entry.path).catch(() => null);
      if (bytes) {
        await this.configStore.remove(entry.path);
        await this.configStore.write(path, bytes);
      }
      const st = await this.configStore.stat(path);
      this.updateEntry(change.file_id, {
        ...entry, path, version: change.version,
        mtime: st?.mtime ?? 0, size: st?.size ?? -1,
      });
      report.pulled++;
      return;
    }

    const remoteBytes = blobs.get(change.file_id);
    if (!remoteBytes) return; // presign/fetch failed — already recorded in report.errors
    const plaintext = await this.codec.decodeContent(remoteBytes);

    let localBytes: ArrayBuffer | null = null;
    try { localBytes = await this.configStore.read(path); } catch { localBytes = null; }

    if (localBytes) {
      const localHash = await sha256Hex(localBytes);
      const remotePlainHash = await sha256Hex(plaintext);
      if (localHash === remotePlainHash) {
        const st = await this.configStore.stat(path);
        this.updateEntry(change.file_id, {
          path, version: change.version, localHash,
          remoteHash: change.ciphertext_hash,
          mtime: st?.mtime ?? 0, size: st?.size ?? -1,
        });
        return;
      }
      const locallyModified = !entry || entry.localHash !== localHash || entry.path !== path;
      if (locallyModified) {
        const copy = normalizePath(conflictPath(path));
        await this.configStore.write(copy, plaintext);
        this.updateEntry(change.file_id, {
          path, version: change.version,
          localHash: remotePlainHash, // pretend remote is the synced base…
          remoteHash: change.ciphertext_hash,
          mtime: 0, size: -1, // …but force the push scan to re-hash and upload local
        });
        report.conflicts++;
        new Notice(`Syncian: conflict on ${path} — saved a conflict copy.`);
        return;
      }
    }

    await this.configStore.write(path, plaintext);
    const st = await this.configStore.stat(path);
    this.updateEntry(change.file_id, {
      path, version: change.version,
      localHash: await sha256Hex(plaintext),
      remoteHash: change.ciphertext_hash,
      mtime: st?.mtime ?? 0, size: st?.size ?? -1,
    });
    report.pulled++;
  }

  // Shadow only what can ever be merged; for anything else make sure no
  // stale base survives (a rename can change a file's extension in place).
  private async saveBase(fileId: string, path: string, bytes: ArrayBuffer): Promise<void> {
    if (isMergeablePath(path)) {
      await this.base.write(fileId, bytes);
    } else {
      await this.base.remove(fileId);
    }
  }

  // Returns the merged bytes plus whether inline conflict markers were needed,
  // or null when merging is impossible at all — base missing/stale (crash,
  // plugin upgrade) or non-UTF-8 content. Overlapping edits are NOT null: they
  // merge with markers, and the caller decides (per the conflict-resolution
  // setting) whether to keep that or fall back to a conflict copy.
  private async tryMerge(
    fileId: string,
    entry: IndexEntry,
    localBytes: ArrayBuffer,
    remoteBytes: ArrayBuffer
  ): Promise<{ bytes: ArrayBuffer; conflict: boolean } | null> {
    const baseBytes = await this.base.read(fileId);
    if (!baseBytes || (await sha256Hex(baseBytes)) !== entry.localHash) return null;
    const base = tryDecodeUtf8(baseBytes);
    const local = tryDecodeUtf8(localBytes);
    const remote = tryDecodeUtf8(remoteBytes);
    if (base === null || local === null || remote === null) return null;
    const { text, conflict } = merge3Markers(base, local, remote);
    return { bytes: new TextEncoder().encode(text).buffer as ArrayBuffer, conflict };
  }

  private async applyRemoteDelete(change: ChangeRecord, entry: IndexEntry | undefined, report: SyncReport): Promise<void> {
    if (!entry) return;

    // Config files: delete via the adapter, and only when the toggle is on.
    if (this.configStore.owns(entry.path)) {
      if (!this.cb.syncConfig()) return; // toggle off: don't touch it, keep the index entry
      let localBytes: ArrayBuffer | null = null;
      try { localBytes = await this.configStore.read(entry.path); } catch { localBytes = null; }
      if (localBytes) {
        if ((await sha256Hex(localBytes)) === entry.localHash) {
          await this.configStore.remove(entry.path);
          report.deletedLocal++;
        }
        // Modified locally since last sync: keep it. Dropping the index entry
        // makes the next push treat it as new (delete loses to edit).
      }
      delete this.state.files[change.file_id];
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (file instanceof TFile) {
      const localHash = await sha256Hex(await this.app.vault.readBinary(file));
      if (localHash === entry.localHash) {
        // trashFile (not Vault.trash) respects the user's deletion preference.
        await this.app.fileManager.trashFile(file);
        report.deletedLocal++;
      }
      // Locally modified since last sync: keep the file. Dropping the index
      // entry makes the push scan treat it as brand new (delete loses to edit).
    }
    delete this.state.files[change.file_id];
    await this.base.remove(change.file_id);
  }

  // ---- push ----------------------------------------------------------------

  private async push(report: SyncReport): Promise<void> {
    const byPath = new Map<string, [string, IndexEntry]>();
    for (const [id, entry] of Object.entries(this.state.files)) byPath.set(entry.path, [id, entry]);

    const excludes = this.cb.excludes();
    const localFiles = this.app.vault.getFiles().filter((f) => !isExcluded(f.path, excludes));
    const seen = new Set<string>(localFiles.map((f) => f.path));

    // Drop stale entries for files that no longer exist — otherwise a
    // renamed/deleted file's block never clears.
    for (const path of this.blocked.keys()) {
      if (!seen.has(path)) this.blocked.delete(path);
    }

    // Each pushFile does its own presign+PUT+commit round trip — the API has
    // no batch-upload endpoint (unlike downloads), but commits are already
    // serialized per vault server-side (CommitFileChange locks the vault
    // row), so running several files concurrently here is safe: their
    // presign+PUT phases genuinely overlap, only commit briefly queues.
    let processed = 0;
    let next = 0;
    // Flipped the moment any file hits quota_exceeded — an account-level limit,
    // so every remaining push would fail the same way. Stops the workers from
    // starting more files (in-flight ones just finish).
    let quotaHalted = false;
    const worker = async () => {
      while (next < localFiles.length && !quotaHalted) {
        const file = localFiles[next++];
        try {
          await this.pushFile(file, byPath.get(file.path), report);
        } catch (e) {
          if (e instanceof ApiError && e.code === "version_conflict") {
            // Another device won the race; next sync cycle pulls then re-pushes.
            report.errors.push(`deferred (conflict): ${file.path}`);
          } else if (e instanceof ApiError && e.code === "quota_exceeded") {
            // The vault is out of storage. Halt the whole push and flag it —
            // the plugin pauses auto-sync and asks the user to pay, rather than
            // re-hitting (and re-reporting) the same limit on every file, every
            // cycle. Deliberately NOT recorded in report.errors: it's a billing
            // state, not a bug, so it never goes to the error channel.
            quotaHalted = true;
            report.quotaBlocked = true;
          } else if (e instanceof ApiError && PERMANENT_ERROR_CODES.has(e.code)) {
            // Won't succeed again until the file or the plan changes — stop
            // retrying it every cycle.
            this.blocked.set(file.path, { size: file.stat.size, mtime: file.stat.mtime });
            report.errors.push(`skipped (${e.code}): ${file.path} — will retry once the file changes or you upgrade`);
          } else {
            report.errors.push(`push ${file.path}: ${e}`);
          }
        }
        processed++;
        if (processed % 5 === 0 || processed === localFiles.length) {
          this.cb.onStatus(progressText("pushing", processed, localFiles.length));
        }
        // See the matching comment in pull() — unchanged files skip instantly
        // (no real I/O to await), which can starve the renderer of a chance
        // to actually paint the updated status text.
        if (processed % PROGRESS_YIELD_EVERY === 0) await yieldToRenderer();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, localFiles.length) }, worker));

    // Over quota: bail before the deletion pass too. Deletes wouldn't fail on
    // quota, but the point of the halt is to stop touching the server until the
    // user has paid and explicitly re-synced.
    if (quotaHalted) return;

    // Anything indexed but no longer on disk was deleted locally. Excluded
    // paths are skipped — excluding a folder must not delete it remotely.
    for (const [path, [fileId, entry]] of byPath) {
      // Config entries live outside getFiles(), so they're never in `seen` —
      // without this guard the vault pass would delete every synced config
      // file on the server each cycle. Config deletions are handled by
      // pushConfig() against its own listing.
      if (this.configStore.owns(path)) continue;
      if (seen.has(path) || isExcluded(path, excludes)) continue;
      try {
        await this.api.commit(this.vaultId(), {
          file_id: fileId,
          base_version: entry.version,
          encrypted_path: await this.codec.encodePath(path),
          deleted: true,
        });
        delete this.state.files[fileId];
        await this.base.remove(fileId);
        report.deletedRemote++;
      } catch (e) {
        report.errors.push(`delete ${path}: ${e}`);
      }
    }
  }

  private async pushFile(file: TFile, indexed: [string, IndexEntry] | undefined, report: SyncReport): Promise<void> {
    if (file.stat.size > MAX_FILE_SIZE) return;
    const block = this.blocked.get(file.path);
    if (block && block.size === file.stat.size && block.mtime === file.stat.mtime) return;
    const [fileId, entry] = indexed ?? [crypto.randomUUID(), undefined];

    if (entry && entry.mtime === file.stat.mtime && entry.size === file.stat.size) return;

    const bytes = await this.app.vault.readBinary(file);
    const localHash = await sha256Hex(bytes);
    if (entry && entry.localHash === localHash) {
      // mtime churn without content change; just refresh the index.
      this.updateEntry(fileId, { ...entry, mtime: file.stat.mtime, size: file.stat.size });
      return;
    }

    const encoded = await this.codec.encodeContent(bytes);
    const ciphertextHash = await sha256Hex(encoded);
    const { blob_key, put_url } = await this.api.presignUpload(this.vaultId(), encoded.byteLength);
    await this.api.putBlob(put_url, encoded);
    const committed = await this.api.commit(this.vaultId(), {
      file_id: fileId,
      base_version: entry?.version ?? 0,
      encrypted_path: await this.codec.encodePath(file.path),
      size: encoded.byteLength,
      ciphertext_hash: ciphertextHash,
      blob_key,
    });
    this.updateEntry(fileId, {
      path: file.path, version: committed.version,
      localHash, remoteHash: ciphertextHash,
      mtime: file.stat.mtime, size: file.stat.size,
    });
    await this.saveBase(fileId, file.path, bytes);
    report.pushed++;
  }

  // ---- config push ---------------------------------------------------------

  // Pushes the .obsidian config folder through the adapter. Separate from
  // push() because config files aren't in getFiles(); its deletion pass is
  // scoped to config entries so it can't touch vault files (and vice-versa,
  // guarded in push()).
  private async pushConfig(report: SyncReport): Promise<void> {
    const files = await this.configStore.list();
    const byPath = new Map<string, [string, IndexEntry]>();
    for (const [id, entry] of Object.entries(this.state.files)) {
      if (this.configStore.owns(entry.path)) byPath.set(entry.path, [id, entry]);
    }
    const seen = new Set<string>(files.map((f) => f.path));
    for (const path of this.blocked.keys()) {
      if (this.configStore.owns(path) && !seen.has(path)) this.blocked.delete(path);
    }

    for (const cf of files) {
      try {
        await this.pushConfigFile(cf, byPath.get(cf.path), report);
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict") {
          report.errors.push(`deferred (conflict): ${cf.path}`);
        } else if (e instanceof ApiError && e.code === "quota_exceeded") {
          // Account-level — see push(). Flag and stop the config pass.
          report.quotaBlocked = true;
          break;
        } else if (e instanceof ApiError && PERMANENT_ERROR_CODES.has(e.code)) {
          this.blocked.set(cf.path, { size: cf.size, mtime: cf.mtime });
          report.errors.push(`skipped (${e.code}): ${cf.path} — will retry once the file changes or you upgrade`);
        } else {
          report.errors.push(`push ${cf.path}: ${e}`);
        }
      }
    }

    if (report.quotaBlocked) return; // over quota — stop, same as push()

    // Config files indexed but no longer on disk were deleted locally.
    for (const [path, [fileId, entry]] of byPath) {
      if (seen.has(path)) continue;
      try {
        await this.api.commit(this.vaultId(), {
          file_id: fileId,
          base_version: entry.version,
          encrypted_path: await this.codec.encodePath(path),
          deleted: true,
        });
        delete this.state.files[fileId];
        report.deletedRemote++;
      } catch (e) {
        report.errors.push(`delete ${path}: ${e}`);
      }
    }
  }

  private async pushConfigFile(cf: ConfigFile, indexed: [string, IndexEntry] | undefined, report: SyncReport): Promise<void> {
    if (cf.size > MAX_FILE_SIZE) return;
    const block = this.blocked.get(cf.path);
    if (block && block.size === cf.size && block.mtime === cf.mtime) return;
    const [fileId, entry] = indexed ?? [crypto.randomUUID(), undefined];

    if (entry && entry.mtime === cf.mtime && entry.size === cf.size) return;

    const bytes = await this.configStore.read(cf.path);
    const localHash = await sha256Hex(bytes);
    if (entry && entry.localHash === localHash) {
      this.updateEntry(fileId, { ...entry, mtime: cf.mtime, size: cf.size });
      return;
    }

    const encoded = await this.codec.encodeContent(bytes);
    const ciphertextHash = await sha256Hex(encoded);
    const { blob_key, put_url } = await this.api.presignUpload(this.vaultId(), encoded.byteLength);
    await this.api.putBlob(put_url, encoded);
    const committed = await this.api.commit(this.vaultId(), {
      file_id: fileId,
      base_version: entry?.version ?? 0,
      encrypted_path: await this.codec.encodePath(cf.path),
      size: encoded.byteLength,
      ciphertext_hash: ciphertextHash,
      blob_key,
    });
    this.updateEntry(fileId, {
      path: cf.path, version: committed.version,
      localHash, remoteHash: ciphertextHash,
      mtime: cf.mtime, size: cf.size,
    });
    report.pushed++;
  }

  // ---- helpers ---------------------------------------------------------------

  private updateEntry(fileId: string, entry: IndexEntry): void {
    this.state.files[fileId] = entry;
  }

  private async writeLocal(path: string, data: ArrayBuffer): Promise<void> {
    await this.ensureFolder(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
    } else {
      await this.app.vault.createBinary(path, data);
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = dirname(path);
    if (!dir) return;
    const parts = dir.split("/");
    let current = "";
    for (const part of parts) {
      current = normalizePath(current ? `${current}/${part}` : part);
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // raced with another create; fine
        }
      }
    }
  }
}
