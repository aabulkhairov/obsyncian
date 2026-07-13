import { App } from "obsidian";
import { FakeApp } from "./obsidian-mock";
import { FakeApi } from "./fake-api";
import { ApiClient } from "../src/api";
import { BaseStore } from "../src/basestore";
import { ConfigFile, ConfigStore } from "../src/configstore";
import { Codec, PlainCodec } from "../src/codec";
import { SyncEngine, emptySyncState, type ConflictMode } from "../src/sync";

export class MemoryBaseStore implements BaseStore {
  map = new Map<string, ArrayBuffer>();
  async read(fileId: string): Promise<ArrayBuffer | null> {
    return this.map.get(fileId) ?? null;
  }
  async write(fileId: string, data: ArrayBuffer): Promise<void> {
    this.map.set(fileId, data);
  }
  async remove(fileId: string): Promise<void> {
    this.map.delete(fileId);
  }
  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

export class MemoryConfigStore implements ConfigStore {
  map = new Map<string, { data: ArrayBuffer; mtime: number; size: number }>();
  private tick = 1;
  constructor(private root = ".obsidian", private excludes: string[] = []) {}

  owns(path: string): boolean {
    if (path !== this.root && !path.startsWith(this.root + "/")) return false;
    return !this.excludes.some((e) => path === e || path.startsWith(e + "/"));
  }
  async list(): Promise<ConfigFile[]> {
    return [...this.map.entries()]
      .filter(([p]) => this.owns(p))
      .map(([path, v]) => ({ path, mtime: v.mtime, size: v.size }));
  }
  async read(path: string): Promise<ArrayBuffer> {
    const v = this.map.get(path);
    if (!v) throw new Error(`no such config file ${path}`);
    return v.data;
  }
  async write(path: string, data: ArrayBuffer): Promise<void> {
    this.map.set(path, { data, mtime: this.tick++, size: data.byteLength });
  }
  async remove(path: string): Promise<void> {
    this.map.delete(path);
  }
  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const v = this.map.get(path);
    return v ? { mtime: v.mtime, size: v.size } : null;
  }
  // Test conveniences.
  put(path: string, text: string): void {
    void this.write(path, new TextEncoder().encode(text).buffer as ArrayBuffer);
  }
  readText(path: string): string | null {
    const v = this.map.get(path);
    return v ? new TextDecoder().decode(v.data) : null;
  }
}

export function makeClient(
  server: FakeApi,
  codec: Codec = new PlainCodec(),
  onStatus: (text: string) => void = () => {}
) {
  const excluded: string[] = [];
  const app = new FakeApp();
  const base = new MemoryBaseStore();
  const config = new MemoryConfigStore(".obsidian", [
    ".obsidian/plugins/obsyncian",
    ".obsidian/workspace.json",
  ]);
  const flags = { syncConfig: false, conflictMode: "merge" as ConflictMode };
  const engine = new SyncEngine(
    app as unknown as App,
    server as unknown as ApiClient,
    async () => codec,
    () => "1",
    emptySyncState(),
    base,
    config,
    {
      onStatus,
      saveState: async () => {},
      excludes: () => excluded,
      syncConfig: () => flags.syncConfig,
      conflictMode: () => flags.conflictMode,
    }
  );
  return { app, vault: app.vault, engine, excluded, base, config, flags };
}
