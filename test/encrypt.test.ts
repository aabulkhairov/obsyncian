import { describe, expect, it } from "vitest";
import "./obsidian-mock";
import { FakeApi } from "./fake-api";
import { makeClient } from "./helpers";
import { ApiClient, ApiError } from "../src/api";
import { Codec, PlainCodec } from "../src/codec";
import { CryptoCodec, makeKeyCheck, unlock } from "../src/crypto";
import { VaultEncryption } from "../src/encrypt";
import { DEFAULT_SETTINGS, ObsyncSettings, passphraseProblem } from "../src/settings";
import type { App } from "obsidian";

const PASS = "correct horse battery staple";

// A device as the plugin wires it: settings decide which vault and codec the
// engine uses, and VaultEncryption drives the whole operation.
async function device(server: FakeApi, opts: { passphrase?: string; keyCheck?: string; vaultId?: string } = {}) {
  const settings: ObsyncSettings = {
    ...DEFAULT_SETTINGS, apiToken: "t", vaultId: opts.vaultId ?? "1",
    vaultKeyCheck: opts.keyCheck ?? "", passphrase: opts.passphrase ?? "",
  };
  let codec: Codec | null = null;
  const resolveCodec = async (): Promise<Codec> => {
    if (codec) return codec;
    codec = settings.vaultKeyCheck ? new CryptoCodec(await unlock(settings.passphrase, settings.vaultKeyCheck)) : new PlainCodec();
    return codec;
  };
  const live: Codec = {
    encodePath: async (p) => (await resolveCodec()).encodePath(p),
    decodePath: async (p) => (await resolveCodec()).decodePath(p),
    encodeContent: async (d) => (await resolveCodec()).encodeContent(d),
    decodeContent: async (d) => (await resolveCodec()).decodeContent(d),
    pathToken: async (p) => (await resolveCodec()).pathToken(p),
  };
  const client = makeClient(server, live);
  Object.defineProperty(client.vaultRef, "id", { get: () => settings.vaultId });
  const notices: string[] = [];
  let syncs = 0;
  const encryption = new VaultEncryption({
    app: client.app as unknown as App,
    api: server as unknown as ApiClient,
    engine: client.engine,
    configStore: client.config,
    settings: () => settings,
    syncState: () => client.state,
    resolveCodec,
    invalidateCodec: () => { codec = null; },
    save: async () => {},
    status: () => {},
    notice: (text) => notices.push(text),
    reportError: () => {},
    changed: () => {},
    syncAfter: () => { syncs++; },
  });
  // What main.syncNow does with the report.
  const sync = async () => {
    if (settings.encryption || settings.needsPassphrase) return null;
    const report = await client.engine.sync();
    if (report?.vaultReplaced) await encryption.follow(report.vaultReplaced);
    return report;
  };
  return { ...client, settings, encryption, notices, sync, syncs: () => syncs };
}

// What's really stored in a vault on the server, decrypted with `codec`.
async function contents(server: FakeApi, vaultId: string, codec: Codec): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of server.store(vaultId).entries.values()) {
    if (entry.deleted) continue;
    const path = await codec.decodePath(entry.encrypted_path);
    out[path] = new TextDecoder().decode(await codec.decodeContent(server.blobs.get(entry.blob_key!)!));
  }
  return out;
}

async function twoDevices() {
  const server = new FakeApi();
  const a = await device(server);
  const b = await device(server);
  a.vault.write("Notes/one.md", "first note\n");
  a.vault.write("Notes/two.md", "second note\n");
  a.vault.write("img.png", "\u0000pixels");
  await a.sync();
  // Only B has these: a folder A excludes, and B's settings file.
  b.flags.syncConfig = true;
  b.vault.write("Private/diary.md", "only on B\n");
  b.config.put(".obsidian/appearance.json", '{"theme":"dark"}');
  await b.sync();
  a.excluded.push("Private");
  await a.sync();
  return { server, a, b };
}

describe("encrypting a vault", () => {
  it("copies every file in the vault — including ones this device doesn't have — encrypted, then deletes the plain copy", async () => {
    const { server, a } = await twoDevices();
    const plainBlobs = [...server.store("1").entries.values()].map((e) => e.blob_key!);

    await a.encryption.encrypt(PASS);

    expect(a.settings.encryption).toBeNull();
    expect(a.notices.at(-1)).toContain("is now end-to-end encrypted");
    const target = a.settings.vaultId;
    expect(target).not.toBe("1");
    expect(a.settings.vaultKeyCheck).not.toBe("");
    expect(server.vaults.has("1")).toBe(false);
    for (const key of plainBlobs) expect(server.blobs.has(key)).toBe(false);

    const key = await unlock(PASS, a.settings.vaultKeyCheck);
    expect(await contents(server, target, new CryptoCodec(key))).toEqual({
      "Notes/one.md": "first note\n",
      "Notes/two.md": "second note\n",
      "img.png": "\u0000pixels",
      "Private/diary.md": "only on B\n",
      ".obsidian/appearance.json": '{"theme":"dark"}',
    });
    // Nothing readable is left on the server: neither names nor contents.
    for (const entry of server.store(target).entries.values()) {
      expect(entry.encrypted_path).not.toContain(".md");
      expect(new TextDecoder().decode(server.blobs.get(entry.blob_key!)!)).not.toContain("note");
    }
  });

  it("reads its own files from disk and carries its index over: the next sync moves nothing", async () => {
    const { server, a } = await twoDevices();
    server.calls = {};
    await a.encryption.encrypt(PASS);
    // Only what this device doesn't have locally (B's two files) was downloaded.
    expect(server.blobDownloads).toBeGreaterThan(0);
    const downloads = server.blobDownloads;

    server.calls = {};
    const report = await a.sync();
    expect([report?.pulled, report?.pushed, report?.conflicts, report?.errors.length]).toEqual([0, 0, 0, 0]);
    expect(server.calls.presignDownloads ?? 0).toBe(0);
    expect(server.blobDownloads).toBe(downloads);
  });

  it("another device follows to the encrypted vault, asks for the passphrase, then syncs without conflicts", async () => {
    const { server, a, b } = await twoDevices();
    await a.encryption.encrypt(PASS);

    const report = await b.sync();
    expect(report?.errors).toEqual([]);
    expect(b.settings.vaultId).toBe(a.settings.vaultId);
    expect(b.settings.needsPassphrase).toBe(true);
    expect(b.notices.at(-1)).toContain("Enter its passphrase");
    expect(await b.sync()).toBeNull(); // held until then

    await expect(b.encryption.enterPassphrase("wrong passphrase!!")).rejects.toThrow();
    expect(b.settings.needsPassphrase).toBe(true);
    await b.encryption.enterPassphrase(PASS);
    expect(b.settings.needsPassphrase).toBe(false);

    const after = await b.sync();
    expect([after?.conflicts, after?.errors.length]).toEqual([0, 0]);
    expect(Object.keys(b.vault.snapshot()).filter((p) => p.includes("conflict"))).toEqual([]);
    expect(b.vault.read("Notes/one.md")).toBe("first note\n");

    // And the two keep syncing as usual.
    b.vault.write("Notes/one.md", "first note, edited on B\n");
    await b.sync();
    await a.sync();
    expect(a.vault.read("Notes/one.md")).toBe("first note, edited on B\n");
    expect(server.vaults.size).toBe(1);
  });

  it("an edit made on another device while the vault is frozen waits, then reaches the encrypted vault", async () => {
    const { server, a, b } = await twoDevices();
    let frozen: Awaited<ReturnType<typeof b.sync>> = null;
    server.onFinish = () => void 0;
    const realCopyStart = server.presignUploads.bind(server);
    let once = true;
    server.presignUploads = async (vaultId, sizes) => {
      if (once && vaultId !== "1") {
        once = false;
        b.vault.write("Notes/two.md", "second note, edited on B during the copy\n");
        frozen = await b.sync();
      }
      return realCopyStart(vaultId, sizes);
    };
    await a.encryption.encrypt(PASS);
    expect(frozen!.vaultFrozen).toBe(true);
    expect(frozen!.errors).toEqual([]);

    await b.sync();
    await b.encryption.enterPassphrase(PASS);
    await b.sync();
    await a.sync();
    expect(a.vault.read("Notes/two.md")).toBe("second note, edited on B during the copy\n");
  });

  it("resumes after a failure during the copy, without copying anything twice", async () => {
    const { server, a } = await twoDevices();
    const real = server.commitBatch.bind(server);
    let fail = true;
    server.commitBatch = async (vaultId, commits) => {
      if (fail && vaultId !== "1") {
        fail = false;
        throw new ApiError(0, "timeout", "No response after 60s");
      }
      return real(vaultId, commits);
    };

    await a.encryption.encrypt(PASS);
    expect(a.settings.encryption?.stage).toBe("copying");
    expect(a.settings.encryption?.error).toContain("No response");
    expect(a.settings.vaultId).toBe("1"); // still on the source, untouched
    expect(server.store("1").encryptingInto).not.toBeNull();

    await a.encryption.resume();
    expect(a.settings.encryption).toBeNull();
    expect(server.vaults.has("1")).toBe(false);
    expect(server.store(a.settings.vaultId).entries.size).toBe(5);
  });

  it("finishes after a failure at the very last step, already switched over", async () => {
    const { server, a } = await twoDevices();
    const real = server.finishEncryption.bind(server);
    server.finishEncryption = async () => { throw new ApiError(0, "timeout", "No response after 60s"); };

    await a.encryption.encrypt(PASS);
    expect(a.settings.encryption?.stage).toBe("finishing");
    expect(a.settings.vaultId).toBe(a.settings.encryption?.targetVaultId);

    server.finishEncryption = real;
    await a.encryption.resume();
    expect(a.settings.encryption).toBeNull();
    expect(server.vaults.has("1")).toBe(false);
  });

  it("can be cancelled while copying, leaving the vault as it was", async () => {
    const { server, a, b } = await twoDevices();
    server.commitBatch = async () => { throw new ApiError(0, "timeout", "No response after 60s"); };
    await a.encryption.encrypt(PASS);
    const target = a.settings.encryption!.targetVaultId;

    await a.encryption.cancel();
    expect(a.settings.encryption).toBeNull();
    expect(a.settings.vaultId).toBe("1");
    expect(a.settings.vaultKeyCheck).toBe("");
    expect(server.vaults.has(target)).toBe(false);
    expect(server.store("1").encryptingInto).toBeNull();

    // Writable again.
    delete (server as { commitBatch?: unknown }).commitBatch;
    b.vault.write("Notes/one.md", "edited after the cancel\n");
    expect((await b.sync())?.pushed).toBe(1);
  });

  it("changing the passphrase re-encrypts under the new one; other devices ask for it", async () => {
    const server = new FakeApi();
    const { keyCheck } = await makeKeyCheck("old passphrase here");
    const { id } = await server.createVault("Secret", keyCheck);
    const a = await device(server, { vaultId: String(id), keyCheck, passphrase: "old passphrase here" });
    const b = await device(server, { vaultId: String(id), keyCheck, passphrase: "old passphrase here" });
    a.vault.write("plan.md", "the plan\n");
    await a.sync();
    await b.sync();

    await a.encryption.encrypt(PASS);
    const newKey = await unlock(PASS, a.settings.vaultKeyCheck);
    expect(await contents(server, a.settings.vaultId, new CryptoCodec(newKey))).toEqual({ "plan.md": "the plan\n" });

    await b.sync();
    expect(b.settings.needsPassphrase).toBe(true);
    await b.encryption.enterPassphrase(PASS);
    expect((await b.sync())?.errors).toEqual([]);
  });

  it("a device that already holds the new passphrase follows without asking", async () => {
    const { a, b } = await twoDevices();
    await a.encryption.encrypt(PASS);
    b.settings.passphrase = PASS;
    await b.sync();
    expect(b.settings.needsPassphrase).toBe(false);
    expect(b.syncs()).toBe(1);
  });

  it("refuses when someone else is already encrypting the vault", async () => {
    const { server, a } = await twoDevices();
    await server.startEncryption("1", "someone else's key check");
    await expect(a.encryption.encrypt(PASS)).rejects.toThrow(/already being encrypted/);
    expect(a.settings.encryption).toBeNull();
  });
});

describe("passphrase rules for new passphrases", () => {
  it("asks for at least 12 characters", () => {
    expect(passphraseProblem("short")).toMatch(/at least 12/);
    expect(passphraseProblem("eleven char")).toMatch(/at least 12/);
    expect(passphraseProblem("twelve chars")).toBeNull();
  });
});
