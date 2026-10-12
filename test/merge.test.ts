import { describe, expect, it } from "vitest";
import { isMergeablePath, merge3, merge3Markers, mergeJson, mergeUnion, tryDecodeUtf8 } from "../src/merge";

describe("merge3", () => {
  it("merges edits to different lines", () => {
    expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
  });

  it("returns null on overlapping edits", () => {
    expect(merge3("a\nb\nc", "a\nB1\nc", "a\nB2\nc")).toBeNull();
  });

  it("identical concurrent edits merge cleanly (false conflict)", () => {
    expect(merge3("a\nb", "a\nB", "a\nB")).toBe("a\nB");
  });

  it("handles insertions on both sides", () => {
    expect(merge3("a\nz", "top\na\nz", "a\nz\nbottom")).toBe("top\na\nz\nbottom");
  });

  it("round-trips trailing newlines", () => {
    // Adding a trailing newline is an ordinary line edit near the end.
    expect(merge3("a\nb", "a\nb\n", "a2\nb")).toBe("a2\nb\n");
  });

  it("preserves CRLF content without normalizing", () => {
    expect(merge3("a\r\nb\r\nc", "A\r\nb\r\nc", "a\r\nb\r\nC")).toBe("A\r\nb\r\nC");
  });

  it("handles empty base", () => {
    expect(merge3("", "added by A\n", "")).toBe("added by A\n");
  });

  it("deleting a line adjacent to the other side's edit is a conflict", () => {
    expect(merge3("a\nb\nc", "a\nc", "a\nb\nC")).toBeNull();
  });
});

describe("merge3Markers", () => {
  it("merges disjoint edits cleanly with no markers", () => {
    const r = merge3Markers("a\nb\nc", "A\nb\nc", "a\nb\nC");
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nb\nC");
  });

  it("collapses identical concurrent edits (false conflict) with no markers", () => {
    const r = merge3Markers("a\nb", "a\nB", "a\nB");
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("a\nB");
  });

  it("preserves overlapping edits inline with git-style markers", () => {
    const r = merge3Markers("a\nb\nc", "a\nLOCAL\nc", "a\nREMOTE\nc");
    expect(r.conflict).toBe(true);
    expect(r.text).toContain("<<<<<<< This device");
    expect(r.text).toContain("LOCAL");
    expect(r.text).toContain("=======");
    expect(r.text).toContain("REMOTE");
    expect(r.text).toContain(">>>>>>> Other device (synced)");
    // Nothing is lost — both sides are present.
  });
});

describe("isMergeablePath", () => {
  it("accepts md/txt case-insensitively, rejects everything else", () => {
    expect(isMergeablePath("Notes/Idea.md")).toBe(true);
    expect(isMergeablePath("Notes/IDEA.MD")).toBe(true);
    expect(isMergeablePath("todo.txt")).toBe(true);
    expect(isMergeablePath("Board.canvas")).toBe(false);
    expect(isMergeablePath("Image.png")).toBe(false);
    expect(isMergeablePath("no-extension")).toBe(false);
  });
});

describe("tryDecodeUtf8", () => {
  it("decodes valid UTF-8 and rejects invalid bytes", () => {
    expect(tryDecodeUtf8(new TextEncoder().encode("привет").buffer as ArrayBuffer)).toBe("привет");
    expect(tryDecodeUtf8(new Uint8Array([0xff, 0xfe, 0x00]).buffer as ArrayBuffer)).toBeNull();
  });
});

describe("merge3Markers — additions and word-level edits", () => {
  it("keeps both when two devices append to the end of the same list", () => {
    const r = merge3Markers("- one\n- two\n", "- one\n- two\n- from phone\n", "- one\n- two\n- from laptop\n");
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("- one\n- two\n- from phone\n- from laptop\n");
  });

  it("keeps both when two devices insert at the same spot mid-file", () => {
    const r = merge3Markers("a\nz", "a\nlocal 1\nlocal 2\nz", "a\nremote\nz");
    expect(r).toEqual({ text: "a\nlocal 1\nlocal 2\nremote\nz", conflict: false });
  });

  it("does not duplicate lines both additions share", () => {
    const r = merge3Markers("a\n", "a\n## Log\n- mine\n", "a\n## Log\n- theirs\n");
    expect(r).toEqual({ text: "a\n## Log\n- mine\n- theirs\n", conflict: false });
  });

  it("merges edits to different sentences of one paragraph", () => {
    const r = merge3Markers(
      "First sentence. Second sentence. Third sentence.\n",
      "First sentence. Second sentence. Third sentence EDITED.\n",
      "First sentence EDITED. Second sentence. Third sentence.\n"
    );
    expect(r).toEqual({ text: "First sentence EDITED. Second sentence. Third sentence EDITED.\n", conflict: false });
  });

  it("merges word-level edits in Cyrillic text", () => {
    const r = merge3Markers("Купить молоко и хлеб сегодня", "Купить кефир и хлеб сегодня", "Купить молоко и хлеб завтра");
    expect(r).toEqual({ text: "Купить кефир и хлеб завтра", conflict: false });
  });

  it("still marks edits to the very same word", () => {
    const r = merge3Markers("price: 10", "price: 20", "price: 30");
    expect(r.conflict).toBe(true);
    expect(r.text).toBe("<<<<<<< This device\nprice: 20\n=======\nprice: 30\n>>>>>>> Other device (synced)");
  });

  it("marks a line one side deleted and the other edited", () => {
    const r = merge3Markers("a\nb\nc", "a\nc", "a\nb edited\nc");
    expect(r.conflict).toBe(true);
    expect(r.text).toContain("b edited");
  });
});

describe("mergeUnion (no base)", () => {
  it("merges two daily notes created from the same template", () => {
    const r = mergeUnion("# Daily\n\n## Tasks\n- phone item\n\n## Notes\n", "# Daily\n\n## Tasks\n- laptop item\n\n## Notes\n");
    expect(r?.text).toBe("# Daily\n\n## Tasks\n- phone item\n- laptop item\n\n## Notes\n");
  });

  it("is exactly the longer file when the other is a subset of it", () => {
    expect(mergeUnion("hello\nmore\n", "hello\n")).toEqual({ text: "hello\nmore\n", overlap: false });
    expect(mergeUnion("a\nc\n", "a\nb\nc\n")).toEqual({ text: "a\nb\nc\n", overlap: false });
  });

  it("takes the other side when one is empty", () => {
    expect(mergeUnion("", "content\n")).toEqual({ text: "content\n", overlap: false });
    expect(mergeUnion("content\n", "\n")).toEqual({ text: "content\n", overlap: false });
  });

  it("refuses to interleave unrelated notes", () => {
    expect(mergeUnion("shopping\nmilk\nbread\n", "meeting notes\nagenda\nbudget\n")).toBeNull();
  });

  it("does not count blank lines as similarity", () => {
    expect(mergeUnion("a\n\n\n\nb\n", "c\n\n\n\nd\n")).toBeNull();
  });
});

describe("mergeJson", () => {
  const j = (v: unknown) => JSON.stringify(v);

  it("takes each side's change to a different key", () => {
    expect(JSON.parse(mergeJson(j({ theme: "a", size: 1 }), j({ theme: "b", size: 1 }), j({ theme: "a", size: 2 }))!))
      .toEqual({ theme: "b", size: 2 });
  });

  it("the remote wins a key both sides changed", () => {
    expect(JSON.parse(mergeJson(j({ theme: "base" }), j({ theme: "local" }), j({ theme: "remote" }))!)).toEqual({ theme: "remote" });
  });

  it("merges nested objects and honours deletions", () => {
    const merged = mergeJson(
      j({ a: { x: 1, y: 1 }, gone: true, keep: 1 }),
      j({ a: { x: 2, y: 1 }, gone: true, keep: 1, added: "local" }),
      j({ a: { x: 1, y: 2 }, keep: 1 })
    );
    expect(JSON.parse(merged!)).toEqual({ a: { x: 2, y: 2 }, keep: 1, added: "local" });
  });

  it("keeps a key the remote deleted if local changed it", () => {
    expect(JSON.parse(mergeJson(j({ k: 1 }), j({ k: 2 }), j({}))!)).toEqual({ k: 2 });
  });

  it("treats arrays as whole values", () => {
    expect(JSON.parse(mergeJson(j({ l: [1] }), j({ l: [1, 2] }), j({ l: [1] }))!)).toEqual({ l: [1, 2] });
  });

  it("without a base keeps every key, remote winning clashes", () => {
    expect(JSON.parse(mergeJson(null, j({ a: 1, both: "l" }), j({ b: 2, both: "r" }))!)).toEqual({ a: 1, b: 2, both: "r" });
  });

  it("returns the remote file unchanged when local changed nothing", () => {
    const remote = '{\n  "theme": "x",\n  "size": 2\n}';
    expect(mergeJson('{\n  "theme": "x",\n  "size": 1\n}', '{\n  "theme": "x",\n  "size": 1\n}', remote)).toBe(remote);
  });

  it("gives up on anything that isn't a JSON object", () => {
    expect(mergeJson(null, "[1]", "{}")).toBeNull();
    expect(mergeJson(null, "{", "{}")).toBeNull();
  });
});
