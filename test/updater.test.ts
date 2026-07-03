import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, isNewerVersion } from "../src/updater";

describe("isNewerVersion", () => {
  it("compares dot-separated versions numerically", () => {
    expect(isNewerVersion("0.1.2", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.1", "0.1.2")).toBe(false);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
  });

  it("treats a missing segment as 0, avoiding naive string-compare mistakes", () => {
    expect(isNewerVersion("0.2", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true); // "0.1.10" < "0.1.9" as strings, but not numerically
  });
});

describe("checkForUpdate", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(responses: Record<string, { status: number; body: string }>) {
    const fn = vi.fn(async (url: string) => {
      const match = Object.entries(responses).find(([path]) => url.endsWith(path));
      const res = match ? match[1] : { status: 404, body: "" };
      return { status: res.status, text: async () => res.body };
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("does nothing when the remote version is not newer", async () => {
    stubFetch({ "/dev-plugin/manifest.json": { status: 200, body: JSON.stringify({ version: "0.1.0" }) } });
    const write = vi.fn();
    const result = await checkForUpdate("https://example.com", "0.1.0", write, "dir");
    expect(result.updated).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes manifest, main.js, and styles.css when the remote version is newer", async () => {
    stubFetch({
      "/dev-plugin/manifest.json": { status: 200, body: JSON.stringify({ version: "0.2.0" }) },
      "/dev-plugin/main.js": { status: 200, body: "console.log('new build')" },
      "/dev-plugin/styles.css": { status: 200, body: ".obsync { color: red }" },
    });
    const write = vi.fn();
    const result = await checkForUpdate("https://example.com", "0.1.0", write, "vault/.obsidian/plugins/obsync");
    expect(result).toEqual({ updated: true, version: "0.2.0" });
    expect(write).toHaveBeenCalledWith(
      "vault/.obsidian/plugins/obsync/manifest.json",
      JSON.stringify({ version: "0.2.0" })
    );
    expect(write).toHaveBeenCalledWith("vault/.obsidian/plugins/obsync/main.js", "console.log('new build')");
    expect(write).toHaveBeenCalledWith("vault/.obsidian/plugins/obsync/styles.css", ".obsync { color: red }");
  });

  it("still updates when styles.css is missing on the server (cosmetics must not block an update)", async () => {
    stubFetch({
      "/dev-plugin/manifest.json": { status: 200, body: JSON.stringify({ version: "0.2.0" }) },
      "/dev-plugin/main.js": { status: 200, body: "js" },
    });
    const write = vi.fn();
    const result = await checkForUpdate("https://example.com", "0.1.0", write, "dir");
    expect(result).toEqual({ updated: true, version: "0.2.0" });
    expect(write).toHaveBeenCalledTimes(2); // manifest + main.js only
  });

  it("does nothing when the manifest fetch fails (server unreachable or no dev build published)", async () => {
    stubFetch({});
    const write = vi.fn();
    const result = await checkForUpdate("https://example.com", "0.1.0", write, "dir");
    expect(result.updated).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("does nothing when main.js fetch fails even if the manifest looked newer", async () => {
    stubFetch({ "/dev-plugin/manifest.json": { status: 200, body: JSON.stringify({ version: "0.2.0" }) } });
    const write = vi.fn();
    const result = await checkForUpdate("https://example.com", "0.1.0", write, "dir");
    expect(result.updated).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("handles a malformed manifest body without throwing", async () => {
    stubFetch({ "/dev-plugin/manifest.json": { status: 200, body: "not json" } });
    const result = await checkForUpdate("https://example.com", "0.1.0", vi.fn(), "dir");
    expect(result.updated).toBe(false);
  });

  it("strips a trailing slash from the server URL before building the request", async () => {
    const fetchSpy = stubFetch({ "/dev-plugin/manifest.json": { status: 200, body: JSON.stringify({ version: "0.1.0" }) } });
    await checkForUpdate("https://example.com/", "0.1.0", vi.fn(), "dir");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://example.com/dev-plugin/manifest.json");
  });
});
