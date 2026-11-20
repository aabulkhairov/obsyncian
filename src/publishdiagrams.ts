import LZString from "lz-string";

// Diagrams in a publication: Mermaid blocks and embedded Excalidraw boards.
//
// Mermaid is drawn by the author's own Obsidian while publishing (see
// PublishSource.renderMermaid), once per reader theme, and goes up as two SVG
// files. Readers get finished images: no diagram code runs on the site.
//
// An Excalidraw board goes up as its own scene data, read straight from the
// drawing file — no Excalidraw plugin needed — and the site shows it in the
// real Excalidraw viewer, read-only. Images pasted into a board go up as
// ordinary attachments.
//
// Either way the note's markdown gets a marker in place of the block or the
// embed, which the server's PublishRenderer turns into the diagram card:
//
//   ```obsyncian-diagram
//   {"kind":"mermaid","light":"<sha256>","dark":"<sha256>","width":640,"height":220,"type":"flowchart"}
//   ```
//
// A Mermaid block that couldn't be drawn is left as it was; the renderer
// shows its source in a card saying so.

export const DIAGRAM_FENCE = "obsyncian-diagram";

export interface MermaidMarker {
  kind: "mermaid";
  light: string;
  dark: string;
  width: number;
  height: number;
  type: string;
}

export interface BoardMarker {
  kind: "excalidraw";
  scene: string | null; // null: the board couldn't be published
  title: string;
  page?: boolean; // the board is the whole page: shown large
}

export function diagramFence(marker: MermaidMarker | BoardMarker): string {
  return "```" + DIAGRAM_FENCE + "\n" + JSON.stringify(marker) + "\n```";
}

// --- Mermaid ------------------------------------------------------------------

const MERMAID_BLOCK = /^([ \t]*)(```+|~~~+)[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n\1\2[ \t]*$/gim;

// The source of every Mermaid block in a note, in order.
export function mermaidSources(markdown: string): string[] {
  return [...markdown.matchAll(MERMAID_BLOCK)].map((m) => m[3]);
}

// Replaces each Mermaid block whose source was drawn with its marker; the
// rest stay exactly as written.
export function replaceMermaid(markdown: string, drawn: Map<string, MermaidMarker>): string {
  return markdown.replace(MERMAID_BLOCK, (whole, indent: string, _fence: string, code: string) => {
    const marker = drawn.get(code);
    return marker ? indent + diagramFence(marker) : whole;
  });
}

// The diagram type, for the card's label: the first word that isn't a
// directive, comment or front matter.
export function mermaidType(code: string): string {
  const line = code
    .replace(/^---[\s\S]*?\n---\s*\n/, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("%%"));
  return (line?.split(/[\s;]/)[0] ?? "diagram").slice(0, 40);
}

// Unquoted: Mermaid drops a font list with quotes in it from its stylesheet.
const DIAGRAM_FONT = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

// Mermaid's SVG is sized for an HTML page (width="100%", a max-width style).
// Served as a standalone image it needs real dimensions, taken from its
// viewBox, and its namespace.
export function standaloneSvg(svg: string): { svg: string; width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) return null;
  const viewBox = /\bviewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/i.exec(open[0]);
  if (!viewBox) return null;
  const width = Math.ceil(Number(viewBox[3]));
  const height = Math.ceil(Number(viewBox[4]));
  if (!(width > 0 && height > 0)) return null;
  let tag = open[0]
    .replace(/\s(width|height)="[^"]*"/gi, "")
    .replace(/\sstyle="[^"]*"/i, "");
  // A font for the labels even if Mermaid's stylesheet sets none: an <img>
  // otherwise draws SVG text in the browser's serif default.
  if (!/\sfont-family="/i.test(tag)) tag = tag.replace(/^<svg/i, `<svg font-family="${DIAGRAM_FONT}"`);
  if (!/\sxmlns="/i.test(tag)) tag = tag.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  tag = tag.replace(/>$/, ` width="${width}" height="${height}">`);
  return { svg: svg.replace(open[0], tag), width, height };
}

// The reader's two colour schemes (shared/_publish_head on the server),
// applied per diagram. Not via mermaid.initialize(): Obsidian's Mermaid
// instance is shared with its own editor. Labels as SVG text, not HTML: an
// SVG shown through <img> can't be relied on to lay out HTML inside it.
export function mermaidConfig(theme: "light" | "dark"): Record<string, unknown> {
  const p = theme === "light"
    ? { bg: "#ffffff", ink: "#16161b", body: "#32333a", muted: "#6c6d76", line: "#e2e2e8", accent: "#6542e0", soft: "#efeafe", code: "#f3f3f7" }
    : { bg: "#141418", ink: "#ededf2", body: "#c8c8d1", muted: "#8d8e97", line: "#26262d", accent: "#a38bff", soft: "#241f38", code: "#1b1b21" };
  return {
    theme: "base",
    // Both spellings: newer Mermaid reads the top-level one, older the
    // flowchart one.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    themeVariables: {
      darkMode: theme === "dark",
      fontFamily: DIAGRAM_FONT,
      background: p.code, primaryColor: p.soft, primaryTextColor: p.ink, primaryBorderColor: p.accent,
      secondaryColor: p.bg, tertiaryColor: p.bg, lineColor: p.muted, textColor: p.body,
      actorBkg: p.soft, actorBorder: p.accent, actorTextColor: p.ink, signalColor: p.muted, signalTextColor: p.body,
      noteBkgColor: p.bg, noteBorderColor: p.line, noteTextColor: p.body, edgeLabelBackground: p.code,
      labelBackground: p.code, clusterBkg: p.bg, clusterBorder: p.line, titleColor: p.ink,
    },
  };
}

// The block's source with that config attached, as front matter — the form
// Mermaid applies in full (an %%{init}%% directive leaves flowchart labels as
// HTML in Mermaid 11). Merged into the author's own front matter if the block
// has some; if that already sets a config of its own, theirs stays and ours
// goes in as a directive, which still themes the diagram.
export function mermaidWithTheme(code: string, theme: "light" | "dark"): string {
  const config = JSON.stringify(mermaidConfig(theme));
  const front = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(code);
  if (!front) return `---\nconfig: ${config}\n---\n${code}`;
  if (/^config\s*:/m.test(front[1])) return front[0] + `%%{init: ${config}}%%\n` + code.slice(front[0].length);
  return `---\nconfig: ${config}\n${front[1]}\n---\n` + code.slice(front[0].length);
}

// --- Excalidraw ---------------------------------------------------------------

export function isBoardPath(path: string): boolean {
  return /\.excalidraw(\.md)?$/i.test(path);
}

export interface BoardSource {
  elements: Record<string, unknown>[];
  viewBackgroundColor: string;
  // Images placed in the board: file id → where its bytes are.
  images: Map<string, { linkpath: string } | { dataURL: string; mimeType: string }>;
}

// Reads a drawing the way the Excalidraw plugin stores it: a `.excalidraw.md`
// note with the scene in a ```compressed-json (or plain ```json) block and
// its images listed under "## Embedded Files", or a bare `.excalidraw` JSON
// file. Null if there's no scene in it.
export function parseBoard(text: string, path: string): BoardSource | null {
  let scene: { elements?: unknown; appState?: { viewBackgroundColor?: unknown }; files?: unknown } | null = null;
  try {
    if (/\.excalidraw$/i.test(path)) {
      scene = JSON.parse(text);
    } else {
      const compressed = /^```compressed-json[ \t]*\r?\n([\s\S]*?)\r?\n```/m.exec(text);
      const plain = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```/m.exec(text);
      if (compressed) scene = JSON.parse(LZString.decompressFromBase64(compressed[1].replace(/\s+/g, "")) ?? "null");
      else if (plain) scene = JSON.parse(plain[1]);
    }
  } catch {
    return null;
  }
  if (!scene || !Array.isArray(scene.elements)) return null;

  const images: BoardSource["images"] = new Map();
  const files = (scene.files && typeof scene.files === "object" ? scene.files : {}) as Record<string, { dataURL?: unknown; mimeType?: unknown }>;
  for (const [id, file] of Object.entries(files)) {
    if (typeof file?.dataURL === "string" && file.dataURL.startsWith("data:")) {
      images.set(id, { dataURL: file.dataURL, mimeType: typeof file.mimeType === "string" ? file.mimeType : "image/png" });
    }
  }
  const embedded = /^#+ Embedded [Ff]iles[ \t]*\r?\n([\s\S]*?)(?=^#|^%%|$(?![\s\S]))/m.exec(text);
  if (embedded) {
    for (const line of embedded[1].split("\n")) {
      const m = /^([\w-]+):\s*(?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|(\S.*?))\s*$/i.exec(line.trim());
      if (m && !images.has(m[1])) images.set(m[1], { linkpath: (m[2] ?? m[3]).trim() });
    }
  }

  const bg = scene.appState?.viewBackgroundColor;
  return {
    elements: scene.elements as Record<string, unknown>[],
    viewBackgroundColor: typeof bg === "string" ? bg : "#ffffff",
    images,
  };
}

// What may leave the vault, element by element: no deleted elements, no
// embedded web pages or notes (they'd load third-party content on the site, or
// the inside of other notes), and only plain web links — an Obsidian link
// means nothing to a reader.
const DROPPED_TYPES = new Set(["embeddable", "iframe"]);

export function publishableElements(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  return elements
    .filter((e) => !e.isDeleted && !DROPPED_TYPES.has(String(e.type)))
    .map((e) => {
      const out: Record<string, unknown> = { ...e };
      delete out.customData;
      if (typeof out.link !== "string" || !/^https?:\/\//i.test(out.link)) out.link = null;
      return out;
    });
}

// The scene file that goes up: elements, background, and each image's file
// id → the attachment that holds it (the site loads those as it shows the
// board). Image elements whose file didn't make it are dropped rather than
// left as broken frames.
export function boardScene(
  board: BoardSource,
  imageDigests: Map<string, { digest: string; mimeType: string }>
): string {
  const elements = publishableElements(board.elements).filter(
    (e) => e.type !== "image" || (typeof e.fileId === "string" && imageDigests.has(e.fileId))
  );
  const files: Record<string, { id: string; mimeType: string; asset: string }> = {};
  for (const e of elements) {
    if (e.type !== "image") continue;
    const id = e.fileId as string;
    const image = imageDigests.get(id)!;
    files[id] = { id, mimeType: image.mimeType, asset: image.digest };
  }
  return JSON.stringify({ type: "excalidraw", version: 2, elements, appState: { viewBackgroundColor: board.viewBackgroundColor }, files });
}

// The words on a board, in drawing order: a board page's search text and
// link preview.
export function boardText(board: BoardSource): string {
  return publishableElements(board.elements)
    .filter((e) => e.type === "text" && typeof e.text === "string")
    .map((e) => String(e.text).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

export function dataUrlBytes(dataURL: string): ArrayBuffer | null {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(dataURL);
  if (!m) return null;
  if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2])).buffer as ArrayBuffer;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// The id Mermaid draws a diagram under ends up all over its SVG (the <svg>
// id, every scoped style rule, marker ids). A random one made every publish
// produce new bytes, so every diagram was re-uploaded on every update and
// the previous copies purged. Derived from the code and theme instead: the
// same diagram draws to the same bytes and the server already has it.
export function mermaidRenderId(code: string, theme: "light" | "dark"): string {
  let h = 0x811c9dc5; // FNV-1a, 32-bit
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `obsyncian-publish-${theme}-${h.toString(36)}`;
}
