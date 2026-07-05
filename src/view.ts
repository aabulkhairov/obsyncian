import { ItemView, WorkspaceLeaf } from "obsidian";
import type ObsyncPlugin from "./main";

export const VIEW_TYPE_OBSYNC = "obsync-status-view";

export class ObsyncStatusView extends ItemView {
  private statusText = "idle";

  constructor(leaf: WorkspaceLeaf, private plugin: ObsyncPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OBSYNC;
  }

  getDisplayText(): string {
    return "Syncian";
  }

  getIcon(): string {
    return "refresh-cw";
  }

  async onOpen(): Promise<void> {
    this.render();
    // "Last sync — Xm ago" is only recomputed when render() runs, which
    // otherwise only happens on an actual status change — left open with
    // nothing happening, it visibly freezes on a stale value (e.g. stuck
    // on "3m ago" long after it's really been 10). Keep it honest.
    this.registerInterval(window.setInterval(() => this.render(), 30_000));
  }

  setStatus(text: string): void {
    this.statusText = text;
    this.render();
  }

  render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("obsync-status-view");

    el.createEl("h4", { text: "Syncian" });

    if (!this.plugin.connected) {
      el.createEl("p", {
        text: "Not connected — open Settings → Syncian to log in and link a vault.",
        cls: "obsync-muted",
      });
      return;
    }

    const s = this.plugin.settings;
    const ss = this.plugin.syncState;
    const busy = this.plugin.engine.busy;
    const paused = s.paused;
    const fileCount = Object.keys(ss.files).length;
    const totalBytes = Object.values(ss.files).reduce((sum, f) => sum + (f.size > 0 ? f.size : 0), 0);

    // Status line: what the engine is doing right now.
    const statusLine = el.createDiv({ cls: "obsync-status-line" });
    const dot = statusLine.createSpan({ cls: "obsync-status-dot" });
    dot.addClass(busy ? "is-busy" : paused ? "is-paused" : "is-idle");
    statusLine.createSpan({ text: paused && !busy ? "paused — auto-sync off" : this.statusText });

    const stats = el.createDiv({ cls: "obsync-stats" });
    addRow(stats, "Vault", s.vaultName || "—");
    addRow(stats, "Last sync", ss.lastSyncAt ? relativeTime(ss.lastSyncAt) : "never");
    addRow(stats, "Files", fileCount.toLocaleString());
    addRow(stats, "Size", formatBytes(totalBytes));

    const buttons = el.createDiv({ cls: "obsync-buttons" });
    const syncBtn = buttons.createEl("button", {
      text: busy ? "Syncing…" : "Sync now",
      cls: "mod-cta obsync-sync-btn",
    });
    syncBtn.disabled = busy;
    syncBtn.onclick = () => this.plugin.syncNow();

    const pauseBtn = buttons.createEl("button", {
      text: paused ? "Resume sync" : "Pause sync",
      cls: "obsync-pause-btn",
    });
    pauseBtn.onclick = () => this.plugin.togglePause();

    this.renderLastReport(el);
  }

  // What actually happened last time: moved counts, conflicts, and the
  // errors themselves — not just "errors (3)" with the details buried in
  // the developer console.
  private renderLastReport(el: HTMLElement): void {
    const report = this.plugin.lastReport;
    const at = this.plugin.lastReportAt;
    if (!report || !at) return;

    const section = el.createDiv({ cls: "obsync-report" });
    section.createDiv({ cls: "obsync-report-title", text: `Last sync — ${relativeTime(at)}` });

    const parts: string[] = [];
    if (report.pulled) parts.push(`↓ ${report.pulled} downloaded`);
    if (report.pushed) parts.push(`↑ ${report.pushed} uploaded`);
    if (report.deletedLocal) parts.push(`${report.deletedLocal} deleted locally`);
    if (report.deletedRemote) parts.push(`${report.deletedRemote} deleted remotely`);
    if (report.merged) parts.push(`⇄ ${report.merged} auto-merged`);
    if (report.conflicts) parts.push(`⚠ ${report.conflicts} conflict(s)`);
    if (!parts.length && !report.errors.length) parts.push("everything already in sync");
    for (const part of parts) section.createDiv({ cls: "obsync-report-line", text: part });

    if (report.unwritablePaths.length) {
      const box = section.createDiv({ cls: "obsync-errors" });
      box.createDiv({
        cls: "obsync-errors-title",
        text: `${report.unwritablePaths.length} file(s) can't sync to this device — names contain characters Obsidian forbids (\\ : * ? " < > |). Rename them on the device where they live:`,
      });
      for (const path of report.unwritablePaths.slice(0, 5)) {
        box.createDiv({ cls: "obsync-error-line", text: path });
      }
      if (report.unwritablePaths.length > 5) {
        box.createDiv({ cls: "obsync-error-line obsync-muted", text: `…and ${report.unwritablePaths.length - 5} more` });
      }
    }

    if (report.errors.length) {
      const errBox = section.createDiv({ cls: "obsync-errors" });
      errBox.createDiv({ cls: "obsync-errors-title", text: `${report.errors.length} error(s):` });
      for (const err of report.errors.slice(0, 5)) {
        errBox.createDiv({ cls: "obsync-error-line", text: err });
      }
      if (report.errors.length > 5) {
        errBox.createDiv({ cls: "obsync-error-line obsync-muted", text: `…and ${report.errors.length - 5} more (see console)` });
      }
    }
  }
}

function addRow(container: HTMLElement, label: string, value: string): void {
  const row = container.createDiv({ cls: "obsync-stat-row" });
  row.createSpan({ text: label, cls: "obsync-stat-label" });
  row.createSpan({ text: value, cls: "obsync-stat-value" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function relativeTime(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
