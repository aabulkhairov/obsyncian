import { App } from "obsidian";
import { FakeApp } from "./obsidian-mock";
import { FakeApi } from "./fake-api";
import { ApiClient } from "../src/api";
import { Codec, PlainCodec } from "../src/codec";
import { SyncEngine, emptySyncState } from "../src/sync";

export function makeClient(
  server: FakeApi,
  codec: Codec = new PlainCodec(),
  onStatus: (text: string) => void = () => {}
) {
  const excluded: string[] = [];
  const app = new FakeApp();
  const engine = new SyncEngine(
    app as unknown as App,
    server as unknown as ApiClient,
    async () => codec,
    () => "1",
    emptySyncState(),
    { onStatus, saveState: async () => {}, excludes: () => excluded }
  );
  return { app, vault: app.vault, engine, excluded };
}
