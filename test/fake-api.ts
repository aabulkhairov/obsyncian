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
}

export class FakeApi {
  entries = new Map<string, ServerEntry>();
  blobs = new Map<string, ArrayBuffer>();
  latestRevision = 0;
  private blobCounter = 0;
  // Test hook: simulates the server's per-file plan-limit rejection.
  maxUploadSize: number | null = null;
  uploadAttempts = 0;

  async changes(_vaultId: string, since: number): Promise<ChangesPage> {
    const changes = [...this.entries.values()]
      .filter((e) => e.revision > since)
      .sort((a, b) => a.revision - b.revision)
      .map((e) => ({ ...e }) as ChangeRecord);
    return { latest_revision: this.latestRevision, changes, has_more: false };
  }

  async presignUpload(_vaultId: string, size: number): Promise<{ blob_key: string; put_url: string }> {
    this.uploadAttempts++;
    if (this.maxUploadSize !== null && size > this.maxUploadSize) {
      throw new ApiError(422, "file_too_large", "File exceeds the limit of the vault owner's plan.");
    }
    const key = `blob-${++this.blobCounter}`;
    return { blob_key: key, put_url: key };
  }

  async putBlob(url: string, data: ArrayBuffer): Promise<void> {
    this.blobs.set(url, data.slice(0));
  }

  blobDownloads = 0;

  async getBlob(url: string): Promise<ArrayBuffer> {
    this.blobDownloads++;
    const blob = this.blobs.get(url);
    if (!blob) throw new ApiError(404, "blob_get_failed", `no blob at ${url}`);
    return blob.slice(0);
  }

  async commit(_vaultId: string, payload: CommitPayload): Promise<ChangeRecord & { latest_revision: number }> {
    const existing = this.entries.get(payload.file_id);
    const currentVersion = existing?.version ?? 0;
    if (payload.base_version !== currentVersion) {
      throw new ApiError(409, "version_conflict", "Base version is stale; pull changes first.");
    }
    const entry: ServerEntry = {
      file_id: payload.file_id,
      encrypted_path: payload.encrypted_path,
      size: payload.deleted ? 0 : (payload.size ?? 0),
      version: currentVersion + 1,
      revision: ++this.latestRevision,
      ciphertext_hash: payload.deleted ? null : (payload.ciphertext_hash ?? null),
      blob_key: payload.deleted ? null : (payload.blob_key ?? null),
      deleted: payload.deleted ?? false,
    };
    this.entries.set(payload.file_id, entry);
    return { ...entry, latest_revision: this.latestRevision };
  }

  async presignDownloads(_vaultId: string, fileIds: string[]): Promise<{ downloads: { file_id: string; get_url: string }[] }> {
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
