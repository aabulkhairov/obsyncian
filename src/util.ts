export function base64Encode(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64Decode(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// "Notes/Idea.md" -> "Notes/Idea (conflict 2026-07-02 1130).md"
export function conflictPath(path: string, now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = path.slice(0, slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${base} (conflict ${stamp})${ext}`;
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

// Obsidian refuses to create files whose names contain these characters
// (its own API validation, all platforms). Files like that can still exist
// in a vault — created via Finder/Explorer — and sync UP fine from where
// they live, but no other device can ever write them.
export function hasForbiddenNameChars(path: string): boolean {
  return /[\\:*?"<>|]/.test(path);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
