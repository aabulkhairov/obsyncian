import { requestUrl } from "obsidian";

export interface VaultInfo {
  id: number;
  name: string;
  latest_revision: number;
  key_check: string | null;
  role?: "owner" | "shared";
  owner_identity?: string | null;
}

// Shared vaults are labeled with their owner so two people's "Notes"
// vaults stay distinguishable: `@alice — Notes`.
export function vaultLabel(v: VaultInfo): string {
  return v.role === "shared" && v.owner_identity ? `${v.owner_identity} — ${v.name}` : v.name;
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
}

export interface CommitPayload {
  file_id: string;
  base_version: number;
  encrypted_path: string;
  size?: number;
  ciphertext_hash?: string;
  blob_key?: string;
  deleted?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
// Blob PUT/GET carry actual file bytes (up to the 250 MB plan cap) — a short
// timeout would abort legitimate large transfers on a slow connection.
const BLOB_TIMEOUT_MS = 120_000;

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

  changes(vaultId: string, since: number): Promise<ChangesPage> {
    return this.req("GET", `/v1/vaults/${vaultId}/changes?since=${since}`);
  }

  presignUpload(vaultId: string, size: number): Promise<{ blob_key: string; put_url: string }> {
    return this.req("POST", `/v1/vaults/${vaultId}/uploads`, { size });
  }

  commit(vaultId: string, payload: CommitPayload): Promise<ChangeRecord & { latest_revision: number }> {
    return this.req("POST", `/v1/vaults/${vaultId}/commit`, payload);
  }

  presignDownloads(vaultId: string, fileIds: string[]): Promise<{ downloads: { file_id: string; get_url: string }[] }> {
    return this.req("POST", `/v1/vaults/${vaultId}/downloads`, { file_ids: fileIds });
  }

  reportError(payload: { message: string; context: string; plugin_version: string; platform: string }): Promise<void> {
    return this.req("POST", "/v1/errors", payload);
  }

  // Blob transfers go straight to R2, not through the API server. fetch (not
  // requestUrl) so large bodies stream properly; the bucket's CORS policy
  // allows Obsidian's origins.
  async putBlob(url: string, data: ArrayBuffer): Promise<void> {
    const res = await withTimeout(fetch(url, { method: "PUT", body: data }), BLOB_TIMEOUT_MS, "blob upload");
    if (!res.ok) throw new ApiError(res.status, "blob_put_failed", `Blob upload failed: HTTP ${res.status}`);
  }

  async getBlob(url: string): Promise<ArrayBuffer> {
    const res = await withTimeout(fetch(url), BLOB_TIMEOUT_MS, "blob download");
    if (!res.ok) throw new ApiError(res.status, "blob_get_failed", `Blob download failed: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  private async req<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const res = await withTimeout(
      requestUrl({
        url: this.baseUrl().replace(/\/+$/, "") + path,
        method,
        contentType: body === undefined ? undefined : "application/json",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: auth ? { Authorization: `Bearer ${this.token()}` } : {},
        throw: false,
      }),
      REQUEST_TIMEOUT_MS,
      `${method} ${path.split("?")[0]}`
    );
    if (res.status >= 400) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      try {
        const parsed = res.json as { error?: { code?: string; message?: string } } | undefined;
        const err = parsed?.error;
        if (err) {
          code = err.code ?? code;
          message = err.message ?? message;
        }
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, code, message);
    }
    try {
      return res.json as T;
    } catch {
      return undefined as T;
    }
  }
}
