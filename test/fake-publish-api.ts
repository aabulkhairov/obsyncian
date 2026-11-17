// In-memory reimplementation of the server's publish semantics (mirrors
// PublishPlan + PublishSnapshot on the Rails side): content-addressed objects
// claimed per snapshot, pages staged per chunk, and a final call that confirms
// every upload against "storage" before it promotes.
import {
  ApiError,
  type PublishCommitBody,
  type PublishCommitResult,
  type PublishObjectInput,
  type PublishPageInput,
  type PublishPlanResult,
  type PublishSiteInfo,
} from "../src/api";

const MAX_OBJECTS_PER_CALL = 2_000;
const MAX_PAGES_PER_CHUNK = 500;
const DIGEST = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

interface ObjectRow {
  object: PublishObjectInput;
  snapshot: string;
  uploaded: boolean;
}

export class FakePublishApi {
  site: PublishSiteInfo = {
    id: 7, vault_id: 1, slug: "guide", title: "Guide", description: null, author_label: null,
    visibility: "public", status: "draft", locale: "en", robots: "index", revision: 0,
    page_count: 0, object_count: 0, total_bytes: 0, url: "https://example.com/p/guide", last_published_at: null,
  };
  objects = new Map<string, ObjectRow>();
  // What reached "R2", by digest, with the type it was stored under.
  storage = new Map<string, { data: Uint8Array; contentType: string }>();
  staged = new Map<string, PublishPageInput & { snapshot: string }>();
  live: PublishPageInput[] = [];
  homePath: string | undefined;

  // Test hooks.
  // Digests whose next PUT "succeeds" without landing in storage.
  dropNextUpload = new Set<string>();
  // Every PUT for these digests is lost.
  alwaysDrop = new Set<string>();
  bytesRemaining = Infinity;

  calls = { plan: [] as PublishObjectInput[][], commit: [] as PublishCommitBody[], put: [] as string[] };
  inFlight = 0;
  maxInFlight = 0;

  async publishPlan(siteId: number, snapshot: string, objects: PublishObjectInput[]): Promise<PublishPlanResult> {
    this.checkSite(siteId);
    this.calls.plan.push(objects);
    if (objects.length > MAX_OBJECTS_PER_CALL) throw new ApiError(422, "too_many_objects", "too many");
    const digests = objects.map((o) => o.digest);
    if (new Set(digests).size !== digests.length) throw new ApiError(422, "invalid", "duplicate digest in one plan call");
    for (const o of objects) {
      if (!DIGEST.test(o.digest)) throw new ApiError(422, "invalid", `bad digest ${o.digest}`);
      if (!(o.byte_size > 0)) throw new ApiError(422, "invalid", "byte_size must be positive");
    }
    const known = objects.filter((o) => this.objects.get(o.digest)?.uploaded);
    const missing = objects.filter((o) => !this.objects.get(o.digest)?.uploaded);
    const needed = missing.reduce((sum, o) => sum + o.byte_size, 0);
    if (needed > this.bytesRemaining) throw new ApiError(403, "publish_bytes_exceeded", "Publishing these files would exceed your plan's published-bytes limit.");
    for (const o of objects) {
      const row = this.objects.get(o.digest);
      this.objects.set(o.digest, { object: o, snapshot, uploaded: row?.uploaded ?? false });
    }
    return {
      snapshot,
      known: known.map((o) => o.digest),
      uploads: missing.map((o) => ({ digest: o.digest, put_url: `fake://put/${o.digest}`, expires_in: 900 })),
      bytes_remaining: this.bytesRemaining,
    };
  }

  async putPublishObject(url: string, data: ArrayBuffer, contentType: string): Promise<void> {
    const digest = url.replace("fake://put/", "");
    this.calls.put.push(digest);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    this.inFlight--;
    if (this.alwaysDrop.has(digest)) return;
    if (this.dropNextUpload.delete(digest)) return;
    this.storage.set(digest, { data: new Uint8Array(data.slice(0)), contentType });
  }

  async publishCommit(siteId: number, body: PublishCommitBody): Promise<PublishCommitResult> {
    this.checkSite(siteId);
    this.calls.commit.push(body);
    if (body.pages.length > MAX_PAGES_PER_CHUNK) throw new ApiError(422, "too_many_pages", "too many");
    for (const key of ["path", "slug"] as const) {
      const values = body.pages.map((p) => p[key]);
      if (new Set(values).size !== values.length) throw new ApiError(422, "invalid", `duplicate ${key} in one chunk`);
    }
    for (const [path, row] of this.staged) if (row.snapshot !== body.snapshot) this.staged.delete(path);
    for (const page of body.pages) {
      if (!SLUG.test(page.slug)) throw new ApiError(422, "invalid", `bad slug ${page.slug}`);
      if ("gated" in page) throw new Error("the plugin must not send gated before P5");
      this.staged.set(page.path, { ...page, snapshot: body.snapshot });
    }
    if (!body.final) return { snapshot: body.snapshot, final: false, staged: this.staged.size };

    if (!this.staged.size) throw new ApiError(422, "nothing_to_publish", "Nothing was staged for this snapshot.");
    const pending = [...this.objects.entries()].filter(([, r]) => r.snapshot === body.snapshot && !r.uploaded);
    const missing: string[] = [];
    for (const [digest, row] of pending) {
      const stored = this.storage.get(digest);
      if (stored) row.uploaded = true;
      else missing.push(digest);
    }
    if (missing.length) {
      throw new ApiError(422, "missing_uploads", `${missing.length} planned object(s) were never uploaded to storage.`, { digests: missing });
    }

    for (const [digest, row] of this.objects) if (row.snapshot !== body.snapshot) this.objects.delete(digest);
    this.live = [...this.staged.values()].map(({ snapshot: _s, ...page }) => page);
    this.staged.clear();
    this.homePath = body.home_path;
    this.site = {
      ...this.site,
      revision: this.site.revision + 1,
      page_count: this.live.length,
      object_count: this.objects.size,
      status: this.site.last_published_at ? this.site.status : "live",
      last_published_at: new Date().toISOString(),
    };
    return { ...this.site, published: true };
  }

  private checkSite(siteId: number): void {
    if (siteId !== this.site.id) throw new ApiError(404, "not_found", "Not found.");
  }
}
