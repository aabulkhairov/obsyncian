import LZString from "lz-string";
import { describe, expect, it } from "vitest";
import {
  boardScene, dataUrlBytes, diagramFence, mermaidWithTheme, mermaidSources, mermaidType, parseBoard,
  publishableElements, replaceMermaid, standaloneSvg, type MermaidMarker,
} from "../src/publishdiagrams";

const FLOW = "flowchart LR\n  A[Лид] --> B{Ответил?}";

describe("mermaid blocks", () => {
  it("finds each block's source, leaving other code alone", () => {
    const md = "Intro\n\n```mermaid\n" + FLOW + "\n```\n\n```js\nmermaid()\n```\n\n~~~ mermaid\nsequenceDiagram\n  A->>B: hi\n~~~\n";
    expect(mermaidSources(md)).toEqual([FLOW, "sequenceDiagram\n  A->>B: hi"]);
  });

  it("replaces drawn blocks with a marker and keeps the rest as written", () => {
    const marker: MermaidMarker = { kind: "mermaid", light: "a".repeat(64), dark: "b".repeat(64), width: 300, height: 100, type: "flowchart" };
    const md = "```mermaid\n" + FLOW + "\n```\n\n```mermaid\ngraph TD\n  broken[\n```";
    const out = replaceMermaid(md, new Map([[FLOW, marker]]));
    expect(out).toBe(diagramFence(marker) + "\n\n```mermaid\ngraph TD\n  broken[\n```");
    expect(out).toContain("```obsyncian-diagram\n{\"kind\":\"mermaid\"");
  });

  it("names the diagram type past directives and front matter", () => {
    expect(mermaidType(FLOW)).toBe("flowchart");
    expect(mermaidType("%%{init: {}}%%\nsequenceDiagram\n  A->>B: x")).toBe("sequenceDiagram");
    expect(mermaidType("---\ntitle: X\n---\ngantt\n  title Y")).toBe("gantt");
  });

  it("themes each diagram through front matter, with SVG labels", () => {
    const dark = mermaidWithTheme(FLOW, "dark");
    expect(dark.startsWith("---\nconfig: {")).toBe(true);
    expect(dark.endsWith("\n---\n" + FLOW)).toBe(true);
    const config = JSON.parse(/^---\nconfig: (.*)\n---\n/.exec(dark)![1]);
    expect(config).toMatchObject({ theme: "base", htmlLabels: false, flowchart: { htmlLabels: false }, themeVariables: { darkMode: true } });
  });

  it("merges into the author's own front matter, and leaves their own config alone", () => {
    const titled = "---\ntitle: Funnel\n---\n" + FLOW;
    const merged = mermaidWithTheme(titled, "light");
    expect(merged).toMatch(/^---\nconfig: \{.*\}\ntitle: Funnel\n---\nflowchart LR/);
    const own = "---\nconfig:\n  theme: forest\n---\n" + FLOW;
    expect(mermaidWithTheme(own, "light")).toMatch(/^---\nconfig:\n  theme: forest\n---\n%%\{init: \{.*\}\}%%\nflowchart LR/);
  });

  it("turns Mermaid's page-sized SVG into a standalone image with real dimensions", () => {
    const raw = '<svg id="m1" width="100%" style="max-width: 640.5px;" viewBox="-8 -8 640.5 220.25" role="graphics-document"><g/></svg>';
    const out = standaloneSvg(raw)!;
    expect(out.width).toBe(641);
    expect(out.height).toBe(221);
    expect(out.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" id="m1" viewBox="-8 -8 640.5 220.25" role="graphics-document" width="641" height="221"><g/></svg>');
    expect(standaloneSvg('<svg font-family="serif" viewBox="0 0 10 10"/>')!.svg).not.toContain("system-ui");
    expect(standaloneSvg("<div/>")).toBeNull();
  });
});

describe("excalidraw boards", () => {
  const scene = {
    type: "excalidraw", version: 2,
    elements: [
      { id: "r1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, link: "https://example.com" },
      { id: "t1", type: "text", text: "Hi", link: "[[Secret note]]", customData: { mine: 1 } },
      { id: "i1", type: "image", fileId: "f1" },
      { id: "i2", type: "image", fileId: "f-gone" },
      { id: "e1", type: "embeddable", link: "https://youtube.com/x" },
      { id: "d1", type: "rectangle", isDeleted: true },
    ],
    appState: { viewBackgroundColor: "#fffce8", zoom: { value: 3 } },
    files: { f2: { id: "f2", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=" } },
  };
  const note = (body: string) =>
    `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n\n## Text Elements\nHi ^t1\n\n## Embedded Files\nf1: [[Pictures/shot.png]]\n\nf3: Pictures/other.jpg\n\n%%\n## Drawing\n${body}\n%%\n`;

  it("reads the plugin's compressed format and its embedded files list", () => {
    const compressed = LZString.compressToBase64(JSON.stringify(scene)).replace(/(.{64})/g, "$1\n\n");
    const board = parseBoard(note("```compressed-json\n" + compressed + "\n```"), "Boards/Путь.excalidraw.md")!;
    expect(board.elements).toHaveLength(6);
    expect(board.viewBackgroundColor).toBe("#fffce8");
    expect(board.images.get("f1")).toEqual({ linkpath: "Pictures/shot.png" });
    expect(board.images.get("f3")).toEqual({ linkpath: "Pictures/other.jpg" });
    expect(board.images.get("f2")).toEqual({ dataURL: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" });
  });

  it("reads an uncompressed board, and a bare .excalidraw file", () => {
    expect(parseBoard(note("```json\n" + JSON.stringify(scene) + "\n```"), "B.excalidraw.md")?.elements).toHaveLength(6);
    expect(parseBoard(JSON.stringify(scene), "B.excalidraw")?.elements).toHaveLength(6);
    expect(parseBoard("# just a note", "B.excalidraw.md")).toBeNull();
    expect(parseBoard(note("```compressed-json\nnot base64!!\n```"), "B.excalidraw.md")).toBeNull();
  });

  it("publishes only what's safe to: no deleted elements, no web embeds, only web links", () => {
    const out = publishableElements(scene.elements);
    expect(out.map((e) => e.id)).toEqual(["r1", "t1", "i1", "i2"]);
    expect(out[0].link).toBe("https://example.com");
    expect(out[1].link).toBeNull();
    expect(out[1].customData).toBeUndefined();
  });

  it("points each image at its uploaded attachment, and drops images that didn't make it", () => {
    const board = parseBoard(JSON.stringify(scene), "B.excalidraw")!;
    const out = JSON.parse(boardScene(board, new Map([["f1", { digest: "c".repeat(64), mimeType: "image/webp" }]])));
    expect(out.elements.map((e: { id: string }) => e.id)).toEqual(["r1", "t1", "i1"]);
    expect(out.files).toEqual({ f1: { id: "f1", mimeType: "image/webp", asset: "c".repeat(64) } });
    expect(out.appState).toEqual({ viewBackgroundColor: "#fffce8" });
  });

  it("decodes data URLs", () => {
    expect(new Uint8Array(dataUrlBytes("data:image/png;base64,AAEC")!)).toEqual(new Uint8Array([0, 1, 2]));
    expect(new TextDecoder().decode(dataUrlBytes("data:image/svg+xml,%3Csvg%2F%3E")!)).toBe("<svg/>");
    expect(dataUrlBytes("https://x")).toBeNull();
  });
});
