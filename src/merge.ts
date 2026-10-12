import { diff3Merge, diffComm } from "node-diff3";

// Only formats where a line-based merge is meaningful. Notably NOT .canvas:
// it's JSON, and a line merge can produce syntactically broken output.
export const MERGEABLE_EXTENSIONS = new Set(["md", "txt"]);

export function isMergeablePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return MERGEABLE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// Strict decode: a .md file that isn't valid UTF-8 (someone renamed a binary)
// must fall back to the conflict-copy path, not get mangled by merging.
export function tryDecodeUtf8(buf: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

// Three-way line merge. Returns the merged text, or null when local and
// remote touched overlapping lines — the caller then keeps today's
// conflict-copy behavior. excludeFalseConflicts makes identical concurrent
// edits (both devices made the same change) merge cleanly.
export function merge3(base: string, local: string, remote: string): string | null {
  const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), {
    excludeFalseConflicts: true,
  });
  const lines: string[] = [];
  for (const region of regions) {
    if (!region.ok) return null;
    lines.push(...region.ok);
  }
  return lines.join("\n");
}

// Labels shown in the git-style conflict markers when "Automatically merge"
// has to preserve overlapping edits inline.
export const MERGE_LABEL_LOCAL = "This device";
export const MERGE_LABEL_REMOTE = "Other device (synced)";

// Three-way// Three-way merge that ALWAYS returns text — nothing is ever lost. Works
// line by line first, then looks closer at each hunk both sides touched:
//  - identical concurrent edits collapse (excludeFalseConflicts);
//  - both sides ADDED lines at the same spot (the base had nothing there —
//    two devices appending to the same list): both are kept, this device's
//    first. Notes are prose, not code; two additions don't contradict.
//  - both sides changed the same lines: retried word by word, so edits to
//    different sentences of one paragraph (one line in Obsidian) still merge;
//  - only edits to the very same words are left inline with git-style
//    <<<<<<< / ======= / >>>>>>> markers.
// `conflict` reports whether any markers were inserted, so the caller can
// flag the file for review.
export function merge3Markers(
  base: string,
  local: string,
  remote: string
): { text: string; conflict: boolean } {
  const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), {
    excludeFalseConflicts: true,
  });
  const lines: string[] = [];
  let conflict = false;
  for (const region of regions) {
    if (region.ok) {
      lines.push(...region.ok);
      continue;
    }
    const { a, o, b } = region.conflict!;
    if (o.length === 0) {
      lines.push(...unionLines(a, b));
      continue;
    }
    const byWord = mergeWords(o.join("\n"), a.join("\n"), b.join("\n"));
    if (byWord !== null) {
      lines.push(...byWord.split("\n"));
      continue;
    }
    conflict = true;
    lines.push(`<<<<<<< ${MERGE_LABEL_LOCAL}`, ...a, "=======", ...b, `>>>>>>> ${MERGE_LABEL_REMOTE}`);
  }
  return { text: lines.join("\n"), conflict };
}

// Both blocks, minus whatever they share at the start and end (two devices
// that added the same heading and then different items below it).
function unionLines(a: string[], b: string[]): string[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [...a.slice(0, a.length - tail), ...b.slice(head)];
}

// Words (any script — \w alone would shred Cyrillic), runs of whitespace,
// and single punctuation marks.
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_HUNK_TOKENS = 5000;

// Word-level 3-way merge of one hunk; null when the two sides touched the
// same words (including both inserting at the same position — unlike whole
// lines, two word insertions at one spot have no safe order).
function mergeWords(base: string, local: string, remote: string): string | null {
  const o = base.match(TOKEN) ?? [];
  const a = local.match(TOKEN) ?? [];
  const b = remote.match(TOKEN) ?? [];
  if (Math.max(o.length, a.length, b.length) > MAX_HUNK_TOKENS) return null;
  const out: string[] = [];
  for (const region of diff3Merge(a, o, b, { excludeFalseConflicts: true })) {
    if (!region.ok) return null;
    out.push(...region.ok);
  }
  return out.join("");
}

// Below this share of common lines, two same-named files with no shared
// history are treated as unrelated notes rather than versions of one.
const UNION_MIN_SIMILARITY = 0.5;

// Two-way merge for when there is NO base to merge against: the same path
// created independently on two devices (today's daily note), or a vault
// linked on a device that already had the files. Every line of both sides is
// kept, in order, with this device's lines first wherever they differ — git's
// "union" merge. A line edited on one side therefore shows up in both forms;
// `overlap` reports that this happened somewhere, i.e. the result may need a
// look. Returns null when the files share too little to be the same note, so
// the caller keeps both as separate files instead of interleaving them.
export function mergeUnion(local: string, remote: string): { text: string; overlap: boolean } | null {
  if (local.trim() === "") return { text: remote, overlap: false };
  if (remote.trim() === "") return { text: local, overlap: false };
  const a = local.split("\n");
  const b = remote.split("\n");
  const filled = (lines: string[]) => lines.filter((l) => l.trim() !== "").length;
  const lines: string[] = [];
  let common = 0;
  let overlap = false;
  for (const chunk of diffComm(a, b)) {
    if (chunk.common) {
      common += filled(chunk.common);
      lines.push(...chunk.common);
    } else {
      if (chunk.buffer1.length && chunk.buffer2.length) overlap = true;
      lines.push(...chunk.buffer1, ...chunk.buffer2);
    }
  }
  if (common < UNION_MIN_SIMILARITY * Math.min(filled(a), filled(b))) return null;
  return { text: lines.join("\n"), overlap };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameJson(x: Json | undefined, y: Json | undefined): boolean {
  return JSON.stringify(x) === JSON.stringify(y);
}

// Key-by-key merge of a settings file (.obsidian/*.json, plugin data.json).
// A key only one side changed takes that side's value; nested objects merge
// recursively; a key both sides changed to different values takes the
// remote's — settings have no meaningful "both", and the remote is the one
// every other device already agreed on. Arrays are values, not merged.
// Without a base, a key is "changed" on whichever side has it. Returns null
// when any side isn't a JSON object.
export function mergeJson(base: string | null, local: string, remote: string): string | null {
  let o: Json | undefined, a: Json, b: Json;
  try {
    o = base === null ? undefined : (JSON.parse(base) as Json);
    a = JSON.parse(local) as Json;
    b = JSON.parse(remote) as Json;
  } catch {
    return null;
  }
  if (!isObject(a) || !isObject(b)) return null;
  const indent = /^\{\r?\n(\s+)/.exec(local)?.[1] ?? /^\{\r?\n(\s+)/.exec(remote)?.[1];
  return JSON.stringify(mergeJsonObjects(isObject(o) ? o : undefined, a, b), null, indent);
}

function mergeJsonObjects(
  o: { [key: string]: Json } | undefined,
  a: { [key: string]: Json },
  b: { [key: string]: Json }
): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  // Remote's key order first: when nothing local changed the result is
  // byte-for-byte the remote file.
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const inA = key in a, inB = key in b;
    const ov = o?.[key], av = a[key], bv = b[key];
    let value: Json | undefined;
    if (inA && inB) {
      if (sameJson(av, bv)) value = bv;
      else if (isObject(av) && isObject(bv)) value = mergeJsonObjects(isObject(ov) ? ov : undefined, av, bv);
      else if (o && key in o && sameJson(bv, ov)) value = av; // only local changed it
      else value = bv;
    } else if (inA) {
      // Missing remotely: deleted there (drop it) unless local changed it since.
      value = o && key in o && sameJson(av, ov) ? undefined : av;
    } else {
      value = o && key in o && sameJson(bv, ov) ? undefined : bv;
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}
