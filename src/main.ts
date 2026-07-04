import { Notice, Plugin, debounce } from "obsidian";
import { ApiClient } from "./api";
import { Codec, PlainCodec } from "./codec";
import { CryptoCodec, unlock } from "./crypto";
import { DEFAULT_SETTINGS, ObsyncSettings, ObsyncSettingTab, parseExcludes } from "./settings";
import { SyncEngine, SyncReport, SyncState, emptySyncState } from "./sync";
import { ObsyncStatusView, VIEW_TYPE_OBSYNC } from "./view";

interface PersistedData {
  settings: ObsyncSettings;
  syncState: SyncState;
}

export default class ObsyncPlugin extends Plugin {
  settings!: ObsyncSettings;
  syncState!: SyncState;
  api!: ApiClient;
  engine!: SyncEngine;
  statusBarEl!: HTMLElement;
  lastReport: SyncReport | null = null;
  lastReportAt: number | null = null;
  private pendingSync = false;

  async onload() {
    await this.loadPersisted();

    this.api = new ApiClient(
      () => this.settings.serverUrl,
      () => this.settings.apiToken
    );
    this.engine = new SyncEngine(
      this.app,
      this.api,
      () => this.resolveCodec(),
      () => this.settings.vaultId,
      this.syncState,
      {
        onStatus: (text) => this.setStatus(text),
        saveState: () => this.savePersisted(),
        excludes: () => parseExcludes(this.settings.excludedFolders),
      }
    );

    this.statusBarEl = this.addStatusBarItem();
    this.setStatus(this.settings.paused ? "paused" : "idle");

    this.addSettingTab(new ObsyncSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_OBSYNC, (leaf) => new ObsyncStatusView(leaf, this));
    this.addRibbonIcon("refresh-cw", "Syncian sync status", () => this.activateView());
    this.addCommand({ id: "open-status", name: "Open sync status", callback: () => this.activateView() });

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
    this.addCommand({ id: "toggle-pause", name: "Pause/resume sync", callback: () => this.togglePause() });

    const scheduleSync = debounce(() => void this.syncNow(true), 5_000, true);
    this.app.workspace.onLayoutReady(() => {
      if (!this.connected) return;
      void this.syncNow(true);
      this.registerEvent(this.app.vault.on("create", scheduleSync));
      this.registerEvent(this.app.vault.on("modify", scheduleSync));
      this.registerEvent(this.app.vault.on("delete", scheduleSync));
      this.registerEvent(this.app.vault.on("rename", scheduleSync));
      this.registerInterval(
        window.setInterval(() => this.syncNow(true), this.settings.syncIntervalMinutes * 60_000)
      );
    });
  }

  get connected(): boolean {
    return Boolean(this.settings.apiToken && this.settings.vaultId);
  }

  private codecCache: Codec | null = null;

  invalidateCodec() {
    this.codecCache = null;
  }

  // Plain vaults sync as-is; encrypted vaults (key_check set on the server)
  // require the passphrase to derive the key — otherwise the sync aborts.
  async resolveCodec(): Promise<Codec> {
    if (this.codecCache) return this.codecCache;
    if (!this.settings.vaultKeyCheck) {
      this.codecCache = new PlainCodec();
    } else {
      if (!this.settings.passphrase) {
        throw new Error("This vault is encrypted — enter its passphrase in Settings → Syncian.");
      }
      const key = await unlock(this.settings.passphrase, this.settings.vaultKeyCheck);
      this.codecCache = new CryptoCodec(key);
    }
    return this.codecCache;
  }

  // Auto-syncs (quiet=true) are suppressed while paused; a manual "Sync now"
  // still works — pressing the button is explicit enough intent.
  async syncNow(quiet = false) {
    if (!this.connected) {
      if (!quiet) new Notice("Syncian: connect your account first (Settings → Syncian).");
      return;
    }
    if (quiet && this.settings.paused) return;
    if (this.engine.busy) {
      // Don't just drop this — a file changed (or the periodic timer fired)
      // while a sync was already running, and nothing else guarantees that
      // change gets picked up soon. Run once more right after the current
      // cycle finishes instead of waiting for the next file event or the
      // next interval tick, which could be minutes away.
      this.pendingSync = true;
      if (!quiet) new Notice("Syncian: a sync is already running.");
      return;
    }
    try {
      this.setStatus("starting…");
      const report = await this.engine.sync();
      if (report) {
        this.lastReport = report;
        this.lastReportAt = Date.now();
      }
      if (!quiet && report) {
        new Notice(`Syncian: ↓${report.pulled} ↑${report.pushed}` +
          (report.conflicts ? `, ${report.conflicts} conflict(s)` : "") +
          (report.errors.length ? `, ${report.errors.length} error(s) — see console` : ""));
      }
      if (report?.errors.length) console.warn("[obsync] sync errors:", report.errors);
    } catch (e) {
      console.error("[obsync] sync failed:", e);
      this.lastReport = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, errors: [String(e)] };
      this.lastReportAt = Date.now();
      if (!quiet) new Notice(`Syncian: sync failed — ${e}`);
    } finally {
      if (this.settings.paused) this.setStatus("paused");
      if (this.pendingSync) {
        this.pendingSync = false;
        void this.syncNow(true);
      }
    }
  }

  async togglePause() {
    this.settings.paused = !this.settings.paused;
    await this.savePersisted();
    if (this.engine.busy) {
      this.refreshViews(); // pick up the new button label; status keeps streaming
    } else {
      this.setStatus(this.settings.paused ? "paused" : "idle");
    }
    new Notice(this.settings.paused
      ? "Syncian: sync paused — auto-sync is off until you resume."
      : "Syncian: sync resumed.");
    if (!this.settings.paused) void this.syncNow(true);
  }

  setStatus(text: string) {
    this.statusBarEl.setText(`Syncian: ${text}`);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSYNC)) {
      if (leaf.view instanceof ObsyncStatusView) leaf.view.setStatus(text);
    }
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSYNC)) {
      if (leaf.view instanceof ObsyncStatusView) leaf.view.render();
    }
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSYNC);
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE_OBSYNC, active: true });
    if (leaf) await this.app.workspace.revealLeaf(leaf);
  }

  async loadPersisted() {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
    this.syncState = data?.syncState ?? emptySyncState();
  }

  async savePersisted() {
    await this.saveData({ settings: this.settings, syncState: this.syncState } satisfies PersistedData);
  }

  // Kept for settings-tab convenience.
  async saveSettings() {
    await this.savePersisted();
  }
}
