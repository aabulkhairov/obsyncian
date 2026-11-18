import type { ObsyncSettings } from "./settings";
import type { SyncReport } from "./sync";

// A sync that can't reach the server isn't an error worth a report each
// time (since 1.0.25 it isn't one at all) — but a device that can't reach
// the server for hours is exactly what support needs to know about, e.g. a
// network that should be using the rus.obsyncian.com mirror. So failures
// are tallied, and once a day the tally goes out as a single report.

export const CONNECTIVITY_REPORT_EVERY_MS = 24 * 60 * 60_000;

// A laptop that sleeps through a sync, or Wi-Fi that drops for a minute,
// loses a cycle or two a day; that's normal, and reporting it only buries the
// devices that really can't get through. So the day's tally goes out only when
// failures are both repeated and at least as common as successful cycles.
export const CONNECTIVITY_MIN_FAILURES = 3;

// Records this cycle's outcome. Returns the report to send when a day's
// worth has piled up and looks like a real problem, else null.
export function noteConnectivity(settings: ObsyncSettings, report: SyncReport, now: number, host: string): string | null {
  const failed = report.offline || report.interrupted > 0;
  const tally = settings.connectivity;
  if (failed) {
    const t = tally ?? { since: now, failures: 0, successes: 0, last: "" };
    t.failures++;
    t.last = report.offline ? (report.offlineReason ?? "no connection") : `${report.interrupted} transfer(s) interrupted`;
    settings.connectivity = t;
  } else if (tally) {
    tally.successes = (tally.successes ?? 0) + 1;
  }
  const t = settings.connectivity;
  if (!t || now - t.since < CONNECTIVITY_REPORT_EVERY_MS) return null;
  settings.connectivity = null;
  const successes = t.successes ?? 0;
  if (t.failures < CONNECTIVITY_MIN_FAILURES || t.failures < successes) return null;
  return `${t.failures} of ${t.failures + successes} sync attempt(s) in the last day failed to reach ${host} or its storage. Last: ${t.last}`;
}

export function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}
