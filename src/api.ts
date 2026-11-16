import { requestUrl } from "obsidian";

export interface VaultInfo {
  id: number;
  name: string;
  latest_revision: number;
  key_check: string | null;
  role?: "owner" | "shared";
  owner_identity?: string | null;
  // Being copied into an encrypted vault right now (frozen for writes).
  encrypting?: boolean;
}

// Shared vaults are labeled with their owner so two people's "Notes"
// vaults stay distinguishable: `@alice — Notes`.
export function vaultLabel(v: VaultInfo): string {
  return v.role === "shared" && v.owner_identity ? `${v.owner_identity} — ${v.name}` : v.name;
}

// The server never rejects a duplicate name (createVault just makes another
// row) — this is how the client warns before adding to the mess. Matches
// case/whitespace-insensitively since that's how a person actually compares
// two vault names.
export function findVaultByName(vaults: VaultInfo[], name: string): VaultInfo | undefined {
  const target = name.trim().toLowerCase();
  return vaults.find((v) => v.name.trim().toLowerCase() === target);
}

export interface ChangeRecord {
  file_id: string;
  encrypted_path: string;
  size: number;
  version: number;
  revision: number;
  ciphertext_hash: string | null;
  deleted: boolean;
}

export interface ChangesPage {
  latest_revision: number;
  changes: ChangeRecord[];
  has_more: boolean;
  // Everything below is absent on servers that predate it.
  // The oldest sync protocol among the devices syncing this vault — anything
  // an older plugin would mishandle is held back until it reaches ours.
  min_protocol?: number;
  // The server has the batch endpoints, taking up to this many items each.
  batch_limit?: number;
  // Echo on the following pages of a first-ever pull — see ApiClient.changes.
  skip_deleted_through?: number;
}

export interface CommitPayload {
  file_id: string;
  base_version: number;
  encrypted_path: string;
  path_token?: string;
  size?: number;
  ciphertext_hash?: string;
  blob_key?: string;
  deleted?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    // The whole parsed error response, for codes that carry more than a
    // message (vault_replaced names the vault that replaced this one).
    public body?: unknown
  ) {
    super(message);
  }
}

// Announced on every authenticated request so the server knows what this
// plugin can receive. 2: handles a change that moves a file and alters its
// content at once — what makes in-place renames safe to send to it.
export const SYNC_PROTOCOL = "2";

const REQUEST_TIMEOUT_MS = 10_000;
// A batch is up to batch_limit files' worth of work for the server (it checks
// each upload against storage), so it gets longer than a single call.
const BATCH_TIMEOUT_MS = 60_000;
// Blob PUT/GET carry actual file bytes (up to the 250 MB plan cap), so the
// allowance grows with the size: this much flat, plus time to move the bytes
// at a slow mobile uplink. A flat cap either cuts off big files on a slow
// connection — which then restart from zero every cycle, forever — or lets a
// dead transfer of a small one hang for minutes.
const BLOB_TIMEOUT_MS = 120_000;
const BLOB_MIN_BYTES_PER_SEC = 32 * 1024;

function blobTimeout(bytes: number): number {
  return BLOB_TIMEOUT_MS + Math.ceil(bytes / BLOB_MIN_BYTES_PER_SEC) * 1000;
}

export type BatchItemError = { error: { code: string; message: string } };

export function withTimeout<T>(promise: Promise<T>, ms: number, label = ""): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      // Naming the request is what makes remote timeout reports actionable:
      // "sync failed after 10s" alone can't distinguish a dead network from
      // one endpoint being strangled by a local proxy/antivirus.
      () => reject(new ApiError(0, "timeout", `No response after ${ms / 1000}s${label ? ` (${label})` : ""} — is the server reachable?`)),
      ms
    );
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v); },
      (e: unknown) => { window.clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); }
    );
  });
}

export class ApiClient {
  constructor(
    private baseUrl: () => string,
    private token: () => string
  ) {}

  config(): Promise<{ telegram_bot: string | null; telegram_login: boolean }> {
    return this.req("GET", "/v1/config", undefined, false);
  }

  requestCode(email: string): Promise<void> {
    return this.req("POST", "/v1/auth/request_code", { email }, false);
  }

  verify(email: string, code: string, deviceName: string): Promise<{ token: string; email: string; identity: string }> {
    return this.req("POST", "/v1/auth/verify", { email, code, device_name: deviceName }, false);
  }

  verifyTelegram(code: string, deviceName: string): Promise<{ token: string; email: string | null; identity: string }> {
    return this.req("POST", "/v1/auth/telegram/verify", { code, device_name: deviceName }, false);
  }

  me(): Promise<{ email: string; storage_used: number; storage_limit: number }> {
    return this.req("GET", "/v1/me");
  }

  listVaults(): Promise<{ vaults: VaultInfo[] }> {
    return this.req("GET", "/v1/vaults");
  }

  createVault(name: string, keyCheck?: string): Promise<VaultInfo> {
    return this.req("POST", "/v1/vaults", { name, key_check: keyCheck });
  }

  // `fresh`: this device has nothing yet, so the server may leave out files
  // that were already deleted before it arrived; it answers with
  // skip_deleted_through, to be passed back for the rest of that pull.
  changes(vaultId: string, since: number, opts: { fresh?: boolean; skipDeletedThrough?: number } = {}): Promise<ChangesPage> {
    const extra =
      opts.skipDeletedThrough !== undefined ? `&skip_deleted_through=${opts.skipDeletedThrough}`
        : opts.fresh ? "&fresh=1"
        : "";
    return this.req("GET", `/v1/vaults/${vaultId}/changes?since=${since}${extra}`);
  }

  // Encrypting a vault or changing its passphrase (see encrypt.ts): start
  // returns the empty encrypted vault to copy into; finish switches over to
  // it and deletes the source; cancel deletes the copy instead.
  startEncryption(vaultId: string, keyCheck: string): Promise<{ vault: VaultInfo }> {
    return this.req("POST", `/v1/vaults/${vaultId}/encryption`, { key_check: keyCheck });
  }

  finishEncryption(vaultId: string): Promise<{ vault: VaultInfo }> {
    return this.req("POST", `/v1/vaults/${vaultId}/encryption/finish`, {}, true, BATCH_TIMEOUT_MS);
  }

  cancelEncryption(vaultId: string): Promise<void> {
    return this.req("DELETE", `/v1/vaults/${vaultId}/encryption`);
  }

  presignUpload(vaultId: string, size: number): Promise<{ blob_key: string; put_url: string }> {
    return this.req("POST", `/v1/vaults/${vaultId}/uploads`, { size });
  }

  commit(vaultId: string, payload: CommitPayload): Promise<ChangeRecord & { latest_revision: number }> {
    return this.req("POST", `/v1/vaults/${vaultId}/commit`, payload);
  }

  // Batch forms of the two calls above: one answer per item, in order, each
  // either the result or its own error.
  presignUploads(vaultId: string, sizes: number[]): Promise<{ uploads: ({ blob_key: string; put_url: string } | BatchItemError)[] }> {
    return this.req("POST", `/v1/vaults/${vaultId}/uploads/batch`, { sizes }, true, BATCH_TIMEOUT_MS);
  }

  commitBatch(vaultId: string, commits: CommitPayload[]): Promise<{ results: ({ change: ChangeRecord } | BatchItemError)[]; latest_revision: number }> {
    return this.req("POST", `/v1/vaults/${vaultId}/commits`, { commits }, true, BATCH_TIMEOUT_MS);
  }

  presignDownloads(vaultId: string, fileIds: string[]): Promise<{ downloads: { file_id: string; get_url: string }[] }> {
    return this.req("POST", `/v1/vaults/${vaultId}/downloads`, { file_ids: fileIds });
  }

  reportError(payload: { message: string; context: string; plugin_version: string; platform: string }): Promise<void> {
    return this.req("POST", "/v1/errors", payload);
  }

  // Blob transfers go straight to R2, not through the API server. requestUrl,
  // as Obsidian's review asks, can't be cancelled: a timed-out transfer is
  // abandoned rather than aborted. Each upload gets a fresh presigned key, so
  // a straggler can't overwrite a newer one — it only costs bandwidth.
  async putBlob(url: string, data: ArrayBuffer): Promise<void> {
    const res = await withTimeout(
      requestUrl({ url, method: "PUT", contentType: "application/octet-stream", body: data, throw: false }),
      blobTimeout(data.byteLength), "blob upload"
    );
    if (res.status >= 400) throw new ApiError(res.status, "blob_put_failed", `Blob upload failed: HTTP ${res.status}`);
  }

  // `size` (the change's recorded size) only scales the timeout.
  async getBlob(url: string, size = 0): Promise<ArrayBuffer> {
    const res = await withTimeout(requestUrl({ url, throw: false }), blobTimeout(size), "blob download");
    if (res.status >= 400) throw new ApiError(res.status, "blob_get_failed", `Blob download failed: HTTP ${res.status}`);
    return res.arrayBuffer;
  }

  private async req<T>(method: string, path: string, body?: unknown, auth = true, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const res = await withTimeout(
      requestUrl({
        url: this.baseUrl().replace(/\/+$/, "") + path,
        method,
        contentType: body === undefined ? undefined : "application/json",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: auth ? { Authorization: `Bearer ${this.token()}`, "X-Obsyncian-Protocol": SYNC_PROTOCOL } : {},
        throw: false,
      }),
      timeoutMs,
      `${method} ${path.split("?")[0]}`
    );
    if (res.status >= 400) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      let parsed: { error?: { code?: string; message?: string } } | undefined;
      try {
        parsed = res.json as typeof parsed;
        const err = parsed?.error;
        if (err) {
          code = err.code ?? code;
          message = err.message ?? message;
        }
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, code, message, parsed);
    }
    try {
      return res.json as T;
    } catch {
      return undefined as T;
    }
  }
}
