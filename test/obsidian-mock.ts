// Minimal stand-in for the "obsidian" module so the sync engine can run under
// vitest. Only what SyncEngine touches is implemented.

export class TFile {
  constructor(
    public path: string,
    public stat: { mtime: number; size: number; ctime: number }
  ) {}
}

export class TFolder {
  constructor(public path: string) {}
}

export class Notice {
  constructor(public message?: string) {}
}

export const Platform = { isMobile: false };

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn;
}

// Real HTTP via fetch, shaped like Obsidian's requestUrl. Lets e2e tests run
// the real ApiClient against a live dev server; unit tests use FakeApi and
// never call this.
export async function requestUrl(opts: {
  url: string;
  method?: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
  throw?: boolean;
}): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(opts.url, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.contentType ? { "Content-Type": opts.contentType } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body,
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    get json() {
      return JSON.parse(text);
    },
  };
}

export class Vault {}
export class App {}
export class PluginSettingTab {}
export class Setting {}
export class Plugin {}

let clock = 1000;
function tick(): number {
  return (clock += 1);
}

interface Stored {
  bytes: Uint8Array;
  mtime: number;
}

// In-memory vault + fileManager pair, duck-typed to the App surface the
// engine uses. Cast to App at the call site.
export class FakeApp {
  vault: FakeVault;
  fileManager: { renameFile: (file: TFile, newPath: string) => Promise<void> };

  constructor() {
    this.vault = new FakeVault();
    this.fileManager = {
      renameFile: async (file: TFile, newPath: string) => this.vault._rename(file.path, newPath),
    };
  }
}

export class FakeVault {
  files = new Map<string, Stored>();
  folders = new Set<string>();
  private handles = new Map<string, TFile>();

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const stored = this.files.get(path);
    if (stored) {
      let handle = this.handles.get(path);
      if (!handle) {
        handle = new TFile(path, { mtime: stored.mtime, size: stored.bytes.byteLength, ctime: stored.mtime });
        this.handles.set(path, handle);
      }
      handle.stat = { mtime: stored.mtime, size: stored.bytes.byteLength, ctime: handle.stat.ctime };
      return handle;
    }
    if (this.folders.has(path)) return new TFolder(path);
    return null;
  }

  getFiles(): TFile[] {
    return [...this.files.keys()].map((p) => this.getAbstractFileByPath(p) as TFile);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const stored = this.files.get(file.path);
    if (!stored) throw new Error(`readBinary: no such file ${file.path}`);
    return stored.bytes.buffer.slice(stored.bytes.byteOffset, stored.bytes.byteOffset + stored.bytes.byteLength);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (this.files.has(path)) throw new Error(`createBinary: ${path} already exists`);
    this.files.set(path, { bytes: new Uint8Array(data.slice(0)), mtime: tick() });
    return this.getAbstractFileByPath(path) as TFile;
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    if (!this.files.has(file.path)) throw new Error(`modifyBinary: no such file ${file.path}`);
    this.files.set(file.path, { bytes: new Uint8Array(data.slice(0)), mtime: tick() });
  }

  async trash(file: TFile, _system: boolean): Promise<void> {
    this.files.delete(file.path);
    this.handles.delete(file.path);
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  on(): void {
    // events unused in tests
  }

  // --- test conveniences ---

  write(path: string, text: string): void {
    this.files.set(path, { bytes: new TextEncoder().encode(text), mtime: tick() });
  }

  read(path: string): string | null {
    const stored = this.files.get(path);
    return stored ? new TextDecoder().decode(stored.bytes) : null;
  }

  delete(path: string): void {
    this.files.delete(path);
    this.handles.delete(path);
  }

  _rename(from: string, to: string): void {
    const stored = this.files.get(from);
    if (!stored) throw new Error(`rename: no such file ${from}`);
    this.files.delete(from);
    this.handles.delete(from);
    this.files.set(to, { ...stored, mtime: tick() });
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, stored] of this.files) out[path] = new TextDecoder().decode(stored.bytes);
    return out;
  }
}
