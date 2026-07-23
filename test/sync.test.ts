import { describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api";
import { makeClient } from "./helpers";
import { conflictPath } from "../src/util";
import { PlainCodec } from "../src/codec";

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

  it("rename converges (as delete + create in v1)", async () => {
    const { a, b } = setup();
    a.vault.write("Old.md", "content");
    await a.engine.sync();
    await b.engine.sync();

    a.vault._rename("Old.md", "New.md");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.vault.read("Old.md")).toBeNull();
    expect(b.vault.read("New.md")).toBe("content");
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

  it("concurrent edits to a config JSON produce a conflict copy (no line merge)", async () => {
    const { a, b } = setup();
    a.flags.syncConfig = true;
    b.flags.syncConfig = true;
    a.config.put(".obsidian/appearance.json", '{"theme":"base"}');
    await a.engine.sync();
    await b.engine.sync();

    a.config.put(".obsidian/appearance.json", '{"theme":"from-A"}');
    b.config.put(".obsidian/appearance.json", '{"theme":"from-B"}');
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report?.conflicts).toBe(1);
    expect(report?.merged).toBe(0);
    expect(b.config.readText(".obsidian/appearance.json")).toBe('{"theme":"from-B"}');
    const copyPath = [...b.config.map.keys()].find((p) => p.includes("(conflict"));
    expect(copyPath).toBeDefined();
    expect(b.config.readText(copyPath!)).toBe('{"theme":"from-A"}');
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
