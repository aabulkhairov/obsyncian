import { describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api";
import { makeClient } from "./helpers";
import { conflictPath } from "../src/util";

function setup() {
  const server = new FakeApi();
  return { server, a: makeClient(server), b: makeClient(server) };
}

describe("SyncEngine", () => {
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

describe("conflictPath", () => {
  it("inserts the marker before the extension", () => {
    const d = new Date(2026, 6, 2, 11, 30);
    expect(conflictPath("Notes/Idea.md", d)).toBe("Notes/Idea (conflict 2026-07-02 1130).md");
    expect(conflictPath("plain", d)).toBe("plain (conflict 2026-07-02 1130)");
    expect(conflictPath(".hidden", d)).toBe(".hidden (conflict 2026-07-02 1130)");
  });
});
