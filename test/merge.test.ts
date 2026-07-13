import { describe, expect, it } from "vitest";
import { isMergeablePath, merge3, merge3Markers, tryDecodeUtf8 } from "../src/merge";

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
