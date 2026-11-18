// Obsyncian Publish, the author side: turn a selection of notes into a
// snapshot the server can serve at obsyncian.com/p/<slug>.
//
// Deliberately not built on the sync engine. Sync moves ciphertext, file by
// file; a publication is a plaintext copy of a chosen subset, sent as one
// atomic snapshot (plan §6):
//
//   1. build a manifest locally — pages with their markdown rewritten for the
//      server's renderer, and every attachment they reference, hashed
//   2. `plan` — the server answers with presigned PUTs for the objects it
//      doesn't have yet (content-addressed, so unchanged ones are skipped)
//   3. upload those, straight to storage
//   4. `commit` the full page set in chunks under one snapshot token; the
//      `final` chunk swaps the live site over in one go
//
// Everything here reads the vault through PublishSource, which hands back the
// notes as they are on disk. That is the whole of the encryption story: the
// sync codec is never involved, so an encrypted vault publishes the plaintext
// of exactly the notes that were picked, and nothing ciphertext-shaped can end
// up on a public page.
import { BoardMarker, MermaidMarker, boardScene, dataUrlBytes, diagramFence, isBoardPath, mermaidSources, mermaidType, parseBoard, replaceMermaid, standaloneSvg } from "./publishdiagrams";
import { ApiError, isConnectionLoss, type ApiClient, type PublishObjectInput, type PublishPageInput, type PublishSiteInfo } from "./api";
import { isExcluded, pool } from "./sync";
import { formatBytes, sha256Hex } from "./util";

// --- server contract (keep in step with server/app/...) ---------------------

// PublishRenderer::PAGE_PREFIX / ASSET_PREFIX: site-independent link targets
// the renderer resolves at request time.
export const PAGE_PREFIX = "/-/p/";
export const ASSET_PREFIX = "/-/o/";
// PublishPlan::MAX_OBJECTS_PER_CALL and PublishSnapshot::MAX_PAGES_PER_CHUNK.
export const MAX_OBJECTS_PER_PLAN = 2_000;
export const MAX_PAGES_PER_CHUNK = 500;
// What this plugin actually sends per commit: the plan's "~200 pages a call",
// and a byte ceiling so a chunk of long notes stays an ordinary-sized request.
export const COMMIT_CHUNK_PAGES = 200;
export const COMMIT_CHUNK_BYTES = 2 * 1024 * 1024;
export const UPLOAD_CONCURRENCY = 6;
// PublishPage::SLUG_FORMAT and PublishSite::SLUG_FORMAT.
export const PAGE_SLUG_FORMAT = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
export const SITE_SLUG_FORMAT = /^[a-z0-9][a-z0-9-]{1,48}$/;
export const RESERVED_SITE_SLUGS = new Set([
  "p", "a", "api", "v1", "admin", "kazakhstan", "login", "logout", "account", "auth", "pay", "webhooks",
  "help", "privacy", "encryption", "subscription", "sitemap", "robots", "up", "new", "edit",
  "gate", "assets", "static", "fonts", "img", "og", "www", "mail",
]);
// A digest no object can have. An image pointing at it renders as the
// renderer's "image missing" card, which is how an embed that couldn't be
// resolved stays visible to the author instead of vanishing.
const MISSING_DIGEST = "0".repeat(64);

// --- slugs ------------------------------------------------------------------

// Russian, plus the Ukrainian and Kazakh letters a Russian keyboard user is
// likely to meet. Simple scientific-ish romanisation: readable, not reversible.
// Must stay identical to PublishRenderer::CYRILLIC on the server.
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  є: "ye", і: "i", ї: "yi", ґ: "g",
  ә: "a", ғ: "g", қ: "q", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h",
};

// The slug a page is sent with, and — identically — what the server's
// PublishRenderer#slugify_target falls back to for a wikilink left behind:
// last path segment, `.md` dropped, lowercased, Cyrillic romanised, accents
// and other marks folded away (NFKD), every remaining run of anything but
// a-z/0-9 collapsed to one dash. ASCII by construction, as PublishPage's slug
// format and the reader route require. Empty for a name in, say, Japanese.
export function asciiSlug(target: string): string {
  const last = (target.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase();
  return last
    .replace(/[\u0400-\u04FF]/g, (ch) => CYRILLIC[ch] ?? ch)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// A slug for every page path, unique within the site. Flat (the note's own
// name, as the server's fallback assumes), with "-2", "-3"… for notes that
// share a name in different folders. Shallower notes go first (so a
// top-level "Note" keeps "note"), then path order — the same selection always
// produces the same slugs.
export function assignSlugs(paths: string[]): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  const depth = (p: string) => p.split("/").length;
  for (const path of [...paths].sort((a, b) => depth(a) - depth(b) || comparePaths(a, b))) {
    const base = asciiSlug(path) || "page";
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    out.set(path, slug);
  }
  return out;
}

// What a site slug typed into the create form becomes, and whether the
// server will take it. The same checks as PublishSite, so the form can say
// what's wrong before a round trip.
export function siteSlugProblem(slug: string): string | null {
  if (!SITE_SLUG_FORMAT.test(slug)) {
    return "Use 2–49 characters: lowercase letters, digits and dashes, starting with a letter or digit.";
  }
  if (RESERVED_SITE_SLUGS.has(slug)) return "That address is reserved — pick another.";
  return null;
}

// PublishRenderer#heading_id: what a heading's anchor becomes on the page.
// The renderer works on the heading's rendered text, so emphasis markers and
// link brackets are dropped first to land on the same words.
export function headingId(text: string): string {
  const plain = text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~=`]/g, "");
  const slug = plain.trim().toLowerCase().replace(/[^\p{Alphabetic}\p{Nd}]+/gu, "-").replace(/^-/, "").replace(/-$/, "");
  return slug || "section";
}

// --- selection --------------------------------------------------------------

// Which notes a site publishes: folder/file prefixes, matched the same way as
// the sync's excluded folders (isExcluded). The most specific rule that
// covers a path decides — so "Guide" in, "Guide/Drafts" out, works as people
// expect from a checkbox tree, and a new note added to a picked folder is
// picked too. "" is the whole vault.
export interface PublishSelection {
  include: string[];
  exclude: string[];
}

function ruleCovers(rule: string, path: string): boolean {
  return rule === "" || isExcluded(path, [rule]);
}

export function isSelected(sel: PublishSelection, path: string): boolean {
  let best = -1;
  let on = false;
  for (const rule of sel.include) {
    if (ruleCovers(rule, path) && rule.length > best) {
      best = rule.length;
      on = true;
    }
  }
  for (const rule of sel.exclude) {
    // An exclude for the same path as an include wins — it can't happen via
    // setSelected, but a hand-edited data.json shouldn't publish by accident.
    if (ruleCovers(rule, path) && rule.length >= best) {
      best = rule.length;
      on = false;
    }
  }
  return on;
}

// Ticking or unticking a folder or a note in the picker. Every rule at or
// below `path` is dropped (the new choice overrides them — that's "folders
// select descendants"), and a rule for `path` itself is added only if what's
// left doesn't already give the wanted answer, so the lists stay minimal.
export function setSelected(sel: PublishSelection, path: string, on: boolean): PublishSelection {
  const within = (rule: string) => path === "" || rule === path || rule.startsWith(path + "/");
  const next: PublishSelection = {
    include: sel.include.filter((r) => !within(r)),
    exclude: sel.exclude.filter((r) => !within(r)),
  };
  if (isSelected(next, path) !== on) (on ? next.include : next.exclude).push(path);
  return next;
}

export function emptySelection(): PublishSelection {
  return { include: [], exclude: [] };
}

// Only markdown notes become pages. Excalidraw drawings are markdown files
// too, but rendering one needs the Excalidraw plugin.
// TODO(P7): pre-render Excalidraw to SVG and publish it as a block.
export function isPublishableNote(path: string): boolean {
  return /\.md$/i.test(path) && !/\.excalidraw\.md$/i.test(path);
}

// --- the vault, as publishing sees it --------------------------------------

export interface SourceFile {
  path: string;
  size: number;
  mtime: number;
}

// The read-only slice of the vault publishing needs. obsidianSource() backs it
// with app.vault + metadataCache; tests back it with a Map.
export interface PublishSource {
  // Every file in the vault (config folder excluded, as Obsidian does).
  files(): SourceFile[];
  stat(path: string): SourceFile | null;
  // Plaintext, straight from disk.
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  // Obsidian's own link resolution: the vault path a link written in
  // `fromPath` points at, or null.
  resolve(linkpath: string, fromPath: string): string | null;
  // Pixel size of an image, when the platform can tell cheaply.
  imageSize?(data: ArrayBuffer, contentType: string): Promise<{ width: number; height: number } | null>;
  // A Mermaid block drawn as standalone SVG in each reader theme, or null if
  // it can't be (a syntax error) — see publishdiagrams.ts.
  renderMermaid?(code: string): Promise<{ light: string; dark: string } | null>;
  // A large image pasted into an Excalidraw board, shrunk for the web, or
  // null to keep it as it is.
  shrinkImage?(data: ArrayBuffer, contentType: string): Promise<{ data: ArrayBuffer; contentType: string } | null>;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
};
const OTHER_TYPES: Record<string, string> = {
  pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  txt: "text/plain", csv: "text/csv", zip: "application/zip",
};

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function contentTypeFor(path: string): string {
  const ext = extOf(path);
  return IMAGE_TYPES[ext] ?? OTHER_TYPES[ext] ?? "application/octet-stream";
}

export function isImage(path: string): boolean {
  return extOf(path) in IMAGE_TYPES;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stem(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

// Folders before files at each level would be nicer in a tree, but the
// sidebar is a flat list in this order — so plain path order, numbers sorted
// as numbers ("2 Setup" before "10 Launch").
export function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

// --- markdown rewriting ----------------------------------------------------

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^﻿/, "").replace(FRONTMATTER, "");
}

// PublishRenderer#mask_code, mirrored: fenced blocks and inline code are
// lifted out before any rewriting and put back after, so a note ABOUT
// wikilink syntax publishes verbatim.
const FENCE = /^([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
const MASK = "";

function maskCode(markdown: string, rewrite: (text: string) => string): string {
  const stashed: string[] = [];
  const stash = (match: string) => {
    stashed.push(match);
    return `${MASK}${stashed.length - 1}${MASK}`;
  };
  const masked = markdown.split(MASK).join("").replace(FENCE, stash).replace(INLINE_CODE, stash);
  return rewrite(masked).replace(new RegExp(`${MASK}(\\d+)${MASK}`, "g"), (_, i: string) => stashed[Number(i)]);
}

const WIKILINK = /(!?)\[\[([^\[\]|]*?)(?:\\?\|([^\[\]]*))?\]\]/g;
const MD_LINK = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
// Obsidian comments: never rendered in the app, often exactly the part of a
// note its author would not want on the internet.
const COMMENT = /%%[\s\S]*?%%/g;
// "^block-id" at the end of a line is link plumbing, hidden in the app.
const BLOCK_ID = /[ \t]\^[A-Za-z0-9-]+[ \t]*$/gm;
const SIZE_ONLY = /^\d+(x\d+)?$/;

export interface LinkContext {
  // Vault path of the note being rewritten.
  path: string;
  resolve(linkpath: string, fromPath: string): string | null;
  // Slug of a page in this publication, or undefined if it isn't in it.
  slugOf(path: string): string | undefined;
  // Digest of an uploaded attachment, or undefined if it couldn't be read.
  digestOf(path: string): string | undefined;
  // The marker for an embedded Excalidraw board (see publishdiagrams.ts), or
  // undefined when boards aren't being published.
  boardOf?(path: string): string | undefined;
}

function escapeLabel(text: string): string {
  return text.replace(/([\[\]\\])/g, "\\$1");
}

// An image's alt text, which the renderer also prints as its caption. Obsidian
// puts a display size where the alt would go ("|300", "alt|300x200"); a size
// is not a caption.
function altText(raw: string | null): string {
  const text = (raw ?? "").replace(/\|\s*\d+(x\d+)?\s*$/, "").trim();
  return SIZE_ONLY.test(text) ? "" : text;
}

function splitTarget(raw: string): { linkpath: string; subpath: string } {
  const hash = raw.indexOf("#");
  return hash === -1 ? { linkpath: raw.trim(), subpath: "" } : { linkpath: raw.slice(0, hash).trim(), subpath: raw.slice(hash + 1).trim() };
}

// "#Heading" → "#heading"; "#^block" and nested "#A#B" → the last heading.
function fragmentFor(subpath: string): string {
  if (!subpath || subpath.startsWith("^")) return "";
  const heading = subpath.split("#").pop() ?? "";
  return heading ? `#${headingId(heading)}` : "";
}

// One link or embed, resolved and rewritten into the renderer's form.
function rewriteTarget(ctx: LinkContext, embed: boolean, rawTarget: string, label: string | null, alias: string | null): string {
  const { linkpath, subpath } = splitTarget(rawTarget);

  // [[#Heading]] — a link within the same page.
  if (!linkpath) {
    const text = label ?? subpath.replace(/^\^/, "");
    const frag = fragmentFor(subpath);
    return frag ? `[${escapeLabel(text)}](${frag})` : escapeLabel(text);
  }

  const target = ctx.resolve(linkpath, ctx.path);
  const shown = label ?? (subpath && !subpath.startsWith("^") ? `${stem(linkpath)} > ${subpath.split("#").pop()}` : stem(linkpath));

  // An embedded Excalidraw board becomes a diagram card, on lines of its own.
  if (embed && target && isBoardPath(target)) {
    const marker = ctx.boardOf?.(target);
    if (marker) return `\n${marker}\n`;
  }

  if (target && !/\.md$/i.test(target) && !/\.excalidraw$/i.test(target)) {
    const digest = ctx.digestOf(target);
    if (embed && isImage(target)) {
      return `![${escapeLabel(altText(alias ?? label))}](${ASSET_PREFIX}${digest ?? MISSING_DIGEST})`;
    }
    return digest ? `[${escapeLabel(alias ?? label ?? basename(target))}](${ASSET_PREFIX}${digest})` : escapeLabel(shown);
  }

  if (!target && embed && isImage(linkpath)) {
    return `![${escapeLabel(altText(alias ?? label))}](${ASSET_PREFIX}${MISSING_DIGEST})`;
  }

  // A note. Embedding one (transclusion) degrades to a link for now.
  // TODO(P7): inline embedded notes, and pre-render Excalidraw drawings.
  const slug = target ? ctx.slugOf(target) : undefined;
  // Not in this publication: an empty page target, which the renderer shows
  // as a visibly unresolved link — never a guess that could land on another
  // page with a similar name.
  return `[${escapeLabel(shown)}](${PAGE_PREFIX}${slug ? slug + fragmentFor(subpath) : ""})`;
}

// Rewrites a note's body for the server: wikilinks, embeds and relative
// markdown links resolved against the vault, comments and block ids dropped.
// Code is left exactly as written.
export function rewriteMarkdown(body: string, ctx: LinkContext): string {
  return maskCode(body, (text) =>
    text
      .replace(COMMENT, "")
      .replace(BLOCK_ID, "")
      .replace(WIKILINK, (_m, bang: string, target: string, alias?: string) =>
        rewriteTarget(ctx, bang === "!", target.replace(/\\$/, ""), alias?.trim() || null, alias?.trim() || null)
      )
      .replace(MD_LINK, (whole, bang: string, label: string, dest: string) => {
        let raw = dest.startsWith("<") ? dest.slice(1, -1) : dest;
        // Absolute, external, same-page — and everything this pass itself
        // just wrote, which all starts with "/".
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/") || raw.startsWith("#")) return whole;
        try {
          raw = decodeURIComponent(raw);
        } catch {
          // a stray "%" — use it as typed
        }
        return rewriteTarget(ctx, bang === "!", raw, label, bang === "!" ? label : null);
      })
  );
}

// The Excalidraw boards a note embeds, resolved.
export function referencedBoards(body: string, path: string, resolve: (linkpath: string, from: string) => string | null): string[] {
  const found = new Set<string>();
  rewriteMarkdown(body, {
    path, resolve, slugOf: () => undefined, digestOf: () => undefined,
    boardOf: (target) => {
      found.add(target);
      return undefined;
    },
  });
  return [...found];
}

// The references a note makes to non-note files, resolved. Run before any
// rewriting so every attachment can be hashed first.
export function referencedFiles(body: string, path: string, resolve: (linkpath: string, from: string) => string | null): string[] {
  const found = new Set<string>();
  const ctx: LinkContext = {
    path,
    resolve: (linkpath, from) => {
      const target = resolve(linkpath, from);
      if (target && !/\.md$/i.test(target) && !/\.excalidraw$/i.test(target)) found.add(target);
      return target;
    },
    slugOf: () => undefined,
    digestOf: () => undefined,
  };
  rewriteMarkdown(body, ctx);
  return [...found];
}

// First H1 outside code, as it will read on the page.
export function titleFor(body: string, path: string): string {
  let title = "";
  maskCode(body, (text) => {
    const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(text);
    if (m && !m[1].includes(MASK)) title = m[1];
    return text;
  });
  const plain = title
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, (_m, _t: string, shown: string) => shown.replace(/^.*\//, ""))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return plain || stem(path);
}

// A line or two for search results and link previews: the first ordinary
// paragraph, markup stripped.
export function excerptFor(rewritten: string): string | undefined {
  let found: string | undefined;
  maskCode(rewritten, (text) => {
    for (const block of text.split(/\n\s*\n/)) {
      const line = block.trim();
      if (!line || /^(#|>|\||[-*+] |\d+\. |!\[|<|---|\*\*\*)/.test(line) || line.includes(MASK)) continue;
      const plain = line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\\([\[\]\\])/g, "$1")
        .replace(/[*_~=]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (plain) {
        found = plain.length > 200 ? plain.slice(0, 199).replace(/\s+\S*$/, "") + "…" : plain;
        break;
      }
    }
    return text;
  });
  return found;
}

// --- manifest ---------------------------------------------------------------

export interface PublishManifest {
  pages: PublishPageInput[];
  objects: PublishObjectInput[];
  // digest → the vault file whose bytes it is, for the upload step.
  sources: Map<string, string>;
  // digest → bytes made while building (diagram images, board scenes,
  // shrunk board images): uploaded from here, not read from the vault.
  generated: Map<string, ArrayBuffer>;
  notes: string[];
  attachments: string[];
  // Referenced but unreadable or empty — shown on the page as missing.
  skipped: string[];
  homePath?: string;
  bytes: number;
}

// Notes whose name says "start here" become the site's home page when they
// sit at the top of the selection; otherwise the server takes the first page.
const HOME_NAMES = /^(index|home|readme|welcome|start|главная|начало)$/i;

export interface BuildProgress {
  (done: number, total: number, phase: "reading" | "hashing"): void;
}

// Step 1 of the pipeline: everything the server needs, computed locally.
export async function buildManifest(source: PublishSource, sel: PublishSelection, onProgress: BuildProgress = () => {}): Promise<PublishManifest> {
  const notes = source.files()
    .filter((f) => isPublishableNote(f.path) && isSelected(sel, f.path))
    .sort((a, b) => sortKey(a.path).localeCompare(sortKey(b.path), undefined, { numeric: true, sensitivity: "base" }) || comparePaths(a.path, b.path));
  const slugs = assignSlugs(notes.map((n) => n.path));

  // Pass 1: read every note once, and find what it points at.
  const bodies = new Map<string, string>();
  const referenced = new Set<string>();
  const boardPaths = new Set<string>();
  for (const [i, note] of notes.entries()) {
    onProgress(i, notes.length, "reading");
    const body = stripFrontmatter(await source.read(note.path));
    bodies.set(note.path, body);
    for (const ref of referencedFiles(body, note.path, (l, f) => source.resolve(l, f))) referenced.add(ref);
    for (const board of referencedBoards(body, note.path, (l, f) => source.resolve(l, f))) boardPaths.add(board);
  }

  // Pass 2: hash the attachments. Bytes aren't kept — the few that turn out
  // to be missing on the server are read again at upload time.
  const objects = new Map<string, PublishObjectInput>();
  const sources = new Map<string, string>();
  const digests = new Map<string, string>();
  const attachments: string[] = [];
  const skipped: string[] = [];
  const refs = [...referenced].sort(comparePaths);
  for (const [i, path] of refs.entries()) {
    onProgress(i, refs.length, "hashing");
    const stat = source.stat(path);
    let data: ArrayBuffer | null = null;
    try {
      data = stat ? await source.readBinary(path) : null;
    } catch {
      data = null;
    }
    // PublishPlan refuses a zero-byte object, and one bad row fails the
    // whole call — an empty file is simply shown as missing.
    if (!data || data.byteLength === 0) {
      skipped.push(path);
      continue;
    }
    const digest = await sha256Hex(data);
    digests.set(path, digest);
    attachments.push(path);
    if (objects.has(digest)) continue; // same bytes under two names: stored once
    const contentType = contentTypeFor(path);
    const object: PublishObjectInput = { digest, byte_size: data.byteLength, content_type: contentType, kind: "asset", source_path: path };
    if (isImage(path) && source.imageSize) {
      const size = await source.imageSize(data, contentType).catch(() => null);
      if (size) Object.assign(object, size);
    }
    objects.set(digest, object);
    sources.set(digest, path);
  }

  // Bytes made here rather than read from the vault: each becomes an object
  // like any attachment, uploaded from memory.
  const generated = new Map<string, ArrayBuffer>();
  const addGenerated = async (data: ArrayBuffer, object: Omit<PublishObjectInput, "digest" | "byte_size">): Promise<string> => {
    const digest = await sha256Hex(data);
    if (!objects.has(digest)) {
      objects.set(digest, { digest, byte_size: data.byteLength, ...object });
      generated.set(digest, data);
    }
    return digest;
  };

  // Pass 2b: Excalidraw boards — scene data plus the images placed in them.
  const boards = new Map<string, string>(); // board path → its marker fence
  for (const path of [...boardPaths].sort(comparePaths)) {
    const title = stem(basename(path).replace(/\.excalidraw(\.md)?$/i, ""));
    let marker: BoardMarker = { kind: "excalidraw", scene: null, title };
    try {
      const board = parseBoard(await source.read(path), path);
      if (board) {
        const imageDigests = new Map<string, { digest: string; mimeType: string }>();
        const imagePaths: string[] = [];
        for (const [id, image] of board.images) {
          let data: ArrayBuffer | null = null;
          let mimeType = "image/png";
          if ("dataURL" in image) {
            data = dataUrlBytes(image.dataURL);
            mimeType = image.mimeType;
          } else {
            const file = source.resolve(image.linkpath, path);
            if (file && isImage(file)) {
              data = await source.readBinary(file).catch(() => null);
              mimeType = contentTypeFor(file);
              if (data?.byteLength) imagePaths.push(file);
            }
          }
          if (!data || data.byteLength === 0) continue;
          const smaller = source.shrinkImage ? await source.shrinkImage(data, mimeType).catch(() => null) : null;
          if (smaller) ({ data, contentType: mimeType } = smaller);
          imageDigests.set(id, { digest: await addGenerated(data, { content_type: mimeType, kind: "asset", source_path: path }), mimeType });
        }
        const scene = new TextEncoder().encode(boardScene(board, imageDigests)).buffer as ArrayBuffer;
        marker = { kind: "excalidraw", scene: await addGenerated(scene, { content_type: "application/json", kind: "block", source_path: path }), title };
        // Leaving the vault like any attachment, so the consent step lists them.
        for (const file of [path, ...imagePaths]) if (!attachments.includes(file)) attachments.push(file);
      }
    } catch {
      // unreadable: the card says the board wasn't published
    }
    if (!marker.scene) skipped.push(path);
    boards.set(path, diagramFence(marker));
  }

  // Pass 2c: Mermaid, drawn by Obsidian in both reader themes. A block that
  // fails to draw stays as code, and the page shows its source.
  const drawn = new Map<string, MermaidMarker>();
  if (source.renderMermaid) {
    const codes = [...new Set([...bodies.values()].flatMap(mermaidSources))];
    for (const code of codes) {
      const svgs = await source.renderMermaid(code).catch(() => null);
      const light = svgs && standaloneSvg(svgs.light);
      const dark = svgs && standaloneSvg(svgs.dark);
      if (!light || !dark) continue;
      const encode = (svg: string) => new TextEncoder().encode(svg).buffer as ArrayBuffer;
      const object = { content_type: "image/svg+xml", kind: "block" as const, width: light.width, height: light.height };
      drawn.set(code, {
        kind: "mermaid", type: mermaidType(code), width: light.width, height: light.height,
        light: await addGenerated(encode(light.svg), object),
        dark: await addGenerated(encode(dark.svg), { ...object, width: dark.width, height: dark.height }),
      });
    }
  }

  // Pass 3: rewrite and lay out the pages.
  const pages: PublishPageInput[] = notes.map((note, position) => {
    const body = replaceMermaid(bodies.get(note.path)!, drawn);
    const content = rewriteMarkdown(body, {
      path: note.path,
      resolve: (l, f) => source.resolve(l, f),
      slugOf: (p) => slugs.get(p),
      digestOf: (p) => digests.get(p),
      boardOf: (p) => boards.get(p),
    });
    const section = navSection(note.path);
    const page: PublishPageInput = {
      path: note.path,
      slug: slugs.get(note.path)!,
      title: titleFor(body, note.path),
      position,
      content_markdown: content,
      source_modified_at: new Date(note.mtime).toISOString(),
    };
    if (section) page.nav_section = section;
    const excerpt = excerptFor(content);
    if (excerpt) page.excerpt = excerpt;
    // TODO(P5): `gated` per page arrives with the gate; never sent before.
    return page;
  });

  const homePath = notes.find((n) => !n.path.includes("/") && HOME_NAMES.test(stem(n.path)))?.path;
  const bytes = pages.reduce((sum, p) => sum + utf8Length(p.content_markdown), 0) +
    [...objects.values()].reduce((sum, o) => sum + o.byte_size, 0);

  return { pages, objects: [...objects.values()], sources, generated, notes: notes.map((n) => n.path), attachments, skipped, homePath, bytes };
}

// Top-level folder → the sidebar section a page is listed under. Notes at the
// top of the vault have none and come first.
export function navSection(path: string): string | undefined {
  const slash = path.indexOf("/");
  return slash === -1 ? undefined : path.slice(0, slash);
}

// Sidebar order: top-level notes first (a home note before the rest), then
// each folder's notes together, as the sidebar starts a new section heading
// whenever the section changes.
function sortKey(path: string): string {
  if (path.includes("/")) return `2/${path}`;
  return HOME_NAMES.test(stem(path)) ? `0/${path}` : `1/${path}`;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// Cheap enough to run on every tick of the picker: counts what a selection
// would publish without reading any note. Attachments come from Obsidian's
// own link index, so this can differ slightly from the real build (which
// reads the text) — it's a running total, not the bill.
export function estimateSelection(
  files: SourceFile[],
  sel: PublishSelection,
  linksOf: (path: string) => string[]
): { notes: number; images: number; attachments: number; bytes: number } {
  let notes = 0;
  let bytes = 0;
  const attached = new Map<string, number>();
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of files) {
    if (!isPublishableNote(f.path) || !isSelected(sel, f.path)) continue;
    notes++;
    bytes += f.size;
    for (const target of linksOf(f.path)) {
      const t = byPath.get(target);
      if (t && !/\.md$/i.test(t.path) && !/\.excalidraw$/i.test(t.path)) attached.set(t.path, t.size);
    }
  }
  let images = 0;
  for (const [path, size] of attached) {
    if (isImage(path)) images++;
    bytes += size;
  }
  return { notes, images, attachments: attached.size, bytes };
}

// --- consent ----------------------------------------------------------------

// Paths (notes and attachments) the author has agreed to make public for a
// site. Anything in a new build that isn't in here needs a fresh yes — the
// first publish, and every time the selection grows.
export function newSinceConsent(manifest: Pick<PublishManifest, "notes" | "attachments">, consented: string[]): string[] {
  const agreed = new Set(consented);
  return [...manifest.notes, ...manifest.attachments].filter((p) => !agreed.has(p));
}

// --- upload & commit ---------------------------------------------------------

export interface PublishProgress {
  phase: "planning" | "uploading" | "saving" | "finishing";
  done: number;
  total: number;
  text: string;
}

export interface PublishOutcome {
  site: PublishSiteInfo;
  uploaded: number;
  skippedKnown: number;
  pages: number;
}

function newSnapshotToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Page chunks for `commit`: at most COMMIT_CHUNK_PAGES each, and closed early
// once their markdown passes COMMIT_CHUNK_BYTES (a single huge note still
// gets a chunk to itself).
export function chunkPages(pages: PublishPageInput[], maxPages = COMMIT_CHUNK_PAGES, maxBytes = COMMIT_CHUNK_BYTES): PublishPageInput[][] {
  const out: PublishPageInput[][] = [];
  let current: PublishPageInput[] = [];
  let bytes = 0;
  for (const page of pages) {
    const size = utf8Length(page.content_markdown);
    if (current.length && (current.length >= maxPages || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(page);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

type PublishApi = Pick<ApiClient, "publishPlan" | "publishCommit" | "putPublishObject">;

// Steps 2–4: plan, upload what's missing, commit, promote. The live site is
// untouched until the final commit succeeds — a failure anywhere before that
// leaves the previous publication serving as it was.
export async function publishManifest(
  api: PublishApi,
  siteId: number,
  manifest: PublishManifest,
  source: Pick<PublishSource, "readBinary">,
  onProgress: (p: PublishProgress) => void = () => {}
): Promise<PublishOutcome> {
  if (!manifest.pages.length) throw new ApiError(0, "nothing_to_publish", "Nothing is selected for this site.");
  const snapshot = newSnapshotToken();
  const byDigest = new Map(manifest.objects.map((o) => [o.digest, o]));

  // Plans `objects` and uploads whatever the server doesn't already have.
  const planAndUpload = async (objects: PublishObjectInput[]): Promise<{ uploaded: number; known: number }> => {
    const uploads: { digest: string; put_url: string }[] = [];
    let known = 0;
    const batches = chunk(objects, MAX_OBJECTS_PER_PLAN);
    for (const [i, batch] of batches.entries()) {
      onProgress({ phase: "planning", done: i, total: batches.length, text: "Checking what the server already has…" });
      const plan = await api.publishPlan(siteId, snapshot, batch);
      uploads.push(...plan.uploads);
      known += plan.known.length;
    }

    const totalBytes = uploads.reduce((sum, u) => sum + (byDigest.get(u.digest)?.byte_size ?? 0), 0);
    let doneFiles = 0;
    let doneBytes = 0;
    const report = () =>
      onProgress({
        phase: "uploading", done: doneFiles, total: uploads.length,
        text: `Uploading ${doneFiles}/${uploads.length} files (${formatBytes(doneBytes)} of ${formatBytes(totalBytes)})`,
      });
    if (uploads.length) report();
    await pool(uploads, UPLOAD_CONCURRENCY, async (upload) => {
      const object = byDigest.get(upload.digest);
      const made = manifest.generated?.get(upload.digest);
      const path = manifest.sources.get(upload.digest) ?? object?.source_path;
      if (!object || (!made && !manifest.sources.has(upload.digest))) {
        throw new Error(`The server asked for a file this publication doesn't have (${upload.digest.slice(0, 12)}).`);
      }
      const data = made ?? await source.readBinary(path!);
      // The PUT is signed for the planned length; a file edited since it was
      // hashed would be refused by storage anyway, with a less useful error.
      if (data.byteLength !== object.byte_size) {
        throw new ApiError(0, "changed_while_publishing", `"${path}" changed while publishing — publish again to pick up the new version.`);
      }
      await api.putPublishObject(upload.put_url, data, object.content_type);
      doneFiles++;
      doneBytes += data.byteLength;
      report();
    });
    return { uploaded: uploads.length, known };
  };

  const { uploaded, known } = await planAndUpload(manifest.objects);

  const chunks = chunkPages(manifest.pages);
  let result: Awaited<ReturnType<PublishApi["publishCommit"]>> | null = null;
  for (const [i, pages] of chunks.entries()) {
    const final = i === chunks.length - 1;
    onProgress({
      phase: final ? "finishing" : "saving", done: i, total: chunks.length,
      text: final ? "Going live…" : `Sending pages ${i + 1}/${chunks.length}…`,
    });
    const body = { snapshot, pages, final, ...(final && manifest.homePath ? { home_path: manifest.homePath } : {}) };
    try {
      result = await api.publishCommit(siteId, body);
    } catch (e) {
      // An upload the server can't find in storage (a PUT that silently
      // didn't land, or an expired URL): plan those again under the same
      // snapshot, upload them, and try the final call once more.
      if (!(final && e instanceof ApiError && e.code === "missing_uploads")) throw e;
      const missing = Array.isArray(e.details.digests) ? (e.details.digests as string[]) : [];
      const retry = missing.map((d) => byDigest.get(d)).filter((o): o is PublishObjectInput => !!o);
      if (!retry.length) throw e;
      await planAndUpload(retry);
      onProgress({ phase: "finishing", done: i, total: chunks.length, text: "Going live…" });
      result = await api.publishCommit(siteId, body);
    }
  }

  if (!result || !("published" in result)) throw new Error("The server didn't confirm the publication.");
  onProgress({ phase: "finishing", done: chunks.length, total: chunks.length, text: "Published" });
  return { site: result, uploaded, skippedKnown: known, pages: manifest.pages.length };
}

// The whole "Publish" button: build, ask for consent if anything would become
// public that the author hasn't agreed to yet, then upload and commit. The
// consent is recorded before the upload starts — the author agreed to these
// exact paths, so a retry after a dropped connection doesn't ask again.
// Nothing reaches the server before `ask` says yes.
export async function publishSelection(opts: {
  api: PublishApi;
  siteId: number;
  local: { selection: PublishSelection; consented: string[] };
  source: PublishSource;
  ask: (manifest: PublishManifest, fresh: string[], grown: boolean) => Promise<boolean>;
  save: () => Promise<void>;
  onBuild?: BuildProgress;
  onProgress?: (p: PublishProgress) => void;
}): Promise<{ manifest: PublishManifest; outcome: PublishOutcome | null }> {
  const manifest = await buildManifest(opts.source, opts.local.selection, opts.onBuild);
  if (!manifest.pages.length) throw new ApiError(0, "nothing_to_publish", "Nothing is selected for this site.");

  const fresh = newSinceConsent(manifest, opts.local.consented);
  if (fresh.length) {
    if (!(await opts.ask(manifest, fresh, opts.local.consented.length > 0))) return { manifest, outcome: null };
    opts.local.consented = [...manifest.notes, ...manifest.attachments];
    await opts.save();
  }

  const outcome = await publishManifest(opts.api, opts.siteId, manifest, opts.source, opts.onProgress);
  return { manifest, outcome };
}

// --- errors -------------------------------------------------------------------

const UPGRADE_HINT = "To raise it, open the Obsyncian bot and run /upgrade, or see obsyncian.com/subscription.";

// What to tell the author when a publish (or a site operation) fails. Billing
// limits name the way out; protocol errors say plainly that it's a bug.
export function publishErrorMessage(e: unknown): string {
  if (isConnectionLoss(e)) return "No connection to the server. Nothing changed on your site — try again when you're back online.";
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  switch (e.code) {
    case "publish_not_on_plan":
      return `Publishing is available on paid plans. ${UPGRADE_HINT}`;
    case "publish_site_limit_reached":
      return `${e.message} Delete a site you no longer need, or upgrade. ${UPGRADE_HINT}`;
    case "private_sites_not_on_plan":
      return `Private sites are available on Standard and Plus. Switch Private off to keep the site public, or upgrade. ${UPGRADE_HINT}`;
    case "publish_bytes_exceeded":
      return `This publication is bigger than your plan's publishing allowance. Unselect some notes or large attachments, or upgrade. ${UPGRADE_HINT}`;
    case "file_too_large":
      return `${e.message} Remove that attachment from the selected notes, or upgrade. ${UPGRADE_HINT}`;
    case "too_many_objects":
    case "too_many_pages":
      return `The server refused a batch as too large (${e.message}). Your site wasn't changed — please update Syncian, and report this if it persists.`;
    case "nothing_to_publish":
      return "Nothing is selected for this site — choose some notes first.";
    case "missing_uploads":
      return "Some files didn't reach storage even after a retry. Your site wasn't changed — try publishing again.";
    case "payment_required":
      return `Your account has no active plan. ${UPGRADE_HINT}`;
    case "not_found":
      return "This site no longer exists on the server — it may have been deleted elsewhere.";
    default:
      return e.message;
  }
}
