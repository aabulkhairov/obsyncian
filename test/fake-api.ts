// In-memory reimplementation of the server's sync semantics (mirrors
// CommitFileChange + ChangesController on the Rails side) so two SyncEngines
// can be driven against a shared "server" without network or Rails.
import { ApiError, ChangeRecord, ChangesPage, CommitPayload } from "../src/api";

interface ServerEntry {
  file_id: string;
  encrypted_path: string;
  size: number;
  version: number;
  revision: number;
  ciphertext_hash: string | null;
  deleted: boolean;
  blob_key: string | null;
  path_token: string | null;
}

export class FakeApi {
  entries = new Map<string, ServerEntry>();
  blobs = new Map<string, ArrayBuffer>();
  latestRevision = 0;
  private blobCounter = 0;
  // Test hook: simulates the server's per-file plan-limit rejection.
  maxUploadSize: number | null = null;
  uploadAttempts = 0;
  // Test hook: simulates the vault owner being out of storage. When true, any
  // non-delete commit is rejected the way CommitFileChange does at quota.
  quotaExceeded = false;
  // Test hook: the account has no active plan. The server gates every sync
  // endpoint, so this rejects from the very first call of a cycle.
  paymentRequired = false;
  // Test hook: behave like a server from before in-place renames and path
  // tokens — every non-delete commit needs a blob, tokens are ignored.
  legacy = false;
  // Test hook: false while some device on the vault runs an older plugin.
  inPlaceRenames = true;

  // Requests by endpoint, so tests can count round trips.
  calls: Record<string, number> = {};
  private count(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }
  get requests(): number {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
  // Test hooks: page size for /changes, and the batch endpoints' limit.
  pageSize = Infinity;
  batchLimit = 20;

  async changes(_vaultId: string, since: number, opts: { fresh?: boolean; skipDeletedThrough?: number } = {}): Promise<ChangesPage> {
    this.count("changes");
    if (this.paymentRequired) {
      throw new ApiError(402, "payment_required", "Syncing needs an active plan.");
    }
    const skip = this.legacy ? undefined
      : opts.skipDeletedThrough ?? (opts.fresh && since === 0 ? this.latestRevision : undefined);
    const all = [...this.entries.values()]
      .filter((e) => e.revision > since && (skip === undefined || !e.deleted || e.revision > skip))
      .sort((a, b) => a.revision - b.revision)
      .map((e) => ({ ...e }) as ChangeRecord);
    const changes = all.slice(0, this.pageSize);
    const page: ChangesPage = { latest_revision: this.latestRevision, changes, has_more: all.length > changes.length };
    if (this.legacy) return page;
    return { ...page, min_protocol: this.inPlaceRenames ? 2 : 1, batch_limit: this.batchLimit, skip_deleted_through: skip };
  }

  async presignUploads(vaultId: string, sizes: number[]) {
    this.count("presignUploads");
    if (this.legacy) throw new ApiError(404, "http_error", "HTTP 404");
    const uploads = [];
    for (const size of sizes.slice(0, this.batchLimit)) {
      try {
        uploads.push(await this.presignOne(vaultId, size));
      } catch (e) {
        uploads.push({ error: { code: (e as ApiError).code, message: (e as ApiError).message } });
      }
    }
    return { uploads };
  }

  async commitBatch(vaultId: string, commits: CommitPayload[]) {
    this.count("commitBatch");
    if (this.legacy) throw new ApiError(404, "http_error", "HTTP 404");
    const results = [];
    for (const payload of commits.slice(0, this.batchLimit)) {
      try {
        const { latest_revision: _latest, ...change } = await this.commitOne(vaultId, payload);
        results.push({ change });
      } catch (e) {
        results.push({ error: { code: (e as ApiError).code, message: (e as ApiError).message } });
      }
    }
    return { results, latest_revision: this.latestRevision };
  }

  async presignUpload(vaultId: string, size: number): Promise<{ blob_key: string; put_url: string }> {
    this.count("presignUpload");
    return this.presignOne(vaultId, size);
  }

  private async presignOne(_vaultId: string, size: number): Promise<{ blob_key: string; put_url: string }> {
    this.uploadAttempts++;
    if (this.maxUploadSize !== null && size > this.maxUploadSize) {
      throw new ApiError(422, "file_too_large", "File exceeds the limit of the vault owner's plan.");
    }
    const key = `blob-${++this.blobCounter}`;
    return { blob_key: key, put_url: key };
  }

  // Test hook: called for each blob as it is uploaded.
  onPut: ((url: string, data: ArrayBuffer) => void) | null = null;

  async putBlob(url: string, data: ArrayBuffer): Promise<void> {
    this.onPut?.(url, data);
    this.blobs.set(url, data.slice(0));
  }

  blobDownloads = 0;

  async getBlob(url: string): Promise<ArrayBuffer> {
    this.blobDownloads++;
    const blob = this.blobs.get(url);
    if (!blob) throw new ApiError(404, "blob_get_failed", `no blob at ${url}`);
    return blob.slice(0);
  }

  async commit(vaultId: string, payload: CommitPayload): Promise<ChangeRecord & { latest_revision: number }> {
    this.count("commit");
    return this.commitOne(vaultId, payload);
  }

  private async commitOne(_vaultId: string, payload: CommitPayload): Promise<ChangeRecord & { latest_revision: number }> {
    if (this.quotaExceeded && !payload.deleted) {
      throw new ApiError(403, "quota_exceeded", "Storage quota exceeded.");
    }
    const existing = this.entries.get(payload.file_id);
    const currentVersion = existing?.version ?? 0;
    if (payload.base_version !== currentVersion) {
      throw new ApiError(409, "version_conflict", "Base version is stale; pull changes first.");
    }
    const rename = !payload.deleted && !payload.blob_key;
    if (rename && this.legacy) {
      throw new ApiError(400, "missing_parameter", "param is missing or the value is empty: blob_key");
    }
    if (rename && (!existing || existing.deleted || !existing.blob_key)) {
      throw new ApiError(422, "invalid_blob", "Uploaded file not found; upload it again.");
    }
    const token = this.legacy ? null : (payload.path_token ?? existing?.path_token ?? null);
    if (!payload.deleted && token) {
      for (const other of this.entries.values()) {
        if (other.file_id !== payload.file_id && !other.deleted && other.path_token === token) {
          throw new ApiError(409, "path_taken", "Another file already exists at this path; pull changes first.");
        }
      }
    }
    const entry: ServerEntry = {
      file_id: payload.file_id,
      encrypted_path: payload.encrypted_path,
      path_token: token,
      size: payload.deleted ? 0 : rename ? existing!.size : (payload.size ?? 0),
      version: currentVersion + 1,
      revision: ++this.latestRevision,
      ciphertext_hash: payload.deleted ? null : rename ? existing!.ciphertext_hash : (payload.ciphertext_hash ?? null),
      blob_key: payload.deleted ? null : rename ? existing!.blob_key : (payload.blob_key ?? null),
      deleted: payload.deleted ?? false,
    };
    this.entries.set(payload.file_id, entry);
    return { ...entry, latest_revision: this.latestRevision };
  }

  async presignDownloads(_vaultId: string, fileIds: string[]): Promise<{ downloads: { file_id: string; get_url: string }[] }> {
    this.count("presignDownloads");
    const downloads = [];
    for (const id of fileIds) {
      const entry = this.entries.get(id);
      if (entry && !entry.deleted && entry.blob_key) {
        downloads.push({ file_id: id, get_url: entry.blob_key });
      }
    }
    return { downloads };
  }
}
