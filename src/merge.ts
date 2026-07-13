import { diff3Merge, merge as diff3TwoWay } from "node-diff3";

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

// Three-way merge that ALWAYS returns text — nothing is ever lost. Disjoint
// edits merge cleanly (identical concurrent edits collapse via
// excludeFalseConflicts); overlapping edits are preserved inline with
// git-style <<<<<<< / ======= / >>>>>>> markers. `conflict` reports whether
// any markers were inserted, so the caller can flag the file for review.
export function merge3Markers(
  base: string,
  local: string,
  remote: string
): { text: string; conflict: boolean } {
  const { conflict, result } = diff3TwoWay(local.split("\n"), base.split("\n"), remote.split("\n"), {
    excludeFalseConflicts: true,
    label: { a: MERGE_LABEL_LOCAL, b: MERGE_LABEL_REMOTE },
  });
  return { text: result.join("\n"), conflict };
}
