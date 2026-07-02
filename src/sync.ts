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
    for (;;) {
      const page = await this.api.changes(this.vaultId(), this.state.cursor);
      for (const change of page.changes) {
        try {
          await this.applyRemoteChange(change, report);
        } catch (e) {
          report.errors.push(`pull ${change.file_id}: ${e}`);
        }
        this.state.cursor = Math.max(this.state.cursor, change.revision);
      }
      await this.cb.saveState();
      if (!page.has_more) {
        this.state.cursor = Math.max(this.state.cursor, page.latest_revision);
        break;
      }
    }
  }

  private async applyRemoteChange(change: ChangeRecord, report: SyncReport): Promise<void> {
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

    const remoteBytes = await this.download(change);
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
        new Notice(`Obsync: conflict on ${path} — saved a conflict copy.`);
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

  private async download(change: ChangeRecord): Promise<ArrayBuffer> {
    const { downloads } = await this.api.presignDownloads(this.vaultId(), [change.file_id]);
    if (!downloads.length) throw new Error("no download URL returned");
    return this.api.getBlob(downloads[0].get_url);
  }

  // ---- push ----------------------------------------------------------------

  private async push(report: SyncReport): Promise<void> {
    const byPath = new Map<string, [string, IndexEntry]>();
    for (const [id, entry] of Object.entries(this.state.files)) byPath.set(entry.path, [id, entry]);

    const excludes = this.cb.excludes();
    const localFiles = this.app.vault.getFiles().filter((f) => !isExcluded(f.path, excludes));
    const seen = new Set<string>();

    for (const file of localFiles) {
      seen.add(file.path);
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
    }

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
