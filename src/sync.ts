import { App, Notice, TFile, Vault } from "obsidian";
import { ApiClient, ApiError, ChangeRecord } from "./api";
import { Codec } from "./codec";
import { conflictPath, dirname, sha256Hex } from "./util";

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
  errors: string[];
}

interface SyncCallbacks {
  onStatus(text: string): void;
  saveState(): Promise<void>;
  excludes(): string[]; // folder prefixes to skip, e.g. ["Private", "Attachments/Huge"]
}

export function isExcluded(path: string, excludes: string[]): boolean {
  return excludes.some((prefix) => {
    const clean = prefix.replace(/\/+$/, "");
    return clean !== "" && (path === clean || path.startsWith(clean + "/"));
  });
}

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const DOWNLOAD_BATCH = 100; // matches server MAX_BATCH in downloads_controller.rb
const DOWNLOAD_CONCURRENCY = 8;
const PUSH_CONCURRENCY = 6;
const PROGRESS_BAR_WIDTH = 10;

function progressText(prefix: string, current: number, total: number): string {
  if (total <= 0) return prefix;
  const pct = Math.min(100, Math.round((current / total) * 100));
  const filled = Math.round((PROGRESS_BAR_WIDTH * pct) / 100);
  const bar = "▰".repeat(filled) + "▱".repeat(PROGRESS_BAR_WIDTH - filled);
  return `${prefix} ${bar} ${current}/${total}`;
}

// One pull+push cycle over the whole vault. Deliberately boring: no partial
// merges, no CRDTs. Conflicts produce a "(conflict …)" copy and both versions
// survive. A local rename is pushed as delete+create (no history linkage).
export class SyncEngine {
  private running = false;
  private codec!: Codec;

  constructor(
    private app: App,
    private api: ApiClient,
    // Resolved at the start of every cycle: throws while the E2EE vault is
    // locked (no/wrong passphrase), which aborts the sync loudly.
    private codecProvider: () => Promise<Codec>,
    private vaultId: () => string,
    private state: SyncState,
    private cb: SyncCallbacks
  ) {}

  get busy(): boolean {
    return this.running;
  }

  async sync(): Promise<SyncReport | null> {
    if (this.running) return null;
    this.running = true;
    const report: SyncReport = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, errors: [] };
    try {
      this.codec = await this.codecProvider();
      this.cb.onStatus("pulling…");
      await this.pull(report);
      this.cb.onStatus("pushing…");
      await this.push(report);
      this.state.lastSyncAt = Date.now();
      await this.cb.saveState();
      const at = new Date().toTimeString().slice(0, 5);
      this.cb.onStatus(report.errors.length ? `errors (${report.errors.length})` : `synced ${at}`);
      return report;
    } catch (e) {
      report.errors.push(String(e));
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
    const need = changes.filter((c) => {
      if (c.deleted) return false;
      const entry = this.state.files[c.file_id];
      if (entry && entry.version >= c.version) return false;
      if (entry && entry.remoteHash === c.ciphertext_hash) return false;
      return true;
    });
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

    const path = await this.codec.decodePath(change.encrypted_path);
    if (isExcluded(path, this.cb.excludes())) return;

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
        return;
      }

      const locallyModified = !entry || entry.localHash !== localHash || entry.path !== path;
      if (locallyModified) {
        // Both sides changed: keep the local file (it will be pushed as the
        // next version), park the remote version in a conflict copy.
        const copy = conflictPath(path);
        await this.app.vault.createBinary(copy, plaintext);
        this.updateEntry(change.file_id, {
          path, version: change.version,
          localHash: remotePlainHash, // pretend remote is the synced base…
          remoteHash: change.ciphertext_hash,
          mtime: 0, size: -1, // …but force the push scan to re-hash and upload local
        });
        report.conflicts++;
        new Notice(`Obsyncian: conflict on ${path} — saved a conflict copy.`);
        return;
      }
    }

    await this.writeLocal(path, plaintext);
    const written = this.app.vault.getAbstractFileByPath(path) as TFile;
    this.updateEntry(change.file_id, {
      path, version: change.version,
      localHash: await sha256Hex(plaintext),
      remoteHash: change.ciphertext_hash,
      mtime: written.stat.mtime, size: written.stat.size,
    });
    report.pulled++;
  }

  private async applyRemoteDelete(change: ChangeRecord, entry: IndexEntry | undefined, report: SyncReport): Promise<void> {
    if (!entry) return;
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (file instanceof TFile) {
      const localHash = await sha256Hex(await this.app.vault.readBinary(file));
      if (localHash === entry.localHash) {
        await this.app.vault.trash(file, true);
        report.deletedLocal++;
      }
      // Locally modified since last sync: keep the file. Dropping the index
      // entry makes the push scan treat it as brand new (delete loses to edit).
    }
    delete this.state.files[change.file_id];
  }

  // ---- push ----------------------------------------------------------------

  private async push(report: SyncReport): Promise<void> {
    const byPath = new Map<string, [string, IndexEntry]>();
    for (const [id, entry] of Object.entries(this.state.files)) byPath.set(entry.path, [id, entry]);

    const excludes = this.cb.excludes();
    const localFiles = this.app.vault.getFiles().filter((f) => !isExcluded(f.path, excludes));
    const seen = new Set<string>(localFiles.map((f) => f.path));

    // Each pushFile does its own presign+PUT+commit round trip — the API has
    // no batch-upload endpoint (unlike downloads), but commits are already
    // serialized per vault server-side (CommitFileChange locks the vault
    // row), so running several files concurrently here is safe: their
    // presign+PUT phases genuinely overlap, only commit briefly queues.
    let processed = 0;
    let next = 0;
    const worker = async () => {
      while (next < localFiles.length) {
        const file = localFiles[next++];
        try {
          await this.pushFile(file, byPath.get(file.path), report);
        } catch (e) {
          if (e instanceof ApiError && e.code === "version_conflict") {
            // Another device won the race; next sync cycle pulls then re-pushes.
            report.errors.push(`deferred (conflict): ${file.path}`);
          } else {
            report.errors.push(`push ${file.path}: ${e}`);
          }
        }
        processed++;
        if (processed % 5 === 0 || processed === localFiles.length) {
          this.cb.onStatus(progressText("pushing", processed, localFiles.length));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, localFiles.length) }, worker));

    // Anything indexed but no longer on disk was deleted locally. Excluded
    // paths are skipped — excluding a folder must not delete it remotely.
    for (const [path, [fileId, entry]] of byPath) {
      if (seen.has(path) || isExcluded(path, excludes)) continue;
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

  private async pushFile(file: TFile, indexed: [string, IndexEntry] | undefined, report: SyncReport): Promise<void> {
    if (file.stat.size > MAX_FILE_SIZE) return;
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
      current = current ? `${current}/${part}` : part;
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
