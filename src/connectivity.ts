import type { ObsyncSettings } from "./settings";
import type { SyncReport } from "./sync";

// A sync that can't reach the server isn't an error worth a report each
// time (since 1.0.25 it isn't one at all) — but a device that can't reach
// the server for hours is exactly what support needs to know about, e.g. a
// network that should be using the rus.obsyncian.com mirror. So failures
// are tallied, and once a day the tally goes out as a single report.

export const CONNECTIVITY_REPORT_EVERY_MS = 24 * 60 * 60_000;

// Records this cycle's outcome. Returns the report to send when a day's
// worth has piled up, else null.
export function noteConnectivity(settings: ObsyncSettings, report: SyncReport, now: number, host: string): string | null {
  const failed = report.offline || report.interrupted > 0;
  if (failed) {
    const tally = settings.connectivity ?? { since: now, failures: 0, last: "" };
    tally.failures++;
    tally.last = report.offline ? (report.offlineReason ?? "no connection") : `${report.interrupted} transfer(s) interrupted`;
    settings.connectivity = tally;
  }
  const tally = settings.connectivity;
  if (!tally || now - tally.since < CONNECTIVITY_REPORT_EVERY_MS) return null;
  settings.connectivity = null;
  return `${tally.failures} sync attempt(s) in the last day couldn't reach ${host}. Last: ${tally.last}`;
}

export function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}
