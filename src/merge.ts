import { diff3Merge } from "node-diff3";

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
