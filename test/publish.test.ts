import { readFileSync } from "fs";
import LZString from "lz-string";
import { resolve as resolvePath } from "path";
import { describe, expect, it } from "vitest";
import { ApiError, type ApiClient } from "../src/api";
import {
  ASSET_PREFIX,
  COMMIT_CHUNK_PAGES,
  PAGE_SLUG_FORMAT,
  UPLOAD_CONCURRENCY,
  asciiSlug,
  assignSlugs,
  buildManifest,
  chunkPages,
  emptySelection,
  estimateSelection,
  headingId,
  isSelected,
  newSinceConsent,
  publishErrorMessage,
  publishManifest,
  publishSelection,
  setSelected,
  siteSlugProblem,
  stripFrontmatter,
  type PublishSelection,
  type PublishSource,
  type SourceFile,
} from "../src/publish";
import { buildTree } from "../src/publishview";
import { sha256Hex } from "../src/util";
import { FakePublishApi } from "./fake-publish-api";

// A vault in a Map, with link resolution close enough to Obsidian's
// getFirstLinkpathDest: exact path, then path + ".md", then by file name.
class MemorySource implements PublishSource {
  data = new Map<string, Uint8Array>();
  private tick = 1_700_000_000_000;
  mtimes = new Map<string, number>();

  note(path: string, text: string): this {
    return this.bin(path, new TextEncoder().encode(text));
  }
  bin(path: string, bytes: Uint8Array | number[]): this {
    this.data.set(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    this.mtimes.set(path, (this.tick += 1000));
    return this;
  }
  files(): SourceFile[] {
    return [...this.data.keys()].map((p) => this.stat(p)!);
  }
  stat(path: string): SourceFile | null {
    const d = this.data.get(path);
    return d ? { path, size: d.byteLength, mtime: this.mtimes.get(path)! } : null;
  }
  async read(path: string): Promise<string> {
    return new TextDecoder().decode(this.data.get(path));
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const d = this.data.get(path);
    if (!d) throw new Error(`no ${path}`);
    return d.slice().buffer;
  }
  resolve(linkpath: string): string | null {
    if (this.data.has(linkpath)) return linkpath;
    if (this.data.has(`${linkpath}.md`)) return `${linkpath}.md`;
    const name = linkpath.split("/").pop()!;
    for (const p of this.data.keys()) {
      const base = p.split("/").pop()!;
      if (base === name || base === `${name}.md`) return p;
    }
    return null;
  }
}

function sel(include: string[], exclude: string[] = []): PublishSelection {
  return { include, exclude };
}

async function digestOf(text: string | number[]): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text);
  return sha256Hex(bytes.slice().buffer);
}

function api(fake: FakePublishApi): Pick<ApiClient, "publishPlan" | "publishCommit" | "putPublishObject"> {
  return fake as unknown as ApiClient;
}

describe("slugs", () => {
  // Outputs of the server's PublishRenderer#slugify_target (Ruby 3.4), which
  // must name pages exactly as the plugin does.
  const SERVER: [string, string][] = [
    ["\u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440", "privet-mir"],
    ["Folder/\u0401\u043b\u043a\u0430 \u0401\u0436.md", "elka-ezh"],
    ["Caf\u00e9 d\u00e9j\u00e0", "cafe-deja"],
    ["a_b c", "a-b-c"],
    ["\uff12\uff10\uff12\uff16 year", "2026-year"],
    ["\u00fcber\u2014stra\u00dfe", "uber-stra-e"],
    ["\u0130stanbul", "istanbul"],
    ["\u00e9clair", "eclair"],
    ["e\u0301clair", "eclair"],
    ["\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8", ""],
    ["--x--", "x"],
    ["x.MD", "x"],
    ["\u216b roman \u00bd", "xii-roman-1-2"],
    ["a\u200bb", "a-b"],
    ["\u0663 arabic", "arabic"],
    ["x\u00b2", "x2"],
    ["Part 1/The 2-20-2-20 rule.md", "the-2-20-2-20-rule"],
    ["\u0429\u0443\u043a\u0430 \u0438 \u042e\u043b\u0430", "shchuka-i-yula"],
    ["\u041e\u0431\u044a\u044f\u0432\u043b\u0435\u043d\u0438\u0435 \u2014 \u0441\u044a\u0435\u0437\u0434", "obyavlenie-sezd"],
    ["\u049a\u0430\u0437\u0430\u049b\u0441\u0442\u0430\u043d \u04d8\u043b\u0435\u043c\u0456", "qazaqstan-alemi"],
    ["\u0407\u0436\u0430\u043a \u0456 \u0490\u0443\u0434\u0437\u0438\u043a", "yizhak-i-gudzik"],
    ["Welcome.md", "welcome"],
    ["GTM -- the 2-20 rule!", "gtm-the-2-20-rule"],
    ["README", "readme"],
  ];

  it("names pages exactly as the server's fallback slug does", () => {
    for (const [input, expected] of SERVER) expect([input, asciiSlug(input)]).toEqual([input, expected]);
  });

  it("always produces a slug PublishPage accepts", () => {
    const slugs = assignSlugs(SERVER.map(([input]) => input).concat(["日本語.md", "!!!.md", "Привет мир.md"]));
    for (const slug of slugs.values()) expect(slug).toMatch(PAGE_SLUG_FORMAT);
  });

  it("keeps slugs unique and stable across folders", () => {
    const slugs = assignSlugs(["B/Note.md", "A/Note.md", "Note.md", "日本.md", "中文.md"]);
    expect(slugs.get("A/Note.md")).toBe("note-2");
    expect(slugs.get("B/Note.md")).toBe("note-3");
    expect(slugs.get("Note.md")).toBe("note");
    expect(new Set(slugs.values()).size).toBe(5);
    expect(assignSlugs(["Note.md", "B/Note.md", "A/Note.md", "日本.md", "中文.md"])).toEqual(slugs);
  });

  it("checks a site address the way PublishSite does", () => {
    expect(siteSlugProblem("my-notes")).toBeNull();
    expect(siteSlugProblem("a")).toMatch(/2–49/);
    expect(siteSlugProblem("My Notes")).toMatch(/lowercase/);
    expect(siteSlugProblem("-x")).not.toBeNull();
    expect(siteSlugProblem("admin")).toMatch(/reserved/);
    expect(siteSlugProblem("x".repeat(50))).not.toBeNull();
  });

  it("mirrors the renderer's heading anchors", () => {
    expect(headingId("The 2-20-2-20 rule")).toBe("the-2-20-2-20-rule");
    expect(headingId("**Почему** это _важно_")).toBe("почему-это-важно");
    expect(headingId("!!!")).toBe("section");
  });
});

describe("selection", () => {
  it("lets a folder take its descendants and a note opt out", () => {
    let s = setSelected(emptySelection(), "Guide", true);
    expect(isSelected(s, "Guide/Intro.md")).toBe(true);
    expect(isSelected(s, "Guide/Deep/Later.md")).toBe(true);
    expect(isSelected(s, "Guidelines.md")).toBe(false);
    expect(isSelected(s, "Other.md")).toBe(false);

    s = setSelected(s, "Guide/Drafts", false);
    expect(isSelected(s, "Guide/Drafts/WIP.md")).toBe(false);
    expect(isSelected(s, "Guide/Intro.md")).toBe(true);

    s = setSelected(s, "Guide/Drafts/Ready.md", true);
    expect(isSelected(s, "Guide/Drafts/Ready.md")).toBe(true);
    expect(isSelected(s, "Guide/Drafts/WIP.md")).toBe(false);
    expect(s).toEqual(sel(["Guide", "Guide/Drafts/Ready.md"], ["Guide/Drafts"]));
  });

  it("re-ticking a folder overrides what was chosen inside it", () => {
    let s = sel(["Guide", "Guide/Drafts/Ready.md"], ["Guide/Drafts"]);
    s = setSelected(s, "Guide", true);
    expect(s).toEqual(sel(["Guide"]));
    s = setSelected(s, "Guide", false);
    expect(s).toEqual(sel([]));
  });

  it("treats the empty path as the whole vault", () => {
    let s = setSelected(sel(["A"], ["B"]), "", true);
    expect(s).toEqual(sel([""]));
    expect(isSelected(s, "anything/at/all.md")).toBe(true);
    s = setSelected(s, "Private", false);
    expect(isSelected(s, "Private/diary.md")).toBe(false);
    expect(setSelected(s, "", false)).toEqual(sel([]));
  });

  it("lets an exclude win a tie in a hand-edited list", () => {
    expect(isSelected(sel(["A"], ["A"]), "A/x.md")).toBe(false);
  });

  it("estimates notes, images and bytes without reading", () => {
    const files: SourceFile[] = [
      { path: "Guide/A.md", size: 100, mtime: 0 },
      { path: "Guide/B.md", size: 50, mtime: 0 },
      { path: "Other.md", size: 999, mtime: 0 },
      { path: "img/cat.png", size: 1000, mtime: 0 },
      { path: "doc.pdf", size: 2000, mtime: 0 },
    ];
    const links: Record<string, string[]> = { "Guide/A.md": ["img/cat.png", "Other.md"], "Guide/B.md": ["img/cat.png", "doc.pdf"] };
    expect(estimateSelection(files, sel(["Guide"]), (p) => links[p] ?? [])).toEqual({ notes: 2, images: 1, attachments: 2, bytes: 3150 });
  });

  it("builds the picker tree from note paths", () => {
    const tree = buildTree(["b.md", "Guide/2 Setup.md", "Guide/10 Launch.md", "Guide/Deep/x.md"]);
    expect(tree.files).toEqual(["b.md"]);
    const guide = tree.folders.get("Guide")!;
    expect(guide.path).toBe("Guide");
    expect(guide.files).toEqual(["Guide/2 Setup.md", "Guide/10 Launch.md"]);
    expect(guide.folders.get("Deep")!.files).toEqual(["Guide/Deep/x.md"]);
  });
});

describe("manifest", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
  const PNG2 = [0x89, 0x50, 0x4e, 0x47, 9, 9];

  function vault(): MemorySource {
    return new MemorySource()
      .note("Welcome.md", "---\ntitle: ignored\ntags: [secret]\n---\n# Hello there\n\nFirst paragraph with [[Guide/Intro|the intro]].\n")
      .note("Guide/Intro.md", "Intro body. See [[Welcome#Hello there]] and [[Private/Diary]].\n\n![[cat.png]]\n![[cat.png|300]]\n![[cat.png|A cat|300]]\n")
      .note("Guide/Привет мир.md", "# Привет, мир\n\nТекст. ![копия](attachments/cat%20copy.png) and ![](missing.png) and ![[gone.png]]\n")
      .note("Guide/Code.md", "```md\n[[Welcome]] ![[cat.png]] %% kept %%\n```\nInline `[[Welcome]]` too. %%secret plan%% Visible. ^block-1\n[pdf](files/doc.pdf) [web](https://example.com) [[#Local heading]]\n")
      .note("Guide/Drawing.excalidraw.md", "excalidraw data")
      .note("Private/Diary.md", "my diary")
      .bin("cat.png", PNG)
      .bin("attachments/cat copy.png", PNG) // same bytes, different name
      .bin("files/doc.pdf", [1, 2, 3, 4])
      .bin("gone.png", []); // empty file
  }

  it("builds pages and collects the attachments they reference", async () => {
    const src = vault();
    const m = await buildManifest(src, sel(["Welcome.md", "Guide"]));
    const cat = await digestOf(PNG);
    const pdf = await digestOf([1, 2, 3, 4]);

    expect(m.notes).toEqual(["Welcome.md", "Guide/Code.md", "Guide/Intro.md", "Guide/Привет мир.md"]);
    // Attachments come along even though no folder of theirs was ticked;
    // identical bytes are one object; an empty file is skipped.
    expect(m.attachments.sort()).toEqual(["attachments/cat copy.png", "cat.png", "files/doc.pdf"]);
    expect(m.objects.map((o) => o.digest).sort()).toEqual([cat, pdf].sort());
    expect(m.skipped).toEqual(["gone.png"]);
    expect(m.objects.find((o) => o.digest === cat)).toMatchObject({ byte_size: PNG.length, content_type: "image/png", kind: "asset" });
    expect(m.objects.find((o) => o.digest === pdf)!.content_type).toBe("application/pdf");
    expect(m.homePath).toBe("Welcome.md");

    const page = (path: string) => m.pages.find((p) => p.path === path)!;
    const welcome = page("Welcome.md");
    expect(welcome).toMatchObject({ slug: "welcome", title: "Hello there", position: 0 });
    expect(welcome.nav_section).toBeUndefined();
    expect(welcome.content_markdown).not.toContain("secret");
    expect(welcome.content_markdown.startsWith("# Hello there")).toBe(true);
    expect(welcome.content_markdown).toContain("[the intro](/-/p/intro)");
    expect(welcome.excerpt).toBe("First paragraph with the intro.");
    expect(welcome.source_modified_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect("gated" in welcome).toBe(false);

    const intro = page("Guide/Intro.md");
    expect(intro).toMatchObject({ nav_section: "Guide", title: "Intro" });
    expect(intro.content_markdown).toContain("[Welcome > Hello there](/-/p/welcome#hello-there)");
    // Not in this publication: an empty target the renderer shows as unresolved.
    expect(intro.content_markdown).toContain("[Diary](/-/p/)");
    expect(intro.content_markdown).toContain(`![](${ASSET_PREFIX}${cat})\n![](${ASSET_PREFIX}${cat})\n![A cat](${ASSET_PREFIX}${cat})`);

    const ru = page("Guide/Привет мир.md");
    expect(ru).toMatchObject({ slug: "privet-mir", title: "Привет, мир" });
    expect(ru.content_markdown).toContain(`![копия](${ASSET_PREFIX}${cat})`);
    // Unresolvable and unreadable images: the renderer's "missing" card.
    expect(ru.content_markdown).toContain(`![](${ASSET_PREFIX}${"0".repeat(64)}) and ![](${ASSET_PREFIX}${"0".repeat(64)})`);

    const code = page("Guide/Code.md").content_markdown;
    expect(code).toContain("```md\n[[Welcome]] ![[cat.png]] %% kept %%\n```");
    expect(code).toContain("Inline `[[Welcome]]` too.");
    expect(code).not.toContain("secret plan");
    expect(code).not.toContain("^block-1");
    expect(code).toContain(`[pdf](${ASSET_PREFIX}${pdf})`);
    expect(code).toContain("[web](https://example.com)");
    expect(code).toContain("[Local heading](#local-heading)");

    // Excalidraw waits for P7, and nothing outside the selection is a page.
    expect(m.notes).not.toContain("Guide/Drawing.excalidraw.md");
    expect(m.notes).not.toContain("Private/Diary.md");
    expect(m.pages.map((p) => p.position)).toEqual([0, 1, 2, 3]);
    for (const p of m.pages) expect(p.content_markdown).not.toMatch(/obsyncian-block/);
  });

  it("strips frontmatter only at the very top", () => {
    expect(stripFrontmatter("---\na: 1\n---\nbody")).toBe("body");
    expect(stripFrontmatter("﻿---\r\na: 1\r\n---\r\nbody")).toBe("body");
    expect(stripFrontmatter("body\n---\na: 1\n---\n")).toBe("body\n---\na: 1\n---\n");
    expect(stripFrontmatter("---\nnot closed")).toBe("---\nnot closed");
  });

  it("falls back to the file name for a title", async () => {
    const m = await buildManifest(new MemorySource().note("Notes/My note.md", "## Not an H1\ntext"), sel([""]));
    expect(m.pages[0].title).toBe("My note");
    expect(m.homePath).toBeUndefined();
  });

  it("puts top-level notes first, then each folder together", async () => {
    const src = new MemorySource()
      .note("Zeta/a.md", "a").note("Alpha/b.md", "b").note("z-top.md", "t").note("index.md", "home").note("Alpha/10 x.md", "x").note("Alpha/2 y.md", "y");
    const m = await buildManifest(src, sel([""]));
    expect(m.notes).toEqual(["index.md", "z-top.md", "Alpha/2 y.md", "Alpha/10 x.md", "Alpha/b.md", "Zeta/a.md"]);
    expect(m.homePath).toBe("index.md");
  });
});

describe("publishing", () => {
  function bigVault(pages: number, objects = 0): MemorySource {
    const src = new MemorySource();
    for (let i = 0; i < pages; i++) {
      const embeds = [];
      for (let j = i; j < objects; j += pages) embeds.push(`![[img${j}.png]]`);
      src.note(`Notes/n${i}.md`, `Page ${i}\n${embeds.join("\n")}`);
    }
    for (let j = 0; j < objects; j++) src.bin(`img${j}.png`, [0x89, j & 0xff, (j >> 8) & 0xff, 7]);
    return src;
  }

  it("plans in batches, uploads only what's missing, and commits in chunks", async () => {
    const src = bigVault(450, 2_100);
    const fake = new FakePublishApi();
    const m = await buildManifest(src, sel(["Notes"]));
    expect(m.objects).toHaveLength(2_100);

    const phases: string[] = [];
    const out = await publishManifest(api(fake), fake.site.id, m, src, (p) => phases.push(p.phase));

    expect(fake.calls.plan.map((c) => c.length)).toEqual([2_000, 100]);
    expect(fake.calls.put).toHaveLength(2_100);
    expect(fake.maxInFlight).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
    expect(fake.maxInFlight).toBeGreaterThan(1);
    expect(fake.calls.commit.map((c) => [c.pages.length, c.final])).toEqual([[200, false], [200, false], [50, true]]);
    expect(new Set(fake.calls.commit.map((c) => c.snapshot)).size).toBe(1);
    expect(out).toMatchObject({ uploaded: 2_100, skippedKnown: 0, pages: 450 });
    expect(out.site.status).toBe("live");
    expect(fake.live).toHaveLength(450);
    expect(phases).toContain("uploading");
    expect(phases.at(-1)).toBe("finishing");

    // Update publication: same notes, nothing to upload again.
    fake.calls = { plan: [], commit: [], put: [] };
    const again = await publishManifest(api(fake), fake.site.id, await buildManifest(src, sel(["Notes"])), src);
    expect(fake.calls.put).toHaveLength(0);
    expect(again).toMatchObject({ uploaded: 0, skippedKnown: 2_100 });
    expect(fake.calls.commit[0].snapshot).not.toBe(out.site.revision.toString());
  });

  it("closes a chunk early on bytes", () => {
    const page = (n: number) => ({ path: `${n}.md`, slug: `p${n}`, title: "t", position: n, content_markdown: "x".repeat(400) });
    const pages = Array.from({ length: 10 }, (_, i) => page(i));
    expect(chunkPages(pages, 4, 1_000).map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
    expect(chunkPages(pages, 3, 1e9).map((c) => c.length)).toEqual([3, 3, 3, 1]);
    expect(chunkPages([{ ...page(0), content_markdown: "y".repeat(5_000) }, page(1)], 4, 1_000).map((c) => c.length)).toEqual([1, 1]);
    expect(chunkPages(pages).length).toBe(Math.ceil(10 / COMMIT_CHUNK_PAGES));
  });

  it("stores each object under its real type", async () => {
    const src = new MemorySource().note("a.md", "![[pic.svg]] [[doc.pdf]]").bin("pic.svg", [60, 115, 118, 103, 62]).bin("doc.pdf", [37, 80, 68, 70]);
    const fake = new FakePublishApi();
    await publishManifest(api(fake), fake.site.id, await buildManifest(src, sel([""])), src);
    expect([...fake.storage.values()].map((s) => s.contentType).sort()).toEqual(["application/pdf", "image/svg+xml"]);
  });

  it("re-uploads what the server reports missing and retries the final commit once", async () => {
    const src = bigVault(3, 5);
    const fake = new FakePublishApi();
    const m = await buildManifest(src, sel([""]));
    const lost = m.objects[2].digest;
    fake.dropNextUpload.add(lost);

    const out = await publishManifest(api(fake), fake.site.id, m, src);
    expect(out.site.revision).toBe(1);
    expect(fake.calls.plan.map((c) => c.map((o) => o.digest))).toEqual([m.objects.map((o) => o.digest), [lost]]);
    expect(fake.calls.put.filter((d) => d === lost)).toHaveLength(2);
    expect(fake.calls.commit.filter((c) => c.final)).toHaveLength(2);
    expect(fake.storage.has(lost)).toBe(true);
  });

  it("gives up after one retry and leaves the live site alone", async () => {
    const src = bigVault(2, 2);
    const fake = new FakePublishApi();
    const m = await buildManifest(src, sel([""]));
    fake.alwaysDrop.add(m.objects[0].digest);

    const err = await publishManifest(api(fake), fake.site.id, m, src).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("missing_uploads");
    expect(fake.calls.commit.filter((c) => c.final)).toHaveLength(2);
    expect(fake.live).toHaveLength(0);
    expect(publishErrorMessage(err)).toMatch(/wasn't changed/);
  });

  it("refuses a file that changed between hashing and upload", async () => {
    const src = new MemorySource().note("a.md", "![[x.png]]").bin("x.png", [1, 2, 3]);
    const fake = new FakePublishApi();
    const m = await buildManifest(src, sel([""]));
    src.bin("x.png", [1, 2, 3, 4]);
    await expect(publishManifest(api(fake), fake.site.id, m, src)).rejects.toMatchObject({ code: "changed_while_publishing" });
    expect(fake.calls.commit).toHaveLength(0);
  });

  it("fails a doomed publish at plan time with a pointer to /upgrade", async () => {
    const src = bigVault(1, 1);
    const fake = new FakePublishApi();
    fake.bytesRemaining = 1;
    const err = await publishManifest(api(fake), fake.site.id, await buildManifest(src, sel([""])), src).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("publish_bytes_exceeded");
    expect(fake.calls.commit).toHaveLength(0);
    expect(publishErrorMessage(err)).toMatch(/\/upgrade/);
    for (const code of ["file_too_large", "publish_not_on_plan", "publish_site_limit_reached"]) {
      expect(publishErrorMessage(new ApiError(403, code, "Limit."))).toMatch(/\/upgrade/);
    }
    expect(publishErrorMessage(new ApiError(422, "too_many_pages", "x"))).toMatch(/update Syncian/);
  });

  it("uploads the plaintext bytes from the vault — never anything encrypted", async () => {
    // Publishing has no codec to reach for: the engine only ever sees the
    // PublishSource, which reads notes as they are on disk.
    const engine = readFileSync(resolvePath(__dirname, "../src/publish.ts"), "utf8");
    expect(engine).not.toMatch(/from "\.\/(crypto|codec|encrypt)"/);

    const bytes = [0x89, 0x50, 0x4e, 0x47, 42];
    const src = new MemorySource().note("a.md", "Secret recipe ![[x.png]]").bin("x.png", bytes);
    const fake = new FakePublishApi();
    await publishManifest(api(fake), fake.site.id, await buildManifest(src, sel([""])), src);
    const [[digest, stored]] = [...fake.storage.entries()];
    expect([...stored.data]).toEqual(bytes);
    expect(digest).toBe(await digestOf(bytes));
    expect(fake.live[0].content_markdown).toContain("Secret recipe");
  });
});

describe("consent", () => {
  it("covers the first publish and every time the selection grows", () => {
    const first = { notes: ["a.md", "b.md"], attachments: ["x.png"] };
    expect(newSinceConsent(first, [])).toEqual(["a.md", "b.md", "x.png"]);
    const agreed = [...first.notes, ...first.attachments];
    expect(newSinceConsent(first, agreed)).toEqual([]);
    expect(newSinceConsent({ notes: ["a.md"], attachments: [] }, agreed)).toEqual([]);
    expect(newSinceConsent({ notes: ["a.md", "c.md"], attachments: ["x.png", "y.png"] }, agreed)).toEqual(["c.md", "y.png"]);
  });

  function setup() {
    const src = new MemorySource().note("Guide/a.md", "A ![[x.png]]").note("Guide/b.md", "B").note("Other/c.md", "C").bin("x.png", [1, 2]);
    const fake = new FakePublishApi();
    const local = { selection: sel(["Guide"]), consented: [] as string[] };
    const asked: { fresh: string[]; grown: boolean }[] = [];
    let saves = 0;
    const run = (answer: boolean) =>
      publishSelection({
        api: api(fake), siteId: fake.site.id, local, source: src,
        ask: async (_m, fresh, grown) => {
          asked.push({ fresh, grown });
          return answer;
        },
        save: async () => {
          saves++;
        },
      });
    return { src, fake, local, asked, run, saves: () => saves };
  }

  it("sends nothing to the server until the author agrees", async () => {
    const t = setup();
    const declined = await t.run(false);
    expect(declined.outcome).toBeNull();
    expect(t.asked).toEqual([{ fresh: ["Guide/a.md", "Guide/b.md", "x.png"], grown: false }]);
    expect(t.fake.calls.plan).toHaveLength(0);
    expect(t.fake.calls.commit).toHaveLength(0);
    expect(t.local.consented).toEqual([]);
    expect(t.saves()).toBe(0);
  });

  it("asks once, then only again for what's new", async () => {
    const t = setup();
    expect((await t.run(true)).outcome?.site.status).toBe("live");
    expect(t.local.consented).toEqual(["Guide/a.md", "Guide/b.md", "x.png"]);
    expect(t.saves()).toBe(1);

    // Update publication with the same selection: no question.
    await t.run(true);
    expect(t.asked).toHaveLength(1);

    // A note added to the picked folder, and another folder ticked.
    t.src.note("Guide/d.md", "D");
    t.local.selection = setSelected(t.local.selection, "Other", true);
    const declined = await t.run(false);
    expect(t.asked[1]).toEqual({ fresh: ["Guide/d.md", "Other/c.md"], grown: true });
    expect(declined.outcome).toBeNull();
    expect(t.fake.live.map((p) => p.path)).toEqual(["Guide/a.md", "Guide/b.md"]);
  });

  it("refuses an empty selection before asking anything", async () => {
    const t = setup();
    t.local.selection = sel(["Nowhere"]);
    await expect(t.run(true)).rejects.toMatchObject({ code: "nothing_to_publish" });
    expect(t.asked).toHaveLength(0);
  });
});

describe("diagrams", () => {
  const FLOW = "flowchart LR\n  A[Лид] --> B[Звонок]";
  const svg = (theme: string) => `<svg width="100%" style="max-width: 300px;" viewBox="0 0 300 120"><text>${theme}</text></svg>`;

  class DrawingSource extends MemorySource {
    drawn: string[] = [];
    async renderMermaid(code: string) {
      this.drawn.push(code);
      return code.includes("broken") ? null : { light: svg("light"), dark: svg("dark") };
    }
  }

  const boardFile = (scene: object, embedded = "") =>
    `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n\n## Embedded Files\n${embedded}\n%%\n## Drawing\n\`\`\`compressed-json\n` +
    LZString.compressToBase64(JSON.stringify(scene)) + "\n```\n%%\n";

  it("draws each Mermaid block in both themes and puts a marker where it was", async () => {
    const src = new DrawingSource()
      .note("Notes/A.md", "Before\n\n```mermaid\n" + FLOW + "\n```\n\nAfter")
      .note("Notes/B.md", "Same diagram:\n\n```mermaid\n" + FLOW + "\n```\n") as DrawingSource;
    const m = await buildManifest(src, sel(["Notes"]));

    expect(src.drawn).toEqual([FLOW]); // drawn once, used twice
    const svgs = m.objects.filter((o) => o.content_type === "image/svg+xml");
    expect(svgs).toHaveLength(2);
    expect(svgs.every((o) => o.kind === "block" && o.width === 300 && o.height === 120)).toBe(true);
    const page = m.pages.find((p) => p.path === "Notes/A.md")!;
    const marker = JSON.parse(/```obsyncian-diagram\n(.*)\n```/.exec(page.content_markdown)![1]);
    expect(marker).toMatchObject({ kind: "mermaid", type: "flowchart", width: 300, height: 120 });
    expect(new Set([marker.light, marker.dark])).toEqual(new Set(svgs.map((o) => o.digest)));
    expect(page.content_markdown).not.toContain("```mermaid");

    const fake = new FakePublishApi();
    await publishManifest(api(fake), fake.site.id, m, src);
    const stored = new TextDecoder().decode(fake.storage.get(marker.dark)!.data);
    expect(stored).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(stored).toContain(">dark<");
    expect(fake.storage.get(marker.dark)!.contentType).toBe("image/svg+xml");
  });

  it("leaves a block that can't be drawn as code, and draws nothing without a renderer", async () => {
    const src = new DrawingSource().note("Notes/A.md", "```mermaid\ngraph TD\n  broken[\n```") as DrawingSource;
    const m = await buildManifest(src, sel(["Notes"]));
    expect(m.pages[0].content_markdown).toBe("```mermaid\ngraph TD\n  broken[\n```");
    expect(m.objects).toEqual([]);

    const plain = await buildManifest(new MemorySource().note("Notes/A.md", "```mermaid\n" + FLOW + "\n```"), sel(["Notes"]));
    expect(plain.pages[0].content_markdown).toContain("```mermaid");
  });

  it("publishes an embedded Excalidraw board as its scene plus its images, without the Excalidraw plugin", async () => {
    const scene = {
      elements: [
        { id: "r", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
        { id: "i", type: "image", fileId: "abc123" },
        { id: "w", type: "embeddable", link: "https://youtube.com" },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
    };
    const src = new MemorySource()
      .note("Notes/Plan.md", "The board:\n![[Путь клиента.excalidraw]]\nDone.")
      .note("Boards/Путь клиента.excalidraw.md", boardFile(scene, "abc123: [[shot.png]]\n"))
      .bin("Pictures/shot.png", [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const m = await buildManifest(src, sel(["Notes"]));

    expect(m.notes).toEqual(["Notes/Plan.md"]); // the board isn't a page of its own
    expect(m.attachments).toEqual(["Boards/Путь клиента.excalidraw.md", "Pictures/shot.png"]); // listed for consent
    const sceneObject = m.objects.find((o) => o.content_type === "application/json")!;
    expect(sceneObject).toMatchObject({ kind: "block", source_path: "Boards/Путь клиента.excalidraw.md" });
    const image = m.objects.find((o) => o.content_type === "image/png")!;
    const published = JSON.parse(new TextDecoder().decode(m.generated.get(sceneObject.digest)));
    expect(published.elements.map((e: { id: string }) => e.id)).toEqual(["r", "i"]);
    expect(published.files).toEqual({ abc123: { id: "abc123", mimeType: "image/png", asset: image.digest } });

    const content = m.pages[0].content_markdown;
    expect(content).toBe(`The board:\n\n\`\`\`obsyncian-diagram\n{"kind":"excalidraw","scene":"${sceneObject.digest}","title":"Путь клиента"}\n\`\`\`\n\nDone.`);

    const fake = new FakePublishApi();
    await publishManifest(api(fake), fake.site.id, m, src);
    expect(fake.storage.has(sceneObject.digest)).toBe(true);
    expect(fake.storage.has(image.digest)).toBe(true);
  });

  it("shrinks big images placed in a board", async () => {
    class Shrinking extends MemorySource {
      async shrinkImage() { return { data: new Uint8Array([9, 9]).buffer, contentType: "image/webp" }; }
    }
    const src = new Shrinking()
      .note("Notes/Plan.md", "![[Board.excalidraw]]")
      .note("Board.excalidraw.md", boardFile({ elements: [{ id: "i", type: "image", fileId: "f9" }] }, "f9: [[big.png]]"))
      .bin("big.png", [1, 2, 3, 4, 5, 6, 7, 8]);
    const m = await buildManifest(src, sel(["Notes"]));
    const webp = m.objects.find((o) => o.content_type === "image/webp")!;
    expect(webp.byte_size).toBe(2);
    expect(m.generated.has(webp.digest)).toBe(true);
  });

  it("a board that can't be read still gets a card, saying so", async () => {
    const src = new MemorySource()
      .note("Notes/Plan.md", "![[Broken.excalidraw]]")
      .note("Broken.excalidraw.md", "# no drawing here");
    const m = await buildManifest(src, sel(["Notes"]));
    expect(m.pages[0].content_markdown).toContain('{"kind":"excalidraw","scene":null,"title":"Broken"}');
    expect(m.skipped).toContain("Broken.excalidraw.md");
  });
});
