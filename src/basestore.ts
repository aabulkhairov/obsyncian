import { DataAdapter } from "obsidian";

// Shadow copies of the last-synced plaintext, keyed by file_id — the "base"
// side of the 3-way merge. Lives in the plugin's own folder under .obsidian/
// so the push scan (vault.getFiles) can never pick it up. Everything here is
// best-effort: losing a base never breaks sync, it just means the next
// concurrent edit produces a conflict copy instead of an auto-merge.
export const MAX_BASE_BYTES = 2 * 1024 * 1024;

export interface BaseStore {
  read(fileId: string): Promise<ArrayBuffer | null>;
  write(fileId: string, data: ArrayBuffer): Promise<void>;
  remove(fileId: string): Promise<void>;
  list(): Promise<string[]>;
}

export class AdapterBaseStore implements BaseStore {
  constructor(private adapter: DataAdapter, private dir: string) {}

  private path(fileId: string): string {
    return `${this.dir}/${fileId}`;
  }

  async read(fileId: string): Promise<ArrayBuffer | null> {
    try {
      if (!(await this.adapter.exists(this.path(fileId)))) return null;
      return await this.adapter.readBinary(this.path(fileId));
    } catch (e) {
      console.warn("[obsync] base store read failed:", e);
      return null;
    }
  }

  async write(fileId: string, data: ArrayBuffer): Promise<void> {
    try {
      if (data.byteLength > MAX_BASE_BYTES) {
        // Oversized files aren't worth shadowing — drop any stale base so the
        // hash guard can't accidentally match an old version.
        await this.remove(fileId);
        return;
      }
      if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
      await this.adapter.writeBinary(this.path(fileId), data);
    } catch (e) {
      console.warn("[obsync] base store write failed:", e);
    }
  }

  async remove(fileId: string): Promise<void> {
    try {
      if (await this.adapter.exists(this.path(fileId))) await this.adapter.remove(this.path(fileId));
    } catch (e) {
      console.warn("[obsync] base store remove failed:", e);
    }
  }

  async list(): Promise<string[]> {
    try {
      if (!(await this.adapter.exists(this.dir))) return [];
      const listing = await this.adapter.list(this.dir);
      return listing.files.map((p) => p.slice(p.lastIndexOf("/") + 1));
    } catch (e) {
      console.warn("[obsync] base store list failed:", e);
      return [];
    }
  }
}
