import { App, Notice, TFile, normalizePath } from "obsidian";
import { ApiClient, ApiError, ChangeRecord, CommitPayload } from "./api";
import { BaseStore } from "./basestore";
import { ConfigStore } from "./configstore";
import { Codec } from "./codec";
import { isMergeablePath, merge3Markers, mergeJson, mergeUnion, tryDecodeUtf8 } from "./merge";
import { conflictPath, dirname, hasForbiddenNameChars, sha256Hex } from "./util";

export interface IndexEntry {
  path: string;
  version: number;
  localHash: string; // hash of plaintext on disk at last sync
  remoteHash: string | null; // server-side ciphertext_hash at last sync
  mtime: number;
  size: number;
  // Set while the file has been renamed on this device but the server hasn't
  // been told yet: `path` is where it is now, `serverPath` where the server
  // still thinks it is. Cleared by the rename commit.
  serverPath?: string;
  // The server told us (path_taken) that another file owns this entry's path,
  // and that other file is in our index too — two ids for one path, left over
  // from before the server enforced one. This one stops being pushed to.
  pathLost?: boolean;
}

export interface SyncState {
  cursor: number;
  files: Record<string, IndexEntry>; // keyed by file_id
  lastSyncAt?: number; // epoch ms of the last successful sync
  // Which vault this index was built against. The index is only meaningful
  // for that vault, so switching vaults must clear it — but re-linking the
  // SAME vault (log out -> log back in, unlink -> relink) must NOT. Without
  // an entry, pull replays from cursor 0 against files that are still on
  // disk, and tryMerge never even runs (it needs the entry and its shadow
  // base), so every file that isn't byte-identical to the server comes back
  // as a conflict copy. See ObsyncPlugin.adoptVault.
  vaultId?: string;
  // Remote changes the pull has moved past without applying them (blob
  // download failed, write threw). The cursor can't stay behind for them —
  // one permanently bad change would make every cycle re-list everything
  // after it — so they are parked here and retried until they apply or a
  // newer change to the same file replaces them. Keyed by file_id.
  pending?: Record<string, PendingChange>;
  // The server's latest word on whether renames may be sent as path changes
  // (ChangesPage.in_place_renames). False until it says so — plugins released
  // before this one mishandle a rename that arrives together with an edit, so
  // while any of them still syncs the vault a rename stays delete + create.
  renamesOk?: boolean;
}

export interface PendingChange {
  change: ChangeRecord;
  attempts: number;
  nextAt: number; // epoch ms before which this isn't retried (backoff)
}

export function emptySyncState(): SyncState {
  return { cursor: 0, files: {} };
}

// Re-point `state` at `vaultId`, in place. Returns true when the existing
// index belongs to that vault and was kept, false when it was a different
// vault (or an index from before vaultId was tracked) and got cleared — the
// caller then also drops the shadow bases, which are indexed the same way.
export function adoptVaultState(state: SyncState, vaultId: string): boolean {
  if (vaultId && state.vaultId === vaultId) return true;
  // Assigned field by field, not via Object.assign(emptySyncState()) — that
  // leaves optional keys the fresh state doesn't mention (lastSyncAt) in
  // place, so the sidebar would report the *previous* vault's last sync.
  state.cursor = 0;
  state.files = {};
  state.lastSyncAt = undefined;
  state.pending = undefined;
  state.renamesOk = undefined;
  state.vaultId = vaultId || undefined;
  return false;
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  merged: number; // concurrent edits resolved by a clean 3-way merge
  renamed: number; // local renames/moves sent as such (no re-upload)
  errors: string[];
  // The same errors with every file path replaced by "<file>": the only form
  // that may leave the device (anonymous error reports). Note names are as
  // private as note contents.
  reportable: string[];
  // Files whose push lost a race to another device (version_conflict,
  // path_taken). Not errors: the next cycle pulls the other side, merges and
  // pushes again.
  deferred: string[];
  // The account has no active plan (server said payment_required). Like
  // quotaBlocked this is a billing state, not a bug: it must pause sync
  // rather than retry, or every cycle re-reports the same rejection — the
  // quota_exceeded storm of 1.0.14 is exactly that mistake.
  paymentRequired: boolean;
  // The vault owner ran out of storage mid-push (server said quota_exceeded).
  // Account-level, so the push halts and the plugin pauses auto-sync until the
  // user pays and manually re-syncs — see SyncEngine.push and main's syncNow.
  quotaBlocked: boolean;
  // Remote files this device can never write: their names contain
  // characters Obsidian forbids (created outside Obsidian on the source
  // device). Skipped up front — no download, no per-cycle error spam.
  unwritablePaths: string[];
  // Indexed files missing from this device that were NOT deleted on the
  // server because there are suspiciously many of them — see the guard in
  // push(). 0 when nothing is held.
  heldDeletions: number;
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

function isJsonPath(path: string): boolean {
  return path.toLowerCase().endsWith(".json");
}

// Files that ship as part of a plugin or theme rather than being written by
// the user.
function isBundledCodePath(path: string): boolean {
  return path.includes("/plugins/") || path.includes("/themes/");
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
// A push batch closes at the server's batch_limit files or this many bytes,
// whichever comes first; the pull applies a page in slices of the same size.
// Either way it's the most file content held in memory at once (a single
// larger file still goes through, on its own).
const PUSH_BATCH_BYTES = 32 * 1024 * 1024;
const PULL_SLICE_BYTES = 32 * 1024 * 1024;
// Files per group when the server has no batch endpoints and each file is
// still its own presign + commit.
const UNBATCHED_GROUP = 20;
const OWN_CHANGE_TTL_MS = 60_000;
// Backoff for a parked remote change that keeps failing: the first retry is
// on the very next cycle (a network blip heals at once), then 1 min doubling
// up to an hour, so a permanently bad one doesn't report an error per cycle.
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
// Mass-deletion guard: when at least this many indexed files, and more than a
// third of the index, are missing locally, push refuses to delete them on the
// server until the user confirms. "Missing" is all the engine can see — it
// can't tell a deliberate cleanup from a vault folder that failed to load.
const MASS_DELETE_MIN = 10;

interface PushJob {
  path: string;
  config: boolean; // lives in .obsidian, not the vault tree
  fileId: string;
  entry: IndexEntry | undefined;
  mtime: number;
  size: number;
  localHash: string;
  bytes: ArrayBuffer;
  rename: boolean; // content unchanged — only the path moves
}

interface PushRun {
  report: SyncReport;
  jobs: PushJob[];
  bytes: number;
  // Flipped the moment any file hits quota_exceeded — an account-level limit,
  // so every remaining push would fail the same way.
  halted: boolean;
}

type Outcome<T> = { ok: T } | { err: unknown };

function itemOutcome<I extends object, T>(item: I | { error: { code: string; message: string } } | undefined, pick: (item: I) => T): Outcome<T> {
  if (!item) return { err: new Error("no answer from the server for this file") };
  if ("error" in item) return { err: new ApiError(0, item.error.code, item.error.message) };
  return { ok: pick(item) };
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Thrown by applyRemoteChange when a change couldn't be applied for a reason
// that's already been reported (or needs no report) — park and retry it.
class RetryLater extends Error {}

// Consecutive runs of changes whose blobs add up to at most `limit` bytes (a
// single larger change gets a slice to itself).
// Records an error in full for this device's own display, and path-free for
// anything that gets reported off the device.
function recordError(report: SyncReport, message: string, path?: string): void {
  report.errors.push(message);
  report.reportable.push(path ? message.split(path).join("<file>") : message);
}

function slicesBySize(changes: ChangeRecord[], limit: number): ChangeRecord[][] {
  const slices: ChangeRecord[][] = [];
  let current: ChangeRecord[] = [];
  let bytes = 0;
  for (const change of changes) {
    const size = change.deleted ? 0 : change.size;
    if (current.length && bytes + size > limit) {
      slices.push(current);
      current = [];
      bytes = 0;
    }
    current.push(change);
    bytes += size;
  }
  if (current.length) slices.push(current);
  return slices;
}

function progressText(prefix: string, current: number, total: number): string {
  if (total <= 0) return prefix;
  const pct = Math.min(100, Math.round((current / total) * 100));
  const filled = Math.round((PROGRESS_BAR_WIDTH * pct) / 100);
  const bar = "▰".repeat(filled) + "▱".repeat(PROGRESS_BAR_WIDTH - filled);
  return `${prefix} ${bar} ${current}/${total}`;
}

// A plain `await Promise.resolve()` only flushes the microtask queue, which
// isn't enough to let Obsidian's renderer actually paint a DOM update — a
// real macrotask boundary (setTimeout) is what's needed. window.setTimeout,
// not the bare global, so it resolves against the right window when the
// vault is open in a popout.
function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

// One pull+push cycle over the whole vault. No CRDTs: concurrent edits to a
// text file are resolved with a 3-way merge against the shadow base
// (last-synced plaintext) — see merge3Markers for how far that goes; only
// what can't be merged at all produces a "(conflict …)" copy where both
// versions survive. A local rename keeps the file's identity: it is detected
// by content before the pull and committed as a path change, no re-upload.
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
  // The user's answer to a held mass deletion, consumed by the next cycle.
  private heldDecision: "delete" | "restore" | null = null;
  private confirmedMassDelete = false;
  // path -> file_id of entries with an un-pushed local rename (serverPath
  // set), rebuilt each cycle. Lets the pull notice in O(1) that a different
  // file has just landed on a path such an entry is holding.
  private standingRenames = new Map<string, string>();
  // The server's batch_limit as of this cycle's pull; 0 = no batch endpoints.
  private batchLimit = 0;
  // Revisions this device committed itself. The change signal announces
  // every commit to every device, the committer included.
  private ownRevisions = new Set<number>();
  // What the engine itself did to the vault, so the plugin can tell its own
  // writes from the user's when a file event fires. path -> resulting mtime,
  // or null for "we removed it / moved it away".
  private ownChanges = new Map<string, { mtime: number | null; at: number }>();

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
    for (const p of Object.values(this.state.pending ?? {})) p.nextAt = 0;
  }

  // Was the commit that produced this revision ours? (See ChangeSignal.)
  isOwnRevision(revision: number): boolean {
    return this.ownRevisions.has(revision);
  }

  // Did the engine itself leave `path` in this state? `mtime` is the file's
  // current mtime, or null if it no longer exists at that path.
  isOwnChange(path: string, mtime: number | null): boolean {
    const own = this.ownChanges.get(path);
    return own !== undefined && own.mtime === mtime;
  }

  private noteOwnChange(path: string, mtime: number | null): void {
    const now = Date.now();
    if (this.ownChanges.size > 5000) {
      for (const [p, c] of this.ownChanges) if (now - c.at > OWN_CHANGE_TTL_MS) this.ownChanges.delete(p);
    }
    this.ownChanges.set(path, { mtime, at: now });
  }

  // Answers a held mass deletion (report.heldDeletions) for the next cycle:
  // "delete" lets it through to the server, "restore" re-downloads the
  // missing files instead.
  resolveHeldDeletions(decision: "delete" | "restore"): void {
    this.heldDecision = decision;
  }

  async sync(): Promise<SyncReport | null> {
    if (this.running) return null;
    this.running = true;
    const report: SyncReport = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, merged: 0, renamed: 0, errors: [], reportable: [], deferred: [], unwritablePaths: [], quotaBlocked: false, paymentRequired: false, heldDeletions: 0 };
    const decision = this.heldDecision;
    this.heldDecision = null;
    this.confirmedMassDelete = decision === "delete";
    try {
      this.codec = await this.codecProvider();
      await this.detectLocalRenames();
      if (decision === "restore") await this.queueMissingForRestore();
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
      this.cb.onStatus(
        report.errors.length ? `errors (${report.errors.length})`
          : report.heldDeletions ? `${report.heldDeletions} deletions on hold`
          : `synced ${at}`
      );
      return report;
    } catch (e) {
      // No active plan: stop the cycle quietly. pull() calls /changes before
      // anything else, so this lands on the very first request — one flag per
      // cycle instead of a rejection per file, and nothing in report.errors
      // (a billing state must never reach the error channel).
      if (e instanceof ApiError && e.code === "payment_required") {
        report.paymentRequired = true;
        this.running = false;
        this.cb.onStatus("plan required — paused");
        return report;
      }
      recordError(report, String(e));
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
    // Parked changes due for a retry, snapshotted before the pull: anything
    // this pull parks (or re-parks with a newer change) is a different record
    // and waits for the next cycle rather than being tried twice in one.
    const now = Date.now();
    const due = Object.values(this.state.pending ?? {}).filter((p) => p.nextAt <= now);
    // A device with nothing at all doesn't need the vault's history of
    // deletions — ask the server to leave it out (see ApiClient.changes).
    const fresh = this.state.cursor === 0 && Object.keys(this.state.files).length === 0;
    let skipDeletedThrough: number | undefined;
    let processed = 0;
    for (;;) {
      const page = await this.api.changes(this.vaultId(), this.state.cursor, { fresh, skipDeletedThrough });
      if (fresh) skipDeletedThrough = page.skip_deleted_through;
      this.state.renamesOk = (page.min_protocol ?? 1) >= 2;
      this.batchLimit = page.batch_limit ?? 0;
      // Recomputed per page in case latest_revision creeps forward from a
      // concurrent commit mid-pull — good enough for a progress estimate.
      const total = Math.max(page.changes.length, page.latest_revision - startCursor);
      // A page is applied in slices bounded by bytes: a slice's blobs are all
      // downloaded before any is written, so a page of large attachments
      // taken whole could be gigabytes in memory.
      for (const slice of slicesBySize(page.changes, PULL_SLICE_BYTES)) {
        const blobs = await this.prefetchBlobs(slice, report);
        for (const change of slice) {
          await this.applyTracked(change, report, blobs);
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
          // look like it jumps in page-sized chunks instead of counting up
          // smoothly. A periodic real yield fixes that.
          if (processed % PROGRESS_YIELD_EVERY === 0) await yieldToRenderer();
        }
      }
      await this.cb.saveState();
      if (!page.has_more) {
        this.state.cursor = Math.max(this.state.cursor, page.latest_revision);
        break;
      }
    }
    for (const revision of this.ownRevisions) if (revision <= this.state.cursor) this.ownRevisions.delete(revision);

    const retry = due.filter((p) => this.state.pending?.[p.change.file_id] === p).map((p) => p.change);
    if (retry.length) {
      const blobs = await this.prefetchBlobs(retry, report);
      for (const change of retry) await this.applyTracked(change, report, blobs);
      await this.cb.saveState();
    }
  }

  // Applies one remote change and keeps the retry queue honest: applied (or
  // legitimately skipped) clears any parked record for that file, a failure
  // parks this change. The caller advances the cursor either way.
  private async applyTracked(change: ChangeRecord, report: SyncReport, blobs: Map<string, ArrayBuffer>): Promise<void> {
    try {
      await this.applyRemoteChange(change, report, blobs);
      if (this.state.pending) delete this.state.pending[change.file_id];
    } catch (e) {
      if (!(e instanceof RetryLater)) {
        let path: string | undefined;
        try { path = normalizePath(await this.codec.decodePath(change.encrypted_path)); } catch { path = undefined; }
        recordError(report, `pull ${change.file_id}: ${e}`, path);
      }
      const pending = (this.state.pending ??= {});
      const prev = pending[change.file_id];
      const attempts = prev && prev.change.version === change.version ? prev.attempts + 1 : 1;
      const delay = attempts < 2 ? 0 : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 2));
      pending[change.file_id] = { change, attempts, nextAt: Date.now() + delay };
    }
  }

  // Finds files that were renamed or moved on this device since the last
  // sync: an indexed file that's gone, and an un-indexed file with exactly
  // its content. Nothing is sent here — the entry just follows the file and
  // remembers where the server still has it (serverPath); pushFile commits
  // the move. Running before the pull matters: a remote edit to the file then
  // lands at its new local path instead of resurrecting the old one.
  //
  // Only while the server says every device on the vault can take a rename
  // (state.renamesOk, as of the previous cycle's pull); otherwise the push
  // sees a deleted file and a new one, exactly as older plugins send it.
  private async detectLocalRenames(): Promise<void> {
    const excludes = this.cb.excludes();
    const indexed = new Set<string>();
    const gone = new Map<number, [string, IndexEntry][]>(); // by size: only hash what could match
    for (const [id, entry] of Object.entries(this.state.files)) {
      indexed.add(entry.path);
      if (entry.size < 0 || this.configStore.owns(entry.path) || isExcluded(entry.path, excludes)) continue;
      if (this.app.vault.getAbstractFileByPath(entry.path) instanceof TFile) continue;
      const list = gone.get(entry.size);
      if (list) list.push([id, entry]);
      else gone.set(entry.size, [[id, entry]]);
    }
    if (gone.size && this.state.renamesOk) {
      for (const file of this.app.vault.getFiles()) {
        if (indexed.has(file.path) || isExcluded(file.path, excludes)) continue;
        const { mtime, size } = file.stat;
        const candidates = gone.get(size);
        if (!candidates?.length) continue;
        const hash = await sha256Hex(await this.app.vault.readBinary(file));
        const at = candidates.findIndex(([, entry]) => entry.localHash === hash);
        if (at < 0) continue;
        const [[id, entry]] = candidates.splice(at, 1);
        const serverPath = entry.serverPath ?? entry.path;
        const moved: IndexEntry = { ...entry, path: file.path, mtime, size, serverPath };
        if (serverPath === file.path) delete moved.serverPath; // moved back before we ever told anyone
        this.updateEntry(id, moved);
        indexed.add(file.path);
      }
    }
    this.standingRenames.clear();
    for (const [id, entry] of Object.entries(this.state.files)) {
      if (entry.serverPath !== undefined) this.standingRenames.set(entry.path, id);
    }
  }

  // A file with a different id is about to take `path`. If one of our
  // un-pushed renames was headed there, call it off: that entry goes back to
  // the path the server knows (where its file no longer is, so the push
  // deletes it remotely) and the local file is merged into the newcomer.
  private releaseStandingRename(path: string, fileId: string): void {
    const holder = this.standingRenames.get(path);
    if (!holder || holder === fileId) return;
    this.standingRenames.delete(path);
    const entry = this.state.files[holder];
    if (!entry || entry.serverPath === undefined) return;
    const { serverPath, ...rest } = entry;
    this.updateEntry(holder, { ...rest, path: serverPath });
  }

  // Indexed vault files (not config, not excluded) that aren't on disk.
  private missingEntries(): [string, IndexEntry][] {
    const excludes = this.cb.excludes();
    const out: [string, IndexEntry][] = [];
    for (const [id, entry] of Object.entries(this.state.files)) {
      if (this.configStore.owns(entry.path) || isExcluded(entry.path, excludes)) continue;
      if (!(this.app.vault.getAbstractFileByPath(entry.path) instanceof TFile)) out.push([id, entry]);
    }
    return out;
  }

  // "Restore" answer to a held mass deletion: forget the missing files and
  // park a change for each, so this cycle's pull downloads them again exactly
  // like any other change it failed to apply.
  private async queueMissingForRestore(): Promise<void> {
    const pending = (this.state.pending ??= {});
    for (const [fileId, entry] of this.missingEntries()) {
      pending[fileId] = {
        change: {
          file_id: fileId,
          encrypted_path: await this.codec.encodePath(entry.path),
          size: 0, version: entry.version, revision: 0,
          ciphertext_hash: entry.remoteHash, deleted: false,
        },
        attempts: 0,
        nextAt: 0,
      };
      delete this.state.files[fileId];
      await this.base.remove(fileId);
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

    const sizes = new Map(need.map((c) => [c.file_id, c.size]));
    const queue = [...urls.entries()];
    const worker = async () => {
      let item: [string, string] | undefined;
      while ((item = queue.pop())) {
        const [fileId, url] = item;
        try {
          blobs.set(fileId, await this.api.getBlob(url, sizes.get(fileId)));
        } catch (e) {
          recordError(report, `download ${fileId}: ${e}`);
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
    let entry = this.state.files[change.file_id];
    // Self-echo: our own committed version coming back on the next pull.
    if (entry && entry.version >= change.version) return;

    if (change.deleted) {
      await this.applyRemoteDelete(change, entry, report);
      return;
    }

    // Remote paths come from another device — normalize before touching disk.
    let path = normalizePath(await this.codec.decodePath(change.encrypted_path));

    // We renamed this file locally and haven't pushed that yet. If the remote
    // still has it where we left it, our rename stands and this change
    // applies at the new path; if the remote moved it as well, theirs wins.
    let standing: string | undefined;
    if (entry?.serverPath !== undefined) {
      if (path === entry.serverPath) {
        standing = entry.serverPath;
        path = entry.path;
      } else {
        const { serverPath: _dropped, ...rest } = entry;
        entry = rest;
        this.updateEntry(change.file_id, entry);
        this.standingRenames.delete(entry.path);
      }
    }
    await this.applyRemoteContent(change, entry, path, report, blobs);
    // Every branch above rewrites the entry from scratch; the rename is still
    // un-pushed, so put the marker back.
    const after = this.state.files[change.file_id];
    if (standing !== undefined && after && after.path === path) after.serverPath = standing;
  }

  private async applyRemoteContent(
    change: ChangeRecord,
    entry: IndexEntry | undefined,
    path: string,
    report: SyncReport,
    blobs: Map<string, ArrayBuffer>
  ): Promise<void> {

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

    // Renamed on the other device, with or without a content change. Move
    // our copy first, so whatever comes next — nothing, a plain update, a
    // merge with local edits — happens at the new path instead of leaving the
    // old file behind to be re-uploaded as a new one.
    if (entry && entry.path !== path) {
      const pure = entry.remoteHash === change.ciphertext_hash;
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (file instanceof TFile && (pure || !this.app.vault.getAbstractFileByPath(path))) {
        const from = entry.path;
        await this.ensureFolder(path);
        await this.app.fileManager.renameFile(file, path);
        this.noteOwnChange(from, null);
        this.noteOwnWrite(path);
      }
      entry = { ...entry, path };
      if (pure) {
        this.updateEntry(change.file_id, { ...entry, version: change.version });
        report.pulled++;
        return;
      }
      // Version left as is: if the content below fails to apply, it's retried.
      this.updateEntry(change.file_id, entry);
    }

    // Same content at the path we already have it: a version bump with
    // nothing to do (e.g. the other device renamed it away and back).
    if (entry && entry.remoteHash === change.ciphertext_hash && entry.path === path) {
      this.updateEntry(change.file_id, { ...entry, version: change.version });
      return;
    }

    const remoteBytes = blobs.get(change.file_id);
    if (!remoteBytes) throw new RetryLater(); // presign/fetch failed — already recorded in report.errors
    const plaintext = await this.codec.decodeContent(remoteBytes);
    const localFile = this.app.vault.getAbstractFileByPath(path);
    if (!entry && localFile) this.releaseStandingRename(path, change.file_id);

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
      if (locallyModified && await this.resolveConcurrent(change, entry, path, localBytes, localHash, plaintext, remotePlainHash, report)) {
        return;
      }
    }

    await this.writeLocal(path, plaintext);
    const written = this.app.vault.getAbstractFileByPath(path);
    if (!(written instanceof TFile)) {
      recordError(report, `pull ${change.file_id}: wrote ${path} but can't stat it back`, path);
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

  // The local file and the incoming remote version differ, and the local one
  // isn't simply the version we last synced. Works out what to keep, in order
  // of how much we know:
  //  1. a real 3-way merge against the shadow base;
  //  2. no usable index entry, but the base on disk shows one side is just
  //     an older version of the other — take the newer, nothing to merge;
  //  3. no base at all (same path created on two devices, a re-linked
  //     vault): a union merge, if the two are recognisably the same note;
  //  4. otherwise both survive as separate files (a conflict copy).
  // Returns false when the remote version should simply replace the local
  // file, true when it has dealt with the change itself.
  private async resolveConcurrent(
    change: ChangeRecord,
    entry: IndexEntry | undefined,
    path: string,
    localBytes: ArrayBuffer,
    localHash: string,
    plaintext: ArrayBuffer,
    remotePlainHash: string,
    report: SyncReport
  ): Promise<boolean> {
    const mergeable = isMergeablePath(path);
    // Whatever happens below, the remote version becomes the synced base and
    // the local file is re-hashed (and uploaded if it differs) by the push.
    const adoptRemoteAsBase = async () => {
      this.updateEntry(change.file_id, {
        path, version: change.version,
        localHash: remotePlainHash,
        remoteHash: change.ciphertext_hash,
        mtime: 0, size: -1,
      });
      await this.saveBase(change.file_id, path, plaintext);
    };

    let merged: { bytes: ArrayBuffer; conflict: boolean; union?: boolean } | null =
      entry && mergeable ? await this.tryMerge(change.file_id, entry, localBytes, plaintext) : null;

    if (!merged && mergeable) {
      const baseBytes = await this.base.read(change.file_id);
      const baseHash = baseBytes ? await sha256Hex(baseBytes) : null;
      // The base is written right after a push or pull, the index a little
      // later; if the app died in between, the base is the truth.
      if (baseHash === localHash) return false; // local is the old version: take remote
      if (baseHash === remotePlainHash) {
        // Remote is what we last synced (our own push, even): local is newer.
        await adoptRemoteAsBase();
        return true;
      }
      const local = tryDecodeUtf8(localBytes);
      const remote = tryDecodeUtf8(plaintext);
      const union = local !== null && remote !== null ? mergeUnion(local, remote) : null;
      if (union) {
        merged = { bytes: new TextEncoder().encode(union.text).buffer as ArrayBuffer, conflict: union.overlap, union: true };
      }
    }

    // Overlapping edits honour the setting: inline in "Automatically merge",
    // a conflict copy in "Create conflict file".
    if (merged && (!merged.conflict || this.cb.conflictMode() === "merge")) {
      await this.writeLocal(path, merged.bytes);
      await adoptRemoteAsBase();
      report.merged++;
      new Notice(
        merged.union && merged.conflict
          ? `Syncian: combined two versions of ${path} that had no shared history — where they differed both were kept, so check for duplicated lines.`
          : merged.conflict
            ? `Syncian: merged concurrent edits in ${path} — review the conflict markers (search “<<<<<<<”).`
            : `Syncian: auto-merged concurrent edits in ${path}.`
      );
      return true;
    }

    // Keep the local file (it will be pushed as the next version), park the
    // remote version in a conflict copy.
    const copy = normalizePath(conflictPath(path));
    await this.app.vault.createBinary(copy, plaintext);
    await adoptRemoteAsBase();
    report.conflicts++;
    new Notice(`Syncian: conflict on ${path} — saved a conflict copy.`);
    return true;
  }

  // Config files (.obsidian/…) applied through the adapter. When both sides
  // changed one: settings JSON is merged key by key (against a shadow base
  // when there is one); plugin and theme code takes the remote version, so a
  // plugin updated on two devices ends up as one consistent set of files;
  // anything else (a CSS snippet) keeps both in a conflict copy.
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
    if (!remoteBytes) throw new RetryLater(); // presign/fetch failed — already recorded in report.errors
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
        await this.saveConfigBase(change.file_id, path, plaintext);
        return;
      }
      const locallyModified = !entry || entry.localHash !== localHash || entry.path !== path;
      const merged = locallyModified && isJsonPath(path)
        ? await this.mergeConfigJson(change.file_id, entry, localBytes, plaintext)
        : null;
      if (merged) {
        await this.configStore.write(path, merged);
        this.updateEntry(change.file_id, {
          path, version: change.version,
          localHash: remotePlainHash, // remote is the new synced base…
          remoteHash: change.ciphertext_hash,
          mtime: 0, size: -1, // …force the push scan to re-hash and upload the merge
        });
        await this.saveConfigBase(change.file_id, path, plaintext);
        report.merged++;
        return;
      }
      if (locallyModified && !isBundledCodePath(path)) {
        const copy = normalizePath(conflictPath(path));
        await this.configStore.write(copy, plaintext);
        this.updateEntry(change.file_id, {
          path, version: change.version,
          localHash: remotePlainHash, // pretend remote is the synced base…
          remoteHash: change.ciphertext_hash,
          mtime: 0, size: -1, // …but force the push scan to re-hash and upload local
        });
        await this.saveConfigBase(change.file_id, path, plaintext);
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
    await this.saveConfigBase(change.file_id, path, plaintext);
    report.pulled++;
  }

  // Shadow base for settings JSON only — the one kind of config file that
  // gets merged.
  private async saveConfigBase(fileId: string, path: string, bytes: ArrayBuffer): Promise<void> {
    if (isJsonPath(path)) await this.base.write(fileId, bytes);
  }

  // Merged bytes, or null when either side isn't a JSON object.
  private async mergeConfigJson(
    fileId: string,
    entry: IndexEntry | undefined,
    localBytes: ArrayBuffer,
    remoteBytes: ArrayBuffer
  ): Promise<ArrayBuffer | null> {
    const local = tryDecodeUtf8(localBytes);
    const remote = tryDecodeUtf8(remoteBytes);
    if (local === null || remote === null) return null;
    // Only a base that is exactly what we last synced tells us who changed what.
    const baseBytes = entry ? await this.base.read(fileId) : null;
    const base = baseBytes && (await sha256Hex(baseBytes)) === entry?.localHash ? tryDecodeUtf8(baseBytes) : null;
    const merged = mergeJson(base, local, remote);
    return merged === null ? null : (new TextEncoder().encode(merged).buffer as ArrayBuffer);
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
    return { bytes: new TextEncoder().encode(text).buffer, conflict };
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
      await this.base.remove(change.file_id);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (file instanceof TFile) {
      const localHash = await sha256Hex(await this.app.vault.readBinary(file));
      if (localHash === entry.localHash) {
        // trashFile (not Vault.trash) respects the user's deletion preference.
        await this.app.fileManager.trashFile(file);
        this.noteOwnChange(entry.path, null);
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
    // Normally one entry per path. Vaults synced before the server enforced
    // that can hold two ids for one path; every device must then push to the
    // same one or they'd keep two diverging copies alive — so: not one that
    // lost its path, then the smaller id.
    const byPath = new Map<string, [string, IndexEntry]>();
    for (const [id, entry] of Object.entries(this.state.files)) {
      const current = byPath.get(entry.path);
      const better = !current
        || (!entry.pathLost && current[1].pathLost)
        || (!entry.pathLost === !current[1].pathLost && id < current[0]);
      if (better) byPath.set(entry.path, [id, entry]);
    }

    const excludes = this.cb.excludes();
    const localFiles = this.app.vault.getFiles().filter((f) => !isExcluded(f.path, excludes));
    const seen = new Set<string>(localFiles.map((f) => f.path));

    // Drop stale entries for files that no longer exist — otherwise a
    // renamed/deleted file's block never clears.
    for (const path of this.blocked.keys()) {
      if (!seen.has(path)) this.blocked.delete(path);
    }

    const run: PushRun = { report, jobs: [], bytes: 0, halted: false };
    let processed = 0;
    for (const file of localFiles) {
      if (run.halted) break;
      try {
        // Snapshot the stat BEFORE reading. Obsidian updates TFile.stat in
        // place, so reading it after the upload would pair a newer mtime with
        // the hash of the older bytes — and the scan would then skip a save
        // that landed mid-upload until the file changed yet again.
        const { mtime, size } = file.stat;
        const job = await this.prepareJob(file.path, false, mtime, size, byPath.get(file.path), () => this.app.vault.readBinary(file));
        if (job) await this.enqueue(run, job);
      } catch (e) {
        recordError(report, `push ${file.path}: ${e}`, file.path);
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
    await this.flush(run);

    // Over quota: bail before the deletion pass too. Deletes wouldn't fail on
    // quota, but the point of the halt is to stop touching the server until the
    // user has paid and explicitly re-synced.
    if (run.halted) return;

    // Anything indexed but no longer on disk was deleted locally. Excluded
    // paths are skipped — excluding a folder must not delete it remotely.
    //
    // Config entries live outside getFiles(), so they're never in `seen` —
    // without this guard the vault pass would delete every synced config
    // file on the server each cycle. Config deletions are handled by
    // pushConfig() against its own listing.
    //
    // Walks the index, not byPath: when two ids share a deleted path, both go.
    const vaultEntries = Object.entries(this.state.files)
      .filter(([, entry]) => !this.configStore.owns(entry.path) && !isExcluded(entry.path, excludes));
    const missing = vaultEntries.filter(([, entry]) => !seen.has(entry.path));
    if (!this.confirmedMassDelete && missing.length >= MASS_DELETE_MIN && missing.length * 3 > vaultEntries.length) {
      report.heldDeletions = missing.length;
      return;
    }
    await this.commitDeletes(missing, report);
  }

  // Decides what, if anything, one local file needs: nothing (unchanged, too
  // big, blocked), an upload, or — content untouched but moved — a rename.
  private async prepareJob(
    path: string,
    config: boolean,
    mtime: number,
    size: number,
    indexed: [string, IndexEntry] | undefined,
    read: () => Promise<ArrayBuffer>
  ): Promise<PushJob | null> {
    if (size > MAX_FILE_SIZE) return null;
    const block = this.blocked.get(path);
    if (block && block.size === size && block.mtime === mtime) return null;
    const [fileId, entry] = indexed ?? [crypto.randomUUID(), undefined];
    if (entry && entry.serverPath === undefined && entry.mtime === mtime && entry.size === size) return null;

    const bytes = await read();
    const localHash = await sha256Hex(bytes);
    const unchanged = entry !== undefined && entry.localHash === localHash;
    if (unchanged && entry.serverPath === undefined) {
      // mtime churn without content change; just refresh the index.
      this.updateEntry(fileId, { ...entry, mtime, size });
      return null;
    }
    // Unchanged with a serverPath: renamed, content untouched — moved on the
    // server by a commit with no blob, which keeps the one the file has.
    return { path, config, fileId, entry, mtime, size, localHash, bytes, rename: unchanged };
  }

  // Jobs are pushed a batch at a time rather than one file at a time, and a
  // batch is bounded by bytes as well as by count: everything in it is held
  // in memory (plaintext and ciphertext) until its commit, so this is what
  // keeps a vault full of attachments from exhausting a phone.
  private async enqueue(run: PushRun, job: PushJob): Promise<void> {
    run.jobs.push(job);
    if (!job.rename) run.bytes += job.bytes.byteLength;
    if (run.jobs.length >= this.batchSize() || run.bytes >= PUSH_BATCH_BYTES) await this.flush(run);
  }

  private batchSize(): number {
    return this.batchLimit > 0 ? this.batchLimit : UNBATCHED_GROUP;
  }

  private async flush(run: PushRun): Promise<void> {
    let jobs = run.jobs;
    run.jobs = [];
    run.bytes = 0;
    if (!jobs.length) return;
    while (jobs.length) jobs = await this.pushBatch(run, jobs);
    // Persist the index after every batch, not just at the end of the cycle.
    // A commit the server has but data.json doesn't is how the next edit to
    // that file used to turn into a conflict against our own push — and on
    // mobile the app is routinely killed mid-push.
    await this.cb.saveState();
  }

  // Encrypt -> presign -> upload -> commit for one batch. Each stage answers
  // per file, so a failure takes out only its own file. Returns jobs that
  // must go round again (see the rename fallback at the end).
  private async pushBatch(run: PushRun, jobs: PushJob[]): Promise<PushJob[]> {
    const staged: { job: PushJob; payload: CommitPayload }[] = [];

    const encoded: { job: PushJob; data: ArrayBuffer; hash: string }[] = [];
    for (const job of jobs) {
      if (job.rename) continue;
      try {
        const data = await this.codec.encodeContent(job.bytes);
        encoded.push({ job, data, hash: await sha256Hex(data) });
      } catch (e) {
        this.pushFailed(run, job, e);
      }
    }
    const presigned = encoded.length ? await this.presignMany(encoded.map((e) => e.data.byteLength)) : [];
    const ready: { job: PushJob; data: ArrayBuffer; hash: string; blob_key: string; put_url: string }[] = [];
    encoded.forEach((item, i) => {
      const p = presigned[i];
      if ("err" in p) this.pushFailed(run, item.job, p.err);
      else ready.push({ ...item, ...p.ok });
    });

    await pool(ready, PUSH_CONCURRENCY, async (item) => {
      try {
        await this.api.putBlob(item.put_url, item.data);
        staged.push({
          job: item.job,
          payload: {
            file_id: item.job.fileId,
            base_version: item.job.entry?.version ?? 0,
            encrypted_path: await this.codec.encodePath(item.job.path),
            path_token: await this.codec.pathToken(item.job.path),
            size: item.data.byteLength,
            ciphertext_hash: item.hash,
            blob_key: item.blob_key,
          },
        });
      } catch (e) {
        this.pushFailed(run, item.job, e);
      }
    });

    for (const job of jobs) {
      if (!job.rename) continue;
      staged.push({
        job,
        payload: {
          file_id: job.fileId,
          base_version: job.entry!.version,
          encrypted_path: await this.codec.encodePath(job.path),
          path_token: await this.codec.pathToken(job.path),
        },
      });
    }
    if (!staged.length) return [];

    const redo: PushJob[] = [];
    const results = await this.commitMany(staged.map((s) => s.payload));
    for (let i = 0; i < staged.length; i++) {
      const { job, payload } = staged[i];
      const result = results[i];
      if ("err" in result) {
        // A server from before in-place renames insists on a blob: upload the
        // file under its new path instead — still one file with one history,
        // just not free.
        if (job.rename && result.err instanceof ApiError && result.err.code === "missing_parameter") {
          redo.push({ ...job, rename: false });
        } else {
          this.pushFailed(run, job, result.err);
        }
        continue;
      }
      if (job.rename) {
        const { serverPath: _pushed, ...rest } = job.entry!;
        this.updateEntry(job.fileId, { ...rest, version: result.ok.version, mtime: job.mtime, size: job.size });
        run.report.renamed++;
        continue;
      }
      this.updateEntry(job.fileId, {
        path: job.path, version: result.ok.version,
        localHash: job.localHash, remoteHash: payload.ciphertext_hash ?? null,
        mtime: job.mtime, size: job.size,
      });
      if (job.config) await this.saveConfigBase(job.fileId, job.path, job.bytes);
      else await this.saveBase(job.fileId, job.path, job.bytes);
      run.report.pushed++;
    }
    return redo;
  }

  private pushFailed(run: PushRun, job: PushJob, e: unknown): void {
    const report = run.report;
    if (e instanceof ApiError && (e.code === "version_conflict" || e.code === "path_taken")) {
      // Another device won the race — to this file, or to a new file at
      // this path. The next cycle pulls theirs, merges, then re-pushes.
      report.deferred.push(job.path);
      if (e.code === "path_taken" && job.entry) this.yieldPath(job.path, job.fileId);
    } else if (e instanceof ApiError && e.code === "quota_exceeded") {
      // The vault is out of storage. Halt the whole push and flag it —
      // the plugin pauses auto-sync and asks the user to pay, rather than
      // re-hitting (and re-reporting) the same limit on every file, every
      // cycle. Deliberately NOT recorded in report.errors: it's a billing
      // state, not a bug, so it never goes to the error channel.
      run.halted = true;
      report.quotaBlocked = true;
    } else if (e instanceof ApiError && PERMANENT_ERROR_CODES.has(e.code)) {
      // Won't succeed again until the file or the plan changes — stop
      // retrying it every cycle.
      this.blocked.set(job.path, { size: job.size, mtime: job.mtime });
      recordError(report, `skipped (${e.code}): ${job.path} — will retry once the file changes or you upgrade`, job.path);
    } else {
      recordError(report, `push ${job.path}: ${e}`, job.path);
    }
  }

  // The two server calls of a push, each as "many in, one outcome per item
  // out". With the batch endpoints that's one request; against a server
  // without them it's the per-file calls, a few at a time.
  private async presignMany(sizes: number[]): Promise<Outcome<{ blob_key: string; put_url: string }>[]> {
    if (this.batchLimit > 0) {
      try {
        const { uploads } = await this.api.presignUploads(this.vaultId(), sizes);
        return sizes.map((_, i) => itemOutcome(uploads[i], (u) => u));
      } catch (e) {
        return sizes.map(() => ({ err: e }));
      }
    }
    const out: Outcome<{ blob_key: string; put_url: string }>[] = new Array(sizes.length);
    await pool(sizes.map((size, i) => ({ size, i })), PUSH_CONCURRENCY, async ({ size, i }) => {
      try {
        out[i] = { ok: await this.api.presignUpload(this.vaultId(), size) };
      } catch (e) {
        out[i] = { err: e };
      }
    });
    return out;
  }

  private async commitMany(payloads: CommitPayload[]): Promise<Outcome<ChangeRecord>[]> {
    let out: Outcome<ChangeRecord>[] = new Array(payloads.length);
    if (this.batchLimit > 0) {
      try {
        const { results } = await this.api.commitBatch(this.vaultId(), payloads);
        out = payloads.map((_, i) => itemOutcome(results[i], (r) => r.change));
      } catch (e) {
        out = payloads.map(() => ({ err: e }));
      }
    } else {
      await pool(payloads.map((payload, i) => ({ payload, i })), PUSH_CONCURRENCY, async ({ payload, i }) => {
        try {
          out[i] = { ok: await this.api.commit(this.vaultId(), payload) };
        } catch (e) {
          out[i] = { err: e };
        }
      });
    }
    for (const result of out) if ("ok" in result) this.ownRevisions.add(result.ok.revision);
    return out;
  }

  private async commitDeletes(entries: [string, IndexEntry][], report: SyncReport): Promise<void> {
    for (let at = 0; at < entries.length; at += this.batchSize()) {
      const chunk = entries.slice(at, at + this.batchSize());
      const payloads: CommitPayload[] = [];
      for (const [fileId, entry] of chunk) {
        payloads.push({
          file_id: fileId,
          base_version: entry.version,
          encrypted_path: await this.codec.encodePath(entry.path),
          deleted: true,
        });
      }
      const results = await this.commitMany(payloads);
      for (let i = 0; i < chunk.length; i++) {
        const [fileId, entry] = chunk[i];
        const result = results[i];
        if ("err" in result) {
          recordError(report, `delete ${entry.path}: ${result.err}`, entry.path);
          continue;
        }
        delete this.state.files[fileId];
        await this.base.remove(fileId);
        report.deletedRemote++;
      }
    }
  }

  // path_taken on a file we already track: if the path's other owner is in
  // our index as well, stand this entry down so the next cycle pushes to that
  // one. (If it isn't, the next pull brings it and the two get merged.)
  private yieldPath(path: string, fileId: string): void {
    const entry = this.state.files[fileId];
    if (!entry) return;
    const shared = Object.entries(this.state.files).some(([id, other]) => id !== fileId && other.path === path && !other.pathLost);
    if (shared) entry.pathLost = true;
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

    const run: PushRun = { report, jobs: [], bytes: 0, halted: false };
    for (const cf of files) {
      if (run.halted) break;
      try {
        const job = await this.prepareJob(cf.path, true, cf.mtime, cf.size, byPath.get(cf.path), () => this.configStore.read(cf.path));
        if (job) await this.enqueue(run, job);
      } catch (e) {
        recordError(report, `push ${cf.path}: ${e}`, cf.path);
      }
    }
    await this.flush(run);
    if (run.halted) return; // over quota — stop, same as push()

    // Config files indexed but no longer on disk were deleted locally.
    const missing = [...byPath.values()].filter(([, entry]) => !seen.has(entry.path));
    await this.commitDeletes(missing, report);
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
    this.noteOwnWrite(path);
  }

  private noteOwnWrite(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) this.noteOwnChange(path, file.stat.mtime);
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
