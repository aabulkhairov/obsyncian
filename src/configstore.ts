import { DataAdapter, normalizePath } from "obsidian";

export interface ConfigFile {
  path: string; // vault-relative, e.g. ".obsidian/plugins/calendar/main.js"
  mtime: number;
  size: number;
}

// The config track syncs the vault's hidden `.obsidian/` folder (plugins,
// themes, snippets, settings) — files that Vault.getFiles() never returns and
// vault.createBinary() can't write. It goes straight through the DataAdapter,
// the same low-level surface AdapterBaseStore already uses.
export interface ConfigStore {
  // Is this path part of the config folder AND not on the exclude list? The
  // sync engine calls this to route reads/writes/deletes for incoming changes.
  owns(path: string): boolean;
  list(): Promise<ConfigFile[]>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
}

export class AdapterConfigStore implements ConfigStore {
  private readonly root: string;
  private readonly excludes: string[];

  constructor(
    private adapter: DataAdapter,
    configDir: string,
    // Absolute vault-relative prefixes to never sync: the plugin's own folder
    // (its data.json holds this device's apiToken/passphrase, and each device
    // has a distinct token), and the device-specific workspace layout files.
    excludes: string[]
  ) {
    this.root = normalizePath(configDir);
    this.excludes = excludes.map((p) => normalizePath(p));
  }

  owns(path: string): boolean {
    const p = normalizePath(path);
    if (p !== this.root && !p.startsWith(this.root + "/")) return false;
    return !this.isExcluded(p);
  }

  private isExcluded(p: string): boolean {
    return this.excludes.some((ex) => p === ex || p.startsWith(ex + "/"));
  }

  async list(): Promise<ConfigFile[]> {
    const out: ConfigFile[] = [];
    await this.walk(this.root, out);
    return out;
  }

  private async walk(dir: string, out: ConfigFile[]): Promise<void> {
    if (!(await this.adapter.exists(dir))) return;
    const listing = await this.adapter.list(dir);
    for (const file of listing.files) {
      if (this.isExcluded(file)) continue;
      const st = await this.adapter.stat(file);
      if (st) out.push({ path: file, mtime: st.mtime, size: st.size });
    }
    for (const sub of listing.folders) {
      if (this.isExcluded(sub)) continue;
      await this.walk(sub, out);
    }
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(path);
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    const p = normalizePath(path);
    await this.ensureParent(p);
    await this.adapter.writeBinary(p, data);
  }

  // Build every missing directory in the path, top-down. writeBinary throws
  // ("File name cannot contain …") if any parent is missing, and adapter.mkdir
  // isn't reliably recursive — so create one level at a time, like the vault's
  // ensureFolder. e.g. writing ".obsidian/plugins/dataview/main.js" creates
  // ".obsidian/plugins/dataview" (its ancestors already exist).
  private async ensureParent(path: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!dir) return;
    const parts = dir.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) {
        try {
          await this.adapter.mkdir(current);
        } catch {
          // raced with another create; fine
        }
      }
    }
  }

  async remove(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const st = await this.adapter.stat(path);
    return st ? { mtime: st.mtime, size: st.size } : null;
  }
}
