// Live check of the publish flow against a real Rails dev server: real
// ApiClient, real PublishSnapshot and PublishRenderer. Pages only — notes
// without attachments need no storage, so this runs without MinIO/R2.
//   OBSYNC_PUBLISH_E2E=http://localhost:3000 OBSYNC_TOKEN=obs_… OBSYNC_VAULT=<id> npm test
// with a token for a user on a paid plan (publishing is paid-only).
import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api";
import { buildManifest, publishManifest, type PublishSource, type SourceFile } from "../src/publish";

const SERVER = process.env.OBSYNC_PUBLISH_E2E ?? "";
const TOKEN = process.env.OBSYNC_TOKEN ?? "";
const VAULT = process.env.OBSYNC_VAULT ?? "";

const NOTES: Record<string, string> = {
  "index.md": "---\nsecret: yes\n---\n# Home\n\nStart with [[Guide/Привет мир|the Russian note]] or [[Missing note]].\n",
  "Guide/Привет мир.md": "# Привет, мир\n\nНазад [[index#Home|домой]]. %%private%%\n\n```\n[[index]]\n```\n",
};

const source: PublishSource = {
  files: () => Object.entries(NOTES).map(([path, text]): SourceFile => ({ path, size: text.length, mtime: 1_700_000_000_000 })),
  stat: (path) => (path in NOTES ? { path, size: NOTES[path].length, mtime: 0 } : null),
  read: async (path) => NOTES[path],
  readBinary: async () => new ArrayBuffer(0),
  resolve: (linkpath) => Object.keys(NOTES).find((p) => p === `${linkpath}.md` || p.endsWith(`/${linkpath}.md`)) ?? null,
};

describe.skipIf(!SERVER)("publish against a live dev server", () => {
  it("creates a site, publishes, republishes and deletes it", async () => {
    const api = new ApiClient(() => SERVER, () => TOKEN);
    const slug = `p6-e2e-${Date.now().toString(36)}`;
    const site = await api.createPublishSite(VAULT, { slug, title: "P6 e2e", author_label: "Test", locale: "ru" });
    try {
      expect(site).toMatchObject({ slug, status: "draft", locale: "ru", last_published_at: null });
      expect((await api.listPublishSites()).sites.map((s) => s.id)).toContain(site.id);
      expect((await api.updatePublishSite(site.id, { title: "P6 e2e renamed" })).title).toBe("P6 e2e renamed");

      const manifest = await buildManifest(source, { include: [""], exclude: [] });
      const out = await publishManifest(api, site.id, manifest, source);
      expect(out.site).toMatchObject({ status: "live", page_count: 2, revision: 1 });

      const home = await (await fetch(`${SERVER}/p/${slug}`)).text();
      expect(home).toContain(`/p/${slug}/privet-mir`);
      expect(home).toContain("pub-link-unresolved");
      expect(home).not.toContain("secret");
      const ru = await (await fetch(`${SERVER}/p/${slug}/privet-mir`)).text();
      expect(ru).toContain("Привет, мир");
      expect(ru).toContain(`/p/${slug}/index#home`);
      expect(ru).toContain("[[index]]");
      expect(ru).not.toContain("private");

      // Update publication: a new snapshot, same pages.
      const again = await publishManifest(api, site.id, await buildManifest(source, { include: [""], exclude: [] }), source);
      expect(again.site.revision).toBe(2);

      // Not settable from the API today — see PublishSitesController#site_params.
      const offline = await api.updatePublishSite(site.id, { status: "draft" });
      console.log("status after asking for draft:", offline.status);
    } finally {
      await api.deletePublishSite(site.id);
    }
    expect((await api.listPublishSites()).sites.map((s) => s.id)).not.toContain(site.id);
  });
});
