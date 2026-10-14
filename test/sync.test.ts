import { describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api";
import { makeClient } from "./helpers";
import { conflictPath } from "../src/util";
import { PlainCodec } from "../src/codec";
import { CryptoCodec, makeKeyCheck } from "../src/crypto";
import { adoptVaultState, emptySyncState, type IndexEntry, type SyncState } from "../src/sync";

const FAKE_ENTRY: IndexEntry = {
  path: "Note.md", version: 1, localHash: "aa", remoteHash: "bb", mtime: 1, size: 1,
};

function setup() {
  const server = new FakeApi();
  return { server, a: makeClient(server), b: makeClient(server) };
}

describe("SyncEngine", () => {
  it("is no longer busy by the time the terminal status (synced/errors/failed) is announced", async () => {
    const server = new FakeApi();
    const busyAtEachStatus: boolean[] = [];
    const { vault, engine } = makeClient(server, new PlainCodec(), () => busyAtEachStatus.push(engine.busy));
    vault.write("Note.md", "hello");

    await engine.sync();

    // A sidebar/status-bar listener re-renders on every onStatus call, reading
    // `busy` at that exact moment — if the terminal "synced …" status still
    // reported busy=true, the UI could get stuck showing "Syncing…" next to
    // a status line that already says the sync finished.
    expect(busyAtEachStatus.length).toBeGreaterThan(0);
    expect(busyAtEachStatus.at(-1)).toBe(false);
  });

  it("propagates created files to a fresh client", async () => {
    const { a, b } = setup();
    a.vault.write("Note.md", "hello");
    a.vault.write("Deep/Nested/Idea.md", "nested");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.pulled).toBe(2);
    expect(b.vault.read("Note.md")).toBe("hello");
    expect(b.vault.read("Deep/Nested/Idea.md")).toBe("nested");
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
  });

  it("propagates edits", async () => {
    const { a, b } = setup();
    a.vault.write("Note.md", "v1");
    await a.engine.sync();
    await b.engine.sync();

    a.vault.write("Note.md", "v2");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.vault.read("Note.md")).toBe("v2");
  });

  it("propagates deletes to clients with an unmodified copy", async () => {
    const { a, b } = setup();
    a.vault.write("Note.md", "doomed");
    await a.engine.sync();
    await b.engine.sync();

    a.vault.delete("Note.md");
    await a.engine.sync();
    const report = await b.engine.sync();
    expect(report?.deletedLocal).toBe(1);
    expect(b.vault.read("Note.md")).toBeNull();
  });

  it("concurrent edits produce a conflict copy and both versions survive", async () => {
    const { a, b } = setup();
    a.flags.conflictMode = "conflictFile";
    b.flags.conflictMode = "conflictFile";
    a.vault.write("Note.md", "base");
    await a.engine.sync();
    await b.engine.sync();

    a.vault.write("Note.md", "edit from A");
    b.vault.write("Note.md", "edit from B");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    // B keeps its own edit at the original path; A's edit lands in the copy.
    expect(b.vault.read("Note.md")).toBe("edit from B");
    const copyPath = Object.keys(b.vault.snapshot()).find((p) => p.includes("(conflict"));
    expect(copyPath).toBeDefined();
    expect(b.vault.read(copyPath!)).toBe("edit from A");

    // After the dust settles both vaults converge.
    await a.engine.sync();
    await b.engine.sync();
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  });

  it("edit wins over delete", async () => {
    const { a, b } = setup();
    a.vault.write("Note.md", "base");
    await a.engine.sync();
    await b.engine.sync();

    a.vault.delete("Note.md");
    await a.engine.sync();

    b.vault.write("Note.md", "still needed");
    await b.engine.sync();

    await a.engine.sync();
    expect(a.vault.read("Note.md")).toBe("still needed");
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  });

  it("stale push is deferred on version conflict, then converges", async () => {
    const { a, b } = setup();
    a.flags.conflictMode = "conflictFile";
    b.flags.conflictMode = "conflictFile";
    a.vault.write("Note.md", "base");
    await a.engine.sync();
    await b.engine.sync();

    // A pushes v2 while B still believes v1 is current.
    a.vault.write("Note.md", "A v2");
    await a.engine.sync();

    b.vault.write("Note.md", "B v2");
    // B's push cycle pulls A's v2 first (conflict copy), then pushes its own.
    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);

    await a.engine.sync();
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
    expect(Object.keys(a.vault.snapshot()).length).toBe(2);
  });

  it("skips self-echo of its own commits", async () => {
    const { a } = setup();
    a.vault.write("Note.md", "hello");
    await a.engine.sync();

    const report = await a.engine.sync();
    expect(report?.pulled).toBe(0);
    expect(report?.pushed).toBe(0);
  });

  it("stops retrying a file that hit a permanent plan limit, until it changes or clearBlocked() is called", async () => {
    const server = new FakeApi();
    server.maxUploadSize = 10;
    const { vault, engine } = makeClient(server);

    vault.write("Big.md", "x".repeat(20));
    const first = await engine.sync();
    expect(server.uploadAttempts).toBe(1);
    expect(first?.errors[0]).toContain("skipped (file_too_large)");

    // Unchanged file: further cycles must not hit the network again.
    await engine.sync();
    await engine.sync();
    expect(server.uploadAttempts).toBe(1);

    // Explicit retry (e.g. right after upgrading) tries again exactly once.
    engine.clearBlocked();
    const retried = await engine.sync();
    expect(server.uploadAttempts).toBe(2);
    expect(retried?.errors[0]).toContain("skipped (file_too_large)");

    // The file itself changing (now under the limit) also unblocks it.
    vault.write("Big.md", "small");
    const fixed = await engine.sync();
    expect(server.uploadAttempts).toBe(3);
    expect(fixed?.errors.length).toBe(0);
    expect(fixed?.pushed).toBe(1);
  });

  it("halts the whole push and flags quotaBlocked when the vault is out of storage", async () => {
    const server = new FakeApi();
    const { vault, engine } = makeClient(server);
    vault.write("A.md", "hello");
    vault.write("B.md", "world");

    server.quotaExceeded = true;
    const report = await engine.sync();
    expect(report?.quotaBlocked).toBe(true);
    // Account-level billing state, not a bug — never recorded as an error, so
    // it never reaches the error-report channel.
    expect(report?.errors).toEqual([]);
    expect(report?.pushed).toBe(0);

    // After the user frees space / upgrades, a re-sync uploads normally — the
    // quota block leaves nothing sticky on the engine (no `blocked` entries).
    server.quotaExceeded = false;
    const fixed = await engine.sync();
    expect(fixed?.quotaBlocked).toBe(false);
    expect(fixed?.pushed).toBe(2);
  });

  it("mtime churn without content change does not re-upload", async () => {
    const { a, server } = setup();
    a.vault.write("Note.md", "same");
    await a.engine.sync();

    a.vault.write("Note.md", "same"); // new mtime, same bytes
    const report = await a.engine.sync();
    expect(report?.pushed).toBe(0);
    expect(server.latestRevision).toBe(1);
  });
});

describe("3-way merge on concurrent edits", () => {
  const BASE = "line one\nline two\nline three\n";

  async function seed() {
    const { server, a, b } = setup();
    a.vault.write("Note.md", BASE);
    await a.engine.sync();
    await b.engine.sync();
    return { server, a, b };
  }

  it("merges non-overlapping edits into one file, no conflict copy", async () => {
    const { a, b } = await seed();
    a.vault.write("Note.md", "line one EDITED BY A\nline two\nline three\n");
    b.vault.write("Note.md", "line one\nline two\nline three EDITED BY B\n");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.merged).toBe(1);
    expect(report?.conflicts).toBe(0);
    expect(b.vault.read("Note.md")).toBe("line one EDITED BY A\nline two\nline three EDITED BY B\n");
    expect(Object.keys(b.vault.snapshot()).some((p) => p.includes("(conflict"))).toBe(false);

    // B pushes the merge; A pulls it — both converge on a single file.
    await a.engine.sync();
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
    expect(Object.keys(a.vault.snapshot())).toEqual(["Note.md"]);
  });

  it("overlapping edits merge inline with conflict markers by default (Automatically merge)", async () => {
    const { a, b } = await seed();
    a.vault.write("Note.md", "line one\nline two FROM A\nline three\n");
    b.vault.write("Note.md", "line one\nline two FROM B\nline three\n");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.merged).toBe(1);
    expect(report?.conflicts).toBe(0);
    // One file — both versions preserved inline, nothing lost, no second copy.
    expect(Object.keys(b.vault.snapshot()).some((p) => p.includes("(conflict"))).toBe(false);
    const merged = b.vault.read("Note.md")!;
    expect(merged).toContain("<<<<<<< This device");
    expect(merged).toContain("line two FROM B");
    expect(merged).toContain("line two FROM A");
    expect(merged).toContain(">>>>>>> Other device (synced)");

    // B pushes the marker file; A pulls it — both converge on one note.
    await a.engine.sync();
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
    expect(Object.keys(a.vault.snapshot())).toEqual(["Note.md"]);
  });

  it("overlapping edits produce a conflict copy in Create-conflict-file mode", async () => {
    const { a, b } = await seed();
    a.flags.conflictMode = "conflictFile";
    b.flags.conflictMode = "conflictFile";
    a.vault.write("Note.md", "line one\nline two FROM A\nline three\n");
    b.vault.write("Note.md", "line one\nline two FROM B\nline three\n");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(report?.merged).toBe(0);
    expect(b.vault.read("Note.md")).toBe("line one\nline two FROM B\nline three\n");
    expect(Object.keys(b.vault.snapshot()).some((p) => p.includes("(conflict"))).toBe(true);
  });

  it("non-text files always fall back to a conflict copy", async () => {
    const { a, b } = setup();
    a.vault.write("Image.png", "v1 bytes");
    await a.engine.sync();
    await b.engine.sync();

    a.vault.write("Image.png", "v2 from A");
    b.vault.write("Image.png", "v2 from B");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(report?.merged).toBe(0);
  });

  it("missing base (e.g. first sync after plugin upgrade) falls back to a conflict copy", async () => {
    const { a, b } = await seed();
    b.base.map.clear();

    a.vault.write("Note.md", "line one EDITED BY A\nline two\nline three\n");
    b.vault.write("Note.md", "line one\nline two\nline three EDITED BY B\n");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(report?.merged).toBe(0);
  });

  it("stale base (hash mismatch) falls back to a conflict copy", async () => {
    const { a, b } = await seed();
    for (const id of b.base.map.keys()) {
      b.base.map.set(id, new TextEncoder().encode("corrupted").buffer as ArrayBuffer);
    }

    a.vault.write("Note.md", "line one EDITED BY A\nline two\nline three\n");
    b.vault.write("Note.md", "line one\nline two\nline three EDITED BY B\n");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(report?.merged).toBe(0);
  });

  it("shadow base tracks push, pull, and remote delete; skips non-text files", async () => {
    const { a, b } = setup();
    a.vault.write("Note.md", "content");
    a.vault.write("Image.png", "pixels");
    await a.engine.sync();

    // After push: only the text file is shadowed, with the pushed plaintext.
    expect(a.base.map.size).toBe(1);
    const [pushedBase] = [...a.base.map.values()];
    expect(new TextDecoder().decode(pushedBase)).toBe("content");

    // After pull: same on the other device.
    await b.engine.sync();
    expect(b.base.map.size).toBe(1);
    const [pulledBase] = [...b.base.map.values()];
    expect(new TextDecoder().decode(pulledBase)).toBe("content");

    // Remote delete clears the base on the pulling device.
    a.vault.delete("Note.md");
    await a.engine.sync();
    expect(a.base.map.size).toBe(0);
    await b.engine.sync();
    expect(b.base.map.size).toBe(0);
  });
});

describe("exclusions", () => {
  it("excluded folders are not pushed, pulled, or remote-deleted", async () => {
    const { a, b } = setup();
    a.vault.write("Notes/Public.md", "public");
    a.vault.write("Private/Diary.md", "secret");
    a.excluded.push("Private");

    await a.engine.sync();
    await b.engine.sync();
    expect(b.vault.read("Notes/Public.md")).toBe("public");
    expect(b.vault.read("Private/Diary.md")).toBeNull();

    // A file synced before it was excluded must not be tombstoned remotely.
    const { server, a: c, b: d } = setup();
    c.vault.write("Work/Doc.md", "keep me");
    await c.engine.sync();
    await d.engine.sync();
    c.excluded.push("Work");
    await c.engine.sync();
    await d.engine.sync();
    expect(d.vault.read("Work/Doc.md")).toBe("keep me");
    expect([...server.entries.values()].some((e) => e.deleted)).toBe(false);

    // Nor pulled onto a device that excludes it.
    d.excluded.push("Work");
    d.vault.delete("Work/Doc.md");
    const fresh = makeClient(server);
    fresh.excluded.push("Work");
    await fresh.engine.sync();
    expect(fresh.vault.read("Work/Doc.md")).toBeNull();
  });
});

describe("config sync (.obsidian folder)", () => {
  it("with the toggle on, pushes config from A and applies it on B via the config store, not the vault", async () => {
    const { a, b } = setup();
    a.flags.syncConfig = true;
    b.flags.syncConfig = true;
    a.config.put(".obsidian/plugins/calendar/main.js", "console.log('calendar')");
    a.vault.write("Note.md", "hi"); // a normal note rides along

    await a.engine.sync();
    const report = await b.engine.sync();

    expect(report?.pulled).toBe(2); // note + config file
    expect(b.config.readText(".obsidian/plugins/calendar/main.js")).toBe("console.log('calendar')");
    // The config file must NOT have landed in the vault file tree.
    expect(b.vault.read(".obsidian/plugins/calendar/main.js")).toBeNull();
    expect(b.vault.read("Note.md")).toBe("hi");
  });

  it("with the toggle off, ignores config in both directions but still syncs notes", async () => {
    const { a, b } = setup();
    a.flags.syncConfig = true; // A publishes config
    b.flags.syncConfig = false; // B opts out
    a.config.put(".obsidian/plugins/calendar/main.js", "v1");
    a.vault.write("Note.md", "hi");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.pulled).toBe(1); // only the note
    expect(b.config.readText(".obsidian/plugins/calendar/main.js")).toBeNull();
    expect(b.vault.read("Note.md")).toBe("hi");
  });

  it("never uploads the plugin's own folder or the workspace layout", async () => {
    const { a, server } = setup();
    a.flags.syncConfig = true;
    a.config.put(".obsidian/plugins/obsyncian/data.json", '{"apiToken":"SECRET"}');
    a.config.put(".obsidian/workspace.json", '{"main":"layout"}');
    a.config.put(".obsidian/plugins/calendar/main.js", "ok");

    await a.engine.sync();

    // Only the calendar plugin got a server entry; secrets and layout stayed local.
    expect(server.entries.size).toBe(1);
  });

  it("does not remote-delete config files during an ordinary vault sync (deletion-scope guard)", async () => {
    const { server, a, b } = setup();
    a.flags.syncConfig = true;
    a.config.put(".obsidian/plugins/calendar/main.js", "keep me");
    a.vault.write("Note.md", "hi");
    await a.engine.sync();

    // A later sync where the config file is still present must not tombstone it.
    await a.engine.sync();
    expect([...server.entries.values()].some((e) => e.deleted)).toBe(false);

    // And a device that pulls sees the config file intact.
    b.flags.syncConfig = true;
    await b.engine.sync();
    expect(b.config.readText(".obsidian/plugins/calendar/main.js")).toBe("keep me");
  });

  it("propagates a config-file deletion when the toggle is on", async () => {
    const { a, b } = setup();
    a.flags.syncConfig = true;
    b.flags.syncConfig = true;
    a.config.put(".obsidian/plugins/calendar/main.js", "doomed");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.config.readText(".obsidian/plugins/calendar/main.js")).toBe("doomed");

    a.config.map.delete(".obsidian/plugins/calendar/main.js");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.config.readText(".obsidian/plugins/calendar/main.js")).toBeNull();
  });

  it("propagates a config-file rename without losing content", async () => {
    const { a, b } = setup();
    a.flags.syncConfig = true;
    b.flags.syncConfig = true;
    a.config.put(".obsidian/snippets/old.css", "body { color: red; }");
    await a.engine.sync();
    await b.engine.sync();

    // Rename on A: same content, new path.
    const bytes = a.config.map.get(".obsidian/snippets/old.css")!;
    a.config.map.delete(".obsidian/snippets/old.css");
    a.config.map.set(".obsidian/snippets/new.css", bytes);
    await a.engine.sync();

    await b.engine.sync();
    expect(b.config.readText(".obsidian/snippets/old.css")).toBeNull();
    expect(b.config.readText(".obsidian/snippets/new.css")).toBe("body { color: red; }");
  });

  async function seedConfig(path: string, content: string) {
    const { a, b } = setup();
    a.flags.syncConfig = true;
    b.flags.syncConfig = true;
    a.config.put(path, content);
    await a.engine.sync();
    await b.engine.sync();
    return { a, b };
  }
  const conflictCopies = (c: ReturnType<typeof makeClient>) => [...c.config.map.keys()].filter((p) => p.includes("(conflict"));

  it("merges settings JSON changed on two devices key by key, with no conflict copy", async () => {
    const path = ".obsidian/appearance.json";
    const { a, b } = await seedConfig(path, '{"theme":"base","fontSize":16}');
    a.config.put(path, '{"theme":"dark","fontSize":16}');
    b.config.put(path, '{"theme":"base","fontSize":18}');
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(0);
    expect(report?.merged).toBe(1);
    expect(JSON.parse(b.config.readText(path)!)).toEqual({ theme: "dark", fontSize: 18 });
    expect(conflictCopies(b)).toEqual([]);

    await a.engine.sync();
    expect(JSON.parse(a.config.readText(path)!)).toEqual({ theme: "dark", fontSize: 18 });
    // And the merge is the new base: a further one-sided change just applies.
    a.config.put(path, '{"theme":"light","fontSize":18}');
    await a.engine.sync();
    expect((await b.engine.sync())?.merged).toBe(0);
    expect(JSON.parse(b.config.readText(path)!)).toEqual({ theme: "light", fontSize: 18 });
  });

  it("the synced value wins a setting both devices changed", async () => {
    const path = ".obsidian/appearance.json";
    const { a, b } = await seedConfig(path, '{"theme":"base"}');
    a.config.put(path, '{"theme":"from-A"}');
    b.config.put(path, '{"theme":"from-B"}');
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(0);
    expect(JSON.parse(b.config.readText(path)!)).toEqual({ theme: "from-A" });
    expect(conflictCopies(b)).toEqual([]);
  });

  it("plugin code updated on two devices takes the synced version", async () => {
    const path = ".obsidian/plugins/calendar/main.js";
    const { a, b } = await seedConfig(path, "v1");
    a.config.put(path, "v2 from A");
    b.config.put(path, "v3 from B");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(0);
    expect(b.config.readText(path)).toBe("v2 from A");
    expect(conflictCopies(b)).toEqual([]);
  });

  it("a CSS snippet edited on two devices still keeps both", async () => {
    const path = ".obsidian/snippets/mine.css";
    const { a, b } = await seedConfig(path, "body {}");
    a.config.put(path, "body { color: red; }");
    b.config.put(path, "body { color: blue; }");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(b.config.readText(path)).toBe("body { color: blue; }");
    expect(b.config.readText(conflictCopies(b)[0])).toBe("body { color: red; }");
  });
});

// The bug behind the conflict-copy storms: Log out, Unlink and Link-vault all
// wiped the index and the shadow bases while every file stayed on disk. The
// next sync replayed from cursor 0 with an empty index, and applyRemoteChange
// skips tryMerge entirely when there's no entry — so a perfectly mergeable
// edit came back as a "(conflict …)" copy, ignoring "Automatically merge".
describe("re-linking a vault", () => {
  const BASE = "line one\nline two\nline three\n";

  async function seedLinked() {
    const server = new FakeApi();
    const a = makeClient(server);
    const b = makeClient(server);
    a.vault.write("Note.md", BASE);
    await a.engine.sync();
    await b.engine.sync();
    a.state.vaultId = "1";
    b.state.vaultId = "1";
    return { server, a, b };
  }

  // Divergence both devices could have merged cleanly: disjoint line edits.
  async function diverge(a: ReturnType<typeof makeClient>, b: ReturnType<typeof makeClient>) {
    b.vault.write("Note.md", "line one\nline two\nline three EDITED BY B\n");
    await b.engine.sync();
    a.vault.write("Note.md", "line one EDITED BY A\nline two\nline three\n");
  }

  it("keeps the index when the same vault is linked again, so the merge still runs", async () => {
    const { a, b } = await seedLinked();
    await diverge(a, b);

    expect(adoptVaultState(a.state, "1")).toBe(true);
    expect(Object.keys(a.state.files)).toHaveLength(1);

    const report = await a.engine.sync();
    expect(report?.merged).toBe(1);
    expect(report?.conflicts).toBe(0);
    expect(a.vault.read("Note.md")).toBe("line one EDITED BY A\nline two\nline three EDITED BY B\n");
    expect(Object.keys(a.vault.snapshot()).some((p) => p.includes("(conflict"))).toBe(false);
  });

  it("wiping the index instead turns that same mergeable edit into a conflict copy", async () => {
    const { a, b } = await seedLinked();
    await diverge(a, b);

    // What Log out / Unlink / Link-vault used to do unconditionally.
    Object.assign(a.state, emptySyncState());
    a.base.map.clear();

    const report = await a.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(report?.merged).toBe(0);
    expect(Object.keys(a.vault.snapshot()).some((p) => p.includes("(conflict"))).toBe(true);
  });

  it("clears the index when a different vault is linked", () => {
    const state: SyncState = { cursor: 7, files: { f1: FAKE_ENTRY }, lastSyncAt: 123, vaultId: "1" };
    expect(adoptVaultState(state, "2")).toBe(false);
    // lastSyncAt too: otherwise the sidebar reports the previous vault's sync.
    expect(state).toEqual({ cursor: 0, files: {}, lastSyncAt: undefined, vaultId: "2" });
  });

  it("clears an index from before vaultId was tracked", () => {
    const state: SyncState = { cursor: 7, files: { f1: FAKE_ENTRY } };
    expect(adoptVaultState(state, "1")).toBe(false);
    expect(state).toEqual({ cursor: 0, files: {}, vaultId: "1" });
  });

  // Unlink leaves settings.vaultId empty; the index keeps naming its vault so
  // a later re-link to it can be recognised as the same one.
  it("clears the index when linking nothing at all", () => {
    const state: SyncState = { cursor: 7, files: { f1: FAKE_ENTRY }, vaultId: "1" };
    expect(adoptVaultState(state, "")).toBe(false);
    expect(state).toEqual({ cursor: 0, files: {}, vaultId: undefined });
  });
});

// A billing state, not a bug. The server gates every sync endpoint, so an
// unpaid account is rejected on the cycle's very first request — the engine
// has to stop there and say so, not surface it as a sync error. Reporting it
// per-cycle (or per-file) is what produced the 1.0.14 quota_exceeded storm:
// 4,356 error reports from a handful of users.
describe("no active plan", () => {
  it("stops the cycle and flags it, without producing a sync error", async () => {
    const { server, a } = setup();
    a.vault.write("Note.md", "hello");
    server.paymentRequired = true;

    const report = await a.engine.sync();

    expect(report?.paymentRequired).toBe(true);
    expect(report?.errors).toEqual([]);
    expect(report?.pushed).toBe(0);
  });

  it("does not reject, so the caller can pause rather than handle a throw", async () => {
    const { server, a } = setup();
    server.paymentRequired = true;

    await expect(a.engine.sync()).resolves.toBeTruthy();
  });

  it("resumes normally once the plan is active", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "hello");
    server.paymentRequired = true;
    await a.engine.sync();
    expect(server.entries.size).toBe(0);

    server.paymentRequired = false;
    const report = await a.engine.sync();

    expect(report?.paymentRequired).toBe(false);
    expect(report?.pushed).toBe(1);
    await b.engine.sync();
    expect(b.vault.read("Note.md")).toBe("hello");
  });
});

describe("conflictPath", () => {
  it("inserts the marker before the extension", () => {
    const d = new Date(2026, 6, 2, 11, 30);
    expect(conflictPath("Notes/Idea.md", d)).toBe("Notes/Idea (conflict 2026-07-02 1130).md");
    expect(conflictPath("plain", d)).toBe("plain (conflict 2026-07-02 1130)");
    expect(conflictPath(".hidden", d)).toBe(".hidden (conflict 2026-07-02 1130)");
  });
});

describe("forbidden file names", () => {
  it("skips remote files whose names Obsidian can't write, listing them once without errors", async () => {
    const { server, a, b } = setup();
    // Created outside Obsidian (e.g. Finder) on device A — pushes fine.
    a.vault.write('Plans: world? "domination".md', "muahaha");
    a.vault.write("Fine Note.md", "ok");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.pulled).toBe(1);
    expect(b.vault.read("Fine Note.md")).toBe("ok");
    expect(b.vault.read('Plans: world? "domination".md')).toBeNull();
    expect(report?.unwritablePaths).toEqual(['Plans: world? "domination".md']);
    expect(report?.errors).toEqual([]);

    // Next cycle: still skipped, still quiet, no error spam.
    const again = await b.engine.sync();
    expect(again?.errors).toEqual([]);
    expect(again?.unwritablePaths).toEqual([]);
  });

  it("does not download blobs for unwritable files", async () => {
    const { server, a, b } = setup();
    a.vault.write("Bad?.md", "big blob content");
    await a.engine.sync();

    const before = server.blobDownloads ?? 0;
    await b.engine.sync();
    const after = server.blobDownloads ?? 0;
    expect(after - before).toBe(0);
  });
});

describe("remote changes that fail to apply", () => {
  function failDownloads(server: FakeApi) {
    const real = server.getBlob.bind(server);
    server.getBlob = async () => { throw new Error("network blip"); };
    return () => { server.getBlob = real; };
  }

  it("retries a failed download on the next cycle instead of skipping it forever", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "v1");
    await a.engine.sync();
    await b.engine.sync();
    a.vault.write("Note.md", "v2");
    a.vault.write("New.md", "brand new");
    await a.engine.sync();

    const restore = failDownloads(server);
    const failed = await b.engine.sync();
    expect(failed?.errors.length).toBe(2);
    expect(Object.keys(b.state.pending ?? {}).length).toBe(2);
    restore();

    const healed = await b.engine.sync();
    expect(healed?.errors).toEqual([]);
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    expect(b.state.pending).toEqual({});
  });

  it("an edit to a file whose update failed to download merges once it arrives, rather than conflicting forever", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "one\ntwo\nthree\n");
    await a.engine.sync();
    await b.engine.sync();
    a.vault.write("Note.md", "one A\ntwo\nthree\n");
    await a.engine.sync();

    const restore = failDownloads(server);
    await b.engine.sync();
    restore();
    b.vault.write("Note.md", "one\ntwo\nthree B\n");
    await b.engine.sync();
    const settled = await b.engine.sync();
    await a.engine.sync();

    expect(settled?.errors).toEqual([]);
    expect(b.vault.read("Note.md")).toBe("one A\ntwo\nthree B\n");
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  });

  it("backs off a change that keeps failing, until a manual sync forces a retry", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "v1");
    await a.engine.sync();
    const restore = failDownloads(server);

    expect((await b.engine.sync())?.errors.length).toBe(1); // first attempt
    expect((await b.engine.sync())?.errors.length).toBe(1); // immediate retry
    expect((await b.engine.sync())?.errors).toEqual([]); // now backing off
    b.engine.clearBlocked();
    expect((await b.engine.sync())?.errors.length).toBe(1);

    restore();
    b.engine.clearBlocked();
    await b.engine.sync();
    expect(b.vault.read("Note.md")).toBe("v1");
  });

  it("drops a parked change when a newer change to the same file arrives", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "v1");
    await a.engine.sync();
    const restore = failDownloads(server);
    await b.engine.sync();
    restore();

    a.vault.delete("Note.md");
    await a.engine.sync();
    const report = await b.engine.sync();
    expect(report?.errors).toEqual([]);
    expect(b.state.pending).toEqual({});
    expect(b.vault.read("Note.md")).toBeNull();
  });

  it("forgets parked changes when a different vault is linked", () => {
    const state: SyncState = {
      cursor: 5, files: {}, vaultId: "1",
      pending: { x: { change: { file_id: "x", encrypted_path: "p", size: 0, version: 1, revision: 1, ciphertext_hash: "h", deleted: false }, attempts: 1, nextAt: 0 } },
    };
    adoptVaultState(state, "2");
    expect(state.pending).toBeUndefined();
  });
});

describe("push bookkeeping", () => {
  it("pushes a save that landed while the previous version was uploading", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "first");
    const realPut = server.putBlob.bind(server);
    server.putBlob = async (url, data) => {
      await realPut(url, data);
      a.vault.write("Note.md", "second (saved during upload)");
      a.vault.getAbstractFileByPath("Note.md"); // Obsidian mutates TFile.stat in place
    };
    await a.engine.sync();
    server.putBlob = realPut;

    const next = await a.engine.sync();
    await b.engine.sync();
    expect(next?.pushed).toBe(1);
    expect(b.vault.read("Note.md")).toBe("second (saved during upload)");
  });

  it("saves the index during a long push, not only at the end", async () => {
    const { a } = setup();
    for (let i = 0; i < 65; i++) a.vault.write(`n${i}.md`, `note ${i}`);
    a.flags.saves = 0;
    await a.engine.sync();
    // pull page + end of cycle + finally = 3 without mid-push saves; with a
    // batch limit of 20, 65 files are four batches, each saved.
    expect(a.flags.saves).toBe(7);
  });
});

describe("mass-deletion guard", () => {
  async function synced(count: number) {
    const s = setup();
    for (let i = 0; i < count; i++) s.a.vault.write(`n${i}.md`, `note ${i}`);
    await s.a.engine.sync();
    await s.b.engine.sync();
    return s;
  }

  it("holds the deletions when most of the index vanished, and deletes nothing remotely", async () => {
    const { server, a, b } = await synced(30);
    for (let i = 0; i < 20; i++) a.vault.delete(`n${i}.md`);

    const report = await a.engine.sync();
    expect(report?.heldDeletions).toBe(20);
    expect(report?.deletedRemote).toBe(0);
    expect(report?.errors).toEqual([]);
    expect([...server.entries.values()].filter((e) => e.deleted).length).toBe(0);
    await b.engine.sync();
    expect(Object.keys(b.vault.snapshot()).length).toBe(30);
  });

  it("deletes them once the user confirms", async () => {
    const { a, b } = await synced(30);
    for (let i = 0; i < 20; i++) a.vault.delete(`n${i}.md`);
    await a.engine.sync();

    a.engine.resolveHeldDeletions("delete");
    const report = await a.engine.sync();
    expect(report?.deletedRemote).toBe(20);
    expect(report?.heldDeletions).toBe(0);
    await b.engine.sync();
    expect(Object.keys(b.vault.snapshot()).length).toBe(10);
  });

  it("re-downloads them when the user chooses restore", async () => {
    const { server, a } = await synced(30);
    const before = a.vault.snapshot();
    for (let i = 0; i < 20; i++) a.vault.delete(`n${i}.md`);
    await a.engine.sync();

    a.engine.resolveHeldDeletions("restore");
    const report = await a.engine.sync();
    expect(report?.pulled).toBe(20);
    expect(report?.pushed).toBe(0);
    expect(a.vault.snapshot()).toEqual(before);
    expect([...server.entries.values()].filter((e) => e.deleted).length).toBe(0);
    expect((await a.engine.sync())?.heldDeletions).toBe(0);
  });

  it("a confirmation only covers the next cycle", async () => {
    const { a } = await synced(30);
    a.engine.resolveHeldDeletions("delete");
    await a.engine.sync();
    for (let i = 0; i < 20; i++) a.vault.delete(`n${i}.md`);
    expect((await a.engine.sync())?.heldDeletions).toBe(20);
  });

  it("lets ordinary deletions through", async () => {
    const { a } = await synced(30);
    for (let i = 0; i < 9; i++) a.vault.delete(`n${i}.md`);
    expect((await a.engine.sync())?.deletedRemote).toBe(9);

    const small = await synced(8);
    for (let i = 0; i < 8; i++) small.a.vault.delete(`n${i}.md`);
    expect((await small.a.engine.sync())?.deletedRemote).toBe(8);
  });
});

describe("renames", () => {
  const live = (server: FakeApi) => [...server.entries.values()].filter((e) => !e.deleted).map((e) => e.encrypted_path).sort();

  async function seedNote(content = "line1\nline2\n") {
    const s = setup();
    s.a.vault.write("Old.md", content);
    await s.a.engine.sync();
    await s.b.engine.sync();
    return s;
  }

  it("sends a rename as a path change: nothing is uploaded, the file keeps its id", async () => {
    const { server, a, b } = await seedNote();
    const [id] = Object.keys(a.state.files);
    const uploads = server.uploadAttempts;

    a.vault._rename("Old.md", "Folder/New.md");
    const report = await a.engine.sync();
    expect(report?.renamed).toBe(1);
    expect(report?.pushed).toBe(0);
    expect(report?.deletedRemote).toBe(0);
    expect(server.uploadAttempts).toBe(uploads);
    expect(Object.keys(a.state.files)).toEqual([id]);
    expect(a.state.files[id].serverPath).toBeUndefined();

    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual({ "Folder/New.md": "line1\nline2\n" });
    expect(server.entries.size).toBe(1);
  });

  it("renaming a whole folder uploads nothing and doesn't trip the deletion guard", async () => {
    const { server, a, b } = setup();
    for (let i = 0; i < 30; i++) a.vault.write(`Inbox/n${i}.md`, `note ${i}`);
    await a.engine.sync();
    await b.engine.sync();
    const uploads = server.uploadAttempts;

    for (let i = 0; i < 30; i++) a.vault._rename(`Inbox/n${i}.md`, `Archive/n${i}.md`);
    const report = await a.engine.sync();
    expect(report?.renamed).toBe(30);
    expect(report?.heldDeletions).toBe(0);
    expect(server.uploadAttempts).toBe(uploads);
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    expect(Object.keys(b.vault.snapshot()).every((p) => p.startsWith("Archive/"))).toBe(true);
  });

  it("a rename here and an edit there end up as one renamed, edited note (rename synced first)", async () => {
    const { server, a, b } = await seedNote();
    a.vault._rename("Old.md", "New.md");
    b.vault.write("Old.md", "line1\nline2\nB added\n");
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect(a.vault.snapshot()).toEqual({ "New.md": "line1\nline2\nB added\n" });
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    expect(live(server)).toEqual(["New.md"]);
  });

  it("a rename here and an edit there end up as one renamed, edited note (edit synced first)", async () => {
    const { server, a, b } = await seedNote();
    a.vault._rename("Old.md", "New.md");
    b.vault.write("Old.md", "line1\nline2\nB added\n");
    await b.engine.sync();
    const report = await a.engine.sync();
    await b.engine.sync();

    expect(report?.conflicts).toBe(0);
    expect(a.vault.snapshot()).toEqual({ "New.md": "line1\nline2\nB added\n" });
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    expect(live(server)).toEqual(["New.md"]);
  });

  it("renamed here and edited on both sides: the edits merge at the new path", async () => {
    const { a, b } = await seedNote("one\ntwo\nthree\n");
    a.vault._rename("Old.md", "New.md");
    await a.engine.sync(); // rename pushed
    a.vault.write("New.md", "one A\ntwo\nthree\n");
    b.vault.write("Old.md", "one\ntwo\nthree B\n");
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect(a.vault.snapshot()).toEqual({ "New.md": "one A\ntwo\nthree B\n" });
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
  });

  it("when both devices rename the same note, the first to sync wins", async () => {
    const { server, a, b } = await seedNote();
    a.vault._rename("Old.md", "FromA.md");
    b.vault._rename("Old.md", "FromB.md");
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect(a.vault.snapshot()).toEqual({ "FromA.md": "line1\nline2\n" });
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    expect(live(server)).toEqual(["FromA.md"]);
  });

  it("renaming a note and back before syncing is a no-op", async () => {
    const { server, a } = await seedNote();
    a.vault._rename("Old.md", "Tmp.md");
    // No sync in between, but the engine may have noticed the first move.
    await (a.engine as unknown as { detectLocalRenames(): Promise<void> }).detectLocalRenames();
    a.vault._rename("Tmp.md", "Old.md");
    const revision = server.latestRevision;

    const report = await a.engine.sync();
    expect(report?.renamed).toBe(0);
    expect(report?.errors).toEqual([]);
    expect(server.latestRevision).toBe(revision);
    expect(Object.values(a.state.files)[0].serverPath).toBeUndefined();
  });

  it("a renamed-and-edited note is still one delete plus one create", async () => {
    const { server, a, b } = await seedNote();
    a.vault._rename("Old.md", "New.md");
    a.vault.write("New.md", "rewritten entirely\n");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual({ "New.md": "rewritten entirely\n" });
    expect(live(server)).toEqual(["New.md"]);
  });

  it("falls back to re-uploading under the new path on a server without in-place renames", async () => {
    const { server, a, b } = await seedNote();
    server.legacy = true;
    const [id] = Object.keys(a.state.files);
    const uploads = server.uploadAttempts;

    a.vault._rename("Old.md", "New.md");
    const report = await a.engine.sync();
    expect(report?.errors).toEqual([]);
    expect(server.uploadAttempts).toBe(uploads + 1);
    expect(Object.keys(a.state.files)).toEqual([id]);
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual({ "New.md": "line1\nline2\n" });
  });

  it("stays delete + create while an older plugin still syncs the vault", async () => {
    const { server, a, b } = await seedNote();
    server.inPlaceRenames = false;
    await a.engine.sync(); // learns it from the server
    const uploads = server.uploadAttempts;

    a.vault._rename("Old.md", "New.md");
    const report = await a.engine.sync();
    expect(report?.renamed).toBe(0);
    expect(report?.pushed).toBe(1);
    expect(report?.deletedRemote).toBe(1);
    expect(server.uploadAttempts).toBe(uploads + 1);
    expect([...server.entries.values()].map((e) => `${e.encrypted_path}:${e.deleted}`).sort()).toEqual(["New.md:false", "Old.md:true"]);
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual({ "New.md": "line1\nline2\n" });

    // Once the last old device is gone, renames go in place again.
    server.inPlaceRenames = true;
    await a.engine.sync();
    a.vault._rename("New.md", "Newer.md");
    expect((await a.engine.sync())?.renamed).toBe(1);
  });

  it("never renames in place before the server has said it may", async () => {
    const server = new FakeApi();
    const a = makeClient(server);
    a.state.files.x = { path: "Old.md", version: 1, localHash: "", remoteHash: "h", mtime: 1, size: 0 };
    a.vault.write("New.md", "");
    await (a.engine as unknown as { detectLocalRenames(): Promise<void> }).detectLocalRenames();
    expect(a.state.files.x.path).toBe("Old.md");
  });

  it("renaming onto a path another device just created merges into that file", async () => {
    const { server, a, b } = await seedNote("# Plan\n- shared\n");
    b.vault.write("Plan.md", "# Plan\n- shared\n- from B\n");
    await b.engine.sync();
    a.vault._rename("Old.md", "Plan.md"); // A hasn't pulled B's Plan.md yet

    for (let i = 0; i < 3; i++) { await a.engine.sync(); await b.engine.sync(); }
    expect(a.vault.snapshot()).toEqual({ "Plan.md": "# Plan\n- shared\n- from B\n" });
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    expect(live(server)).toEqual(["Plan.md"]);
    expect(new Set(Object.values(a.state.files).map((e) => e.path)).size).toBe(Object.keys(a.state.files).length);
  });
});

describe("one file per path", () => {
  // A's commit lands between B's pull and B's push — the window in which
  // both devices used to end up owning a different file_id for one path.
  async function raceCreate(codecA = new PlainCodec(), codecB = new PlainCodec()) {
    const server = new FakeApi();
    const a = makeClient(server, codecA);
    const b = makeClient(server, codecB);
    a.vault.write("Same.md", "# Same\n- from A\n");
    b.vault.write("Same.md", "# Same\n- from B\n");
    const realChanges = server.changes.bind(server);
    let first = true;
    server.changes = async (v, since) => {
      const page = await realChanges(v, since);
      if (first) { first = false; await a.engine.sync(); }
      return page;
    };
    const raced = await b.engine.sync();
    server.changes = realChanges;
    return { server, a, b, raced };
  }

  it("the server refuses the second file and the loser merges into the first", async () => {
    const { server, a, b, raced } = await raceCreate();
    expect(raced?.errors).toEqual([]);
    expect(raced?.deferred).toEqual(["Same.md"]);
    expect(server.entries.size).toBe(1);

    for (let i = 0; i < 2; i++) { await b.engine.sync(); await a.engine.sync(); }
    expect(server.entries.size).toBe(1);
    expect(b.vault.snapshot()).toEqual({ "Same.md": "# Same\n- from B\n- from A\n" });
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());

    // And a later edit is uploaded once, not once per duplicate id.
    const uploads = server.uploadAttempts;
    a.vault.write("Same.md", "# Same\n- from B\n- from A\n- later\n");
    await a.engine.sync();
    await b.engine.sync();
    expect(server.uploadAttempts).toBe(uploads + 1);
  });

  it("works the same in an encrypted vault, where the server can't see the path", async () => {
    const { key } = await makeKeyCheck("pw");
    const { server, a, b } = await raceCreate(new CryptoCodec(key), new CryptoCodec(key));
    for (let i = 0; i < 2; i++) { await b.engine.sync(); await a.engine.sync(); }
    expect(server.entries.size).toBe(1);
    expect(a.vault.snapshot()).toEqual({ "Same.md": "# Same\n- from B\n- from A\n" });
  });

  it("a path is free again once its file is deleted", async () => {
    const { server, a } = setup();
    a.vault.write("Note.md", "first");
    await a.engine.sync();
    a.vault.delete("Note.md");
    await a.engine.sync();
    a.vault.write("Note.md", "second");
    expect((await a.engine.sync())?.errors).toEqual([]);
    expect([...server.entries.values()].filter((e) => !e.deleted).length).toBe(1);
  });
});

describe("two ids already sharing a path (vaults synced before the server enforced one)", () => {
  // Reproduces the old race against a server that doesn't check, then
  // "upgrades" the server.
  async function seedDuplicate() {
    const server = new FakeApi();
    server.legacy = true;
    const a = makeClient(server);
    const b = makeClient(server);
    a.vault.write("Same.md", "from A\n");
    b.vault.write("Same.md", "from B\n");
    const realChanges = server.changes.bind(server);
    let first = true;
    server.changes = async (v, since) => {
      const page = await realChanges(v, since);
      if (first) { first = false; await a.engine.sync(); }
      return page;
    };
    await b.engine.sync();
    server.changes = realChanges;
    for (let i = 0; i < 3; i++) { await a.engine.sync(); await b.engine.sync(); }
    for (const p of Object.keys(a.vault.snapshot())) if (p.includes("(conflict")) a.vault.delete(p);
    for (let i = 0; i < 2; i++) { await a.engine.sync(); await b.engine.sync(); }
    server.legacy = false;
    const ids = [...server.entries.values()].filter((e) => !e.deleted && e.encrypted_path === "Same.md").map((e) => e.file_id);
    expect(ids.length).toBe(2);
    return { server, a, b };
  }

  it("both devices push edits to the same id, once, without errors", async () => {
    const { server, a, b } = await seedDuplicate();
    for (const [device, text] of [[a, "edit 1\n"], [b, "edit 2\n"], [a, "edit 3\n"], [b, "edit 4\n"]] as const) {
      const uploads = server.uploadAttempts;
      device.vault.write("Same.md", text);
      for (const d of [device, a, b, a, b]) expect((await d.engine.sync())?.errors).toEqual([]);
      expect(server.uploadAttempts - uploads).toBeLessThanOrEqual(2); // the first edit may still settle the other id
      expect(a.vault.read("Same.md")).toBe(text);
      expect(b.vault.read("Same.md")).toBe(text);
    }
    const tokened = [...server.entries.values()].filter((e) => e.path_token);
    expect(tokened.length).toBe(1);
  });

  it("stands down an id whose path the server has given to the other one", async () => {
    const { server, a } = await seedDuplicate();
    // The id this device would NOT pick gets the token first (another device that only knew that one).
    const ids = Object.entries(a.state.files).filter(([, e]) => e.path === "Same.md").map(([id]) => id).sort();
    server.entries.get(ids[1])!.path_token = await new PlainCodec().pathToken("Same.md");

    a.vault.write("Same.md", "edited\n");
    const lost = await a.engine.sync();
    expect(lost?.errors).toEqual([]);
    expect(lost?.deferred).toEqual(["Same.md"]);
    expect((await a.engine.sync())?.errors).toEqual([]);
    expect(a.state.files[ids[0]].pathLost).toBe(true);
    expect(server.entries.get(ids[1])!.version).toBeGreaterThan(1);
  });

  it("deleting the note removes both ids, so it can't come back on a fresh device", async () => {
    const { server, a, b } = await seedDuplicate();
    a.vault.delete("Same.md");
    await a.engine.sync();
    expect([...server.entries.values()].filter((e) => !e.deleted).length).toBe(0);
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual({});
    const fresh = makeClient(server);
    await fresh.engine.sync();
    expect(fresh.vault.snapshot()).toEqual({});
  });
});

describe("merging without a base", () => {
  const copies = (c: ReturnType<typeof makeClient>) => Object.keys(c.vault.snapshot()).filter((p) => p.includes("(conflict"));

  it("the same daily note created on two devices becomes one note with both entries", async () => {
    const { a, b } = setup();
    a.vault.write("Daily/2026-10-11.md", "# Daily\n\n- laptop item\n");
    b.vault.write("Daily/2026-10-11.md", "# Daily\n\n- phone item\n");
    await a.engine.sync();
    const report = await b.engine.sync();
    await a.engine.sync();

    expect(report?.conflicts).toBe(0);
    expect(report?.merged).toBe(1);
    expect(b.vault.snapshot()).toEqual({ "Daily/2026-10-11.md": "# Daily\n\n- phone item\n- laptop item\n" });
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  });

  it("in Create-conflict-file mode, differing lines still go to a conflict copy", async () => {
    const { a, b } = setup();
    b.flags.conflictMode = "conflictFile";
    a.vault.write("Daily.md", "# Daily\n\n- laptop item\n");
    b.vault.write("Daily.md", "# Daily\n\n- phone item\n");
    await a.engine.sync();
    expect((await b.engine.sync())?.conflicts).toBe(1);
    expect(b.vault.read("Daily.md")).toBe("# Daily\n\n- phone item\n");
  });

  it("unrelated notes that happen to share a name stay two files", async () => {
    const { a, b } = setup();
    a.vault.write("Untitled.md", "shopping\nmilk\nbread\n");
    b.vault.write("Untitled.md", "meeting notes\nagenda\nbudget\n");
    await a.engine.sync();
    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(copies(b).length).toBe(1);
    expect(b.vault.read("Untitled.md")).toBe("meeting notes\nagenda\nbudget\n");
  });

  it("an empty note on one side just takes the other's content", async () => {
    const { a, b } = setup();
    a.vault.write("New.md", "written on A\n");
    b.vault.write("New.md", "");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual({ "New.md": "written on A\n" });
  });

  it("linking a device that already has the vault doesn't conflict on files with additions", async () => {
    const { a, b } = setup();
    for (let i = 0; i < 5; i++) {
      a.vault.write(`n${i}.md`, `# Note ${i}\nbody\n`);
      b.vault.write(`n${i}.md`, `# Note ${i}\nbody\n`);
    }
    b.vault.write("n0.md", "# Note 0\nbody\nadded on B before linking\n");
    await a.engine.sync();
    const report = await b.engine.sync();
    await a.engine.sync();
    expect(report?.conflicts).toBe(0);
    expect(copies(b)).toEqual([]);
    expect(a.vault.read("n0.md")).toBe("# Note 0\nbody\nadded on B before linking\n");
  });

  it("an edit after a push whose index was never saved is not a conflict against our own push", async () => {
    const { a, b } = setup();
    a.vault.write("Note.md", "l1\nl2\nl3\n");
    await a.engine.sync();
    await b.engine.sync();
    const saved = JSON.parse(JSON.stringify(a.state)) as SyncState;

    a.vault.write("Note.md", "l1 A\nl2\nl3\n");
    await a.engine.sync(); // the commit reached the server…
    a.state.cursor = saved.cursor; // …but the app died before data.json was written
    a.state.files = saved.files;
    a.vault.write("Note.md", "l1 A\nl2\nl3 A again\n");

    const report = await a.engine.sync();
    expect(report?.conflicts).toBe(0);
    expect(report?.merged).toBe(0);
    expect(a.vault.snapshot()).toEqual({ "Note.md": "l1 A\nl2\nl3 A again\n" });
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
  });

  it("the same for a brand-new note", async () => {
    const { a } = setup();
    const saved = JSON.parse(JSON.stringify(a.state)) as SyncState;
    a.vault.write("Fresh.md", "hello\n");
    await a.engine.sync();
    a.state.cursor = saved.cursor;
    a.state.files = saved.files;
    a.vault.write("Fresh.md", "hello\nmore\n");

    const report = await a.engine.sync();
    expect(report?.conflicts).toBe(0);
    expect(a.vault.snapshot()).toEqual({ "Fresh.md": "hello\nmore\n" });
  });

  it("a pull whose index was never saved doesn't turn the next remote edit into a conflict", async () => {
    const { a, b } = setup();
    a.vault.write("Note.md", "v1 line\nsecond\n");
    await a.engine.sync();
    const saved = JSON.parse(JSON.stringify(b.state)) as SyncState;
    await b.engine.sync(); // file and base written…
    b.state.cursor = saved.cursor; // …index lost
    b.state.files = saved.files;

    a.vault.write("Note.md", "v2 completely different\ntext here\n");
    await a.engine.sync();
    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(0);
    expect(b.vault.snapshot()).toEqual({ "Note.md": "v2 completely different\ntext here\n" });
  });
});

describe("batched push", () => {
  it("uploads many files in a handful of requests", async () => {
    const { server, a, b } = setup();
    for (let i = 0; i < 100; i++) a.vault.write(`n${i}.md`, `note ${i}`);
    const report = await a.engine.sync();
    expect(report?.pushed).toBe(100);
    expect(report?.errors).toEqual([]);
    // 1 pull + 5 batches of 20, each one presign and one commit.
    expect(server.calls).toEqual({ changes: 1, presignUploads: 5, commitBatch: 5 });

    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
  });

  it("deletes in batches too", async () => {
    const { server, a } = setup();
    for (let i = 0; i < 100; i++) a.vault.write(`n${i}.md`, `note ${i}`);
    await a.engine.sync();
    for (let i = 0; i < 30; i++) a.vault.delete(`n${i}.md`);
    server.calls = {};
    expect((await a.engine.sync())?.deletedRemote).toBe(30);
    expect(server.calls).toEqual({ changes: 1, commitBatch: 2 });
  });

  it("closes a batch early when its files add up to the byte budget", async () => {
    const { server, a } = setup();
    const big = "x".repeat(12 * 1024 * 1024);
    for (let i = 0; i < 6; i++) a.vault.write(`big${i}.bin`, big + i);
    let inFlight = 0;
    let peak = 0;
    const inBatch: number[] = [];
    const realPresign = server.presignUploads.bind(server);
    server.presignUploads = async (v, sizes) => {
      inBatch.push(sizes.length);
      return realPresign(v, sizes);
    };
    server.onPut = (_url, data) => { inFlight += data.byteLength; peak = Math.max(peak, inFlight); };
    const realCommit = server.commitBatch.bind(server);
    server.commitBatch = async (v, commits) => {
      inFlight = 0;
      return realCommit(v, commits);
    };
    expect((await a.engine.sync())?.pushed).toBe(6);
    expect(inBatch).toEqual([3, 3]); // 3 x 12 MB crosses the 32 MB budget
    expect(peak).toBeLessThan(40 * 1024 * 1024);
  });

  it("one file's failure doesn't take the rest of its batch with it", async () => {
    const { server, a, b } = setup();
    a.vault.write("ok1.md", "one");
    a.vault.write("huge.md", "x".repeat(500));
    a.vault.write("ok2.md", "two");
    server.maxUploadSize = 100;

    const report = await a.engine.sync();
    expect(report?.pushed).toBe(2);
    expect(report?.errors).toEqual(["skipped (file_too_large): huge.md — will retry once the file changes or you upgrade"]);
    await b.engine.sync();
    expect(Object.keys(b.vault.snapshot()).sort()).toEqual(["ok1.md", "ok2.md"]);
    // And it stays blocked rather than being retried every cycle.
    const attempts = server.uploadAttempts;
    await a.engine.sync();
    expect(server.uploadAttempts).toBe(attempts);
  });

  it("a version conflict inside a batch defers only that file", async () => {
    const { a, b } = setup();
    a.vault.write("shared.md", "one\ntwo\nthree\n");
    await a.engine.sync();
    await b.engine.sync();
    a.vault.write("shared.md", "one A\ntwo\nthree\n");
    await a.engine.sync();

    b.vault.write("shared.md", "one\ntwo\nthree B\n");
    b.vault.write("other.md", "unrelated");
    // B pushes without having pulled A's edit: skip its pull for one cycle.
    const pull = (b.engine as unknown as { pull: (r: unknown) => Promise<void> });
    const realPull = pull.pull.bind(b.engine);
    pull.pull = async () => { (b.engine as unknown as { batchLimit: number }).batchLimit = 20; };
    const report = await b.engine.sync();
    pull.pull = realPull;
    expect(report?.errors).toEqual([]);
    expect(report?.deferred).toEqual(["shared.md"]);
    expect(report?.pushed).toBe(1);

    await b.engine.sync();
    await a.engine.sync();
    expect(a.vault.read("shared.md")).toBe("one A\ntwo\nthree B\n");
    expect(a.vault.read("other.md")).toBe("unrelated");
  });

  it("a whole batch request failing is reported per file and retried next cycle", async () => {
    const { server, a } = setup();
    a.vault.write("a.md", "a");
    a.vault.write("b.md", "b");
    const real = server.commitBatch.bind(server);
    server.commitBatch = async () => { throw new Error("network down"); };
    const failed = await a.engine.sync();
    expect(failed?.pushed).toBe(0);
    expect(failed?.errors).toEqual(["push a.md: Error: network down", "push b.md: Error: network down"]);
    server.commitBatch = real;
    expect((await a.engine.sync())?.pushed).toBe(2);
  });

  it("against a server without batch endpoints, pushes file by file as before", async () => {
    const { server, a, b } = setup();
    server.legacy = true;
    for (let i = 0; i < 30; i++) a.vault.write(`n${i}.md`, `note ${i}`);
    const report = await a.engine.sync();
    expect(report?.pushed).toBe(30);
    expect(report?.errors).toEqual([]);
    expect(server.calls).toEqual({ changes: 1, presignUpload: 30, commit: 30 });
    a.vault.delete("n0.md");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
  });

  it("halts on quota without losing what was already committed", async () => {
    const { server, a } = setup();
    for (let i = 0; i < 45; i++) a.vault.write(`n${i}.md`, `note ${i}`);
    const real = server.commitBatch.bind(server);
    let batches = 0;
    server.commitBatch = async (v, commits) => {
      if (++batches === 2) server.quotaExceeded = true;
      return real(v, commits);
    };
    const report = await a.engine.sync();
    expect(report?.quotaBlocked).toBe(true);
    expect(report?.errors).toEqual([]);
    expect(report?.pushed).toBe(20);
    expect(batches).toBe(2); // the third batch was never sent
    expect(Object.keys(a.state.files).length).toBe(20);
  });
});

describe("pull", () => {
  it("applies a page in slices bounded by bytes", async () => {
    const { server, a, b } = setup();
    const big = "y".repeat(12 * 1024 * 1024);
    for (let i = 0; i < 6; i++) a.vault.write(`big${i}.bin`, big + i);
    await a.engine.sync();
    server.calls = {};
    expect((await b.engine.sync())?.pulled).toBe(6);
    // One page of changes, fetched as three slices of two 12 MB files.
    expect(server.calls.changes).toBe(1);
    expect(server.calls.presignDownloads).toBe(3);
    expect(Object.keys(b.vault.snapshot()).length).toBe(6);
  });

  it("a new device is not sent the vault's old deletions, but still gets ones made during its pull", async () => {
    const { server, a } = setup();
    for (let i = 0; i < 6; i++) a.vault.write(`n${i}.md`, `note ${i}`);
    a.vault.write("gone.md", "deleted long ago");
    await a.engine.sync();
    a.vault.delete("gone.md");
    await a.engine.sync();

    const fresh = makeClient(server);
    server.pageSize = 2;
    const seen: { id: string; deleted: boolean }[] = [];
    const realChanges = server.changes.bind(server);
    let page = 0;
    server.changes = async (v, since, opts) => {
      if (++page === 2) {
        a.vault.delete("n0.md"); // fresh already pulled n0 on page 1
        server.changes = realChanges;
        await a.engine.sync();
        server.changes = counting;
      }
      const result = await realChanges(v, since, opts);
      seen.push(...result.changes.map((c) => ({ id: c.file_id, deleted: c.deleted })));
      return result;
    };
    const counting = server.changes;
    await fresh.engine.sync();
    server.changes = realChanges;

    expect(seen.filter((c) => c.deleted).length).toBe(1); // n0's, not gone.md's
    expect(fresh.vault.read("gone.md")).toBeNull();
    expect(fresh.vault.read("n0.md")).toBeNull();
    expect(Object.keys(fresh.vault.snapshot()).sort()).toEqual(["n1.md", "n2.md", "n3.md", "n4.md", "n5.md"]);
  });

  it("a device that already has an index is sent every deletion", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "x");
    a.vault.write("Other.md", "y");
    await a.engine.sync();
    await b.engine.sync();
    a.vault.delete("Note.md");
    await a.engine.sync();
    b.state.cursor = 0; // even replaying from the start
    await b.engine.sync();
    expect(b.vault.read("Note.md")).toBeNull();
    expect(server.calls.changes).toBeGreaterThan(0);
  });
});

describe("telling the engine's own activity from the user's", () => {
  it("recognises the revisions it committed, until a pull has passed them", async () => {
    const { server, a, b } = setup();
    a.vault.write("Note.md", "x");
    await a.engine.sync();
    expect(a.engine.isOwnRevision(server.latestRevision)).toBe(true);
    expect(b.engine.isOwnRevision(server.latestRevision)).toBe(false);
    await a.engine.sync();
    expect(a.engine.isOwnRevision(server.latestRevision)).toBe(false);
    expect(a.state.cursor).toBe(server.latestRevision);
  });

  it("recognises files it wrote, moved and removed during a pull — and not a later edit to them", async () => {
    const { a, b } = setup();
    a.vault.write("Keep.md", "v1");
    a.vault.write("Move.md", "m");
    a.vault.write("Drop.md", "d");
    await a.engine.sync();
    await b.engine.sync();
    const mtime = (path: string) => (b.vault.getAbstractFileByPath(path) as { stat: { mtime: number } }).stat.mtime;
    expect(b.engine.isOwnChange("Keep.md", mtime("Keep.md"))).toBe(true);

    a.vault.write("Keep.md", "v2");
    a.vault._rename("Move.md", "Moved.md");
    a.vault.delete("Drop.md");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.engine.isOwnChange("Keep.md", mtime("Keep.md"))).toBe(true);
    expect(b.engine.isOwnChange("Move.md", null)).toBe(true);
    expect(b.engine.isOwnChange("Moved.md", mtime("Moved.md"))).toBe(true);
    expect(b.engine.isOwnChange("Drop.md", null)).toBe(true);

    b.vault.write("Keep.md", "edited by the user");
    expect(b.engine.isOwnChange("Keep.md", mtime("Keep.md"))).toBe(false);
    expect(b.engine.isOwnChange("Never.md", null)).toBe(false);
    b.vault.delete("Moved.md");
    expect(b.engine.isOwnChange("Moved.md", null)).toBe(false);
  });
});

describe("error reports never carry file names", () => {
  it("keeps the path in the local error but replaces it in the reportable copy", async () => {
    const { server, a } = setup();
    a.vault.write("Семья/Личное/дневник.md", "a much longer secret note");
    a.vault.write("ok.md", "fine");
    server.maxUploadSize = 10;
    const report = await a.engine.sync();
    expect(report?.errors).toEqual(["skipped (file_too_large): Семья/Личное/дневник.md — will retry once the file changes or you upgrade"]);
    expect(report?.reportable).toEqual(["skipped (file_too_large): <file> — will retry once the file changes or you upgrade"]);
  });

  it("a pull failure names the file only locally", async () => {
    const { a, b } = setup();
    a.vault.write("Private/plan.md", "x");
    await a.engine.sync();
    const vault = b.vault as unknown as { createBinary: (p: string, d: ArrayBuffer) => Promise<unknown> };
    vault.createBinary = async (path: string) => { throw new Error(`cannot create ${path}`); };
    const report = await b.engine.sync();
    expect(report?.errors.join()).toContain("Private/plan.md");
    expect(report?.reportable.join()).not.toContain("Private/plan.md");
    expect(report?.reportable.join()).toContain("cannot create <file>");
  });

  it("a lost race is not an error at all", async () => {
    const { a, b } = setup();
    a.vault.write("n.md", "one\n");
    await a.engine.sync();
    await b.engine.sync();
    a.vault.write("n.md", "one A\n");
    await a.engine.sync();
    b.vault.write("n.md", "one B\n");
    const pull = b.engine as unknown as { pull: (r: unknown) => Promise<void> };
    const realPull = pull.pull.bind(b.engine);
    pull.pull = async () => {};
    const report = await b.engine.sync();
    pull.pull = realPull;
    expect(report?.errors).toEqual([]);
    expect(report?.reportable).toEqual([]);
    expect(report?.deferred).toEqual(["n.md"]);
  });
});
