import { describe, expect, it } from "vitest";
import { CONNECTIVITY_REPORT_EVERY_MS, hostOf, noteConnectivity } from "../src/connectivity";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { SyncReport } from "../src/sync";

const ok = { offline: false, interrupted: 0 } as SyncReport;
const offline = { offline: true, interrupted: 0, offlineReason: "No response after 10s (GET /v1/vaults/72/changes)" } as SyncReport;
const cut = { offline: false, interrupted: 3 } as SyncReport;
const DAY = CONNECTIVITY_REPORT_EVERY_MS;

describe("daily connectivity report", () => {
  it("sums a day's failures into one report, then starts over", () => {
    const s = { ...DEFAULT_SETTINGS };
    expect(noteConnectivity(s, ok, 0, "obsyncian.com")).toBeNull();
    expect(s.connectivity).toBeNull();

    expect(noteConnectivity(s, offline, 1_000, "obsyncian.com")).toBeNull();
    expect(noteConnectivity(s, cut, 2_000, "obsyncian.com")).toBeNull();
    expect(noteConnectivity(s, offline, DAY / 2, "obsyncian.com")).toBeNull();
    expect(noteConnectivity(s, ok, DAY - 1, "obsyncian.com")).toBeNull();

    // A day after the first failure, the next cycle — even a good one — sends it.
    expect(noteConnectivity(s, ok, 1_000 + DAY, "obsyncian.com"))
      .toBe("3 sync attempt(s) in the last day couldn't reach obsyncian.com. Last: No response after 10s (GET /v1/vaults/72/changes)");
    expect(s.connectivity).toBeNull();
    expect(noteConnectivity(s, ok, 2 * DAY + 1_000, "obsyncian.com")).toBeNull();
  });

  it("names the server, so a mirror shows up as such", () => {
    expect(hostOf("https://rus.obsyncian.com")).toBe("rus.obsyncian.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
