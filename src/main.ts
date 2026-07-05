import { Notice, Platform, Plugin, debounce } from "obsidian";
import { ApiClient } from "./api";
import { AdapterBaseStore } from "./basestore";
import { AdapterConfigStore } from "./configstore";
import { Codec, PlainCodec } from "./codec";
import { CryptoCodec, unlock } from "./crypto";
import { DEFAULT_SETTINGS, ObsyncSettings, ObsyncSettingTab, clampSyncInterval, parseExcludes } from "./settings";
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
  baseStore!: AdapterBaseStore;
  configStore!: AdapterConfigStore;
  private pendingSync = false;

  async onload() {
    await this.loadPersisted();

    this.api = new ApiClient(
      () => this.settings.serverUrl,
      () => this.settings.apiToken
    );
    const configDir = this.app.vault.configDir;
    const pluginDir = this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`;
    this.baseStore = new AdapterBaseStore(this.app.vault.adapter, `${pluginDir}/base`);
    // Never sync: the plugin's own folder (its data.json holds THIS device's
    // apiToken/passphrase, and each device has a distinct token — syncing it
    // would leak secrets and clobber device identity) and the device-specific
    // window layout files.
    const configExcludes = [
      pluginDir,
      `${configDir}/workspace.json`,
      `${configDir}/workspace-mobile.json`,
    ];
    this.configStore = new AdapterConfigStore(this.app.vault.adapter, configDir, configExcludes);
    this.engine = new SyncEngine(
      this.app,
      this.api,
      () => this.resolveCodec(),
      () => this.settings.vaultId,
      this.syncState,
      this.baseStore,
      this.configStore,
      {
        onStatus: (text) => this.setStatus(text),
        saveState: () => this.savePersisted(),
        excludes: () => parseExcludes(this.settings.excludedFolders),
        syncConfig: () => this.settings.syncPlugins,
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

    // onLayoutReady fires exactly once per Obsidian session — it used to bail
    // out here if not yet connected, which meant a device that installs the
    // plugin and connects *within the same session* (the normal first-time
    // flow: install → log in → link a vault, no restart in between) never
    // got its file-watch listeners or the fallback timer registered at all,
    // silently, until the next full Obsidian restart. syncNow() already
    // no-ops quietly when not connected, so there's nothing unsafe about
    // always registering — it just does nothing useful until you actually
    // connect, then works immediately without needing a restart.
    const scheduleSync = debounce(() => void this.syncNow(true), 5_000, true);
    this.app.workspace.onLayoutReady(() => {
      void this.gcBaseStore();
      void this.syncNow(true);
      this.registerEvent(this.app.vault.on("create", scheduleSync));
      this.registerEvent(this.app.vault.on("modify", scheduleSync));
      this.registerEvent(this.app.vault.on("delete", scheduleSync));
      this.registerEvent(this.app.vault.on("rename", scheduleSync));
      this.registerInterval(
        window.setInterval(() => void this.syncNow(true), this.settings.syncIntervalSeconds * 1000)
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
          (report.merged ? `, ${report.merged} merged` : "") +
          (report.conflicts ? `, ${report.conflicts} conflict(s)` : "") +
          (report.errors.length ? `, ${report.errors.length} error(s) — see console` : ""));
      }
      if (report?.errors.length) {
        console.warn("[obsync] sync errors:", report.errors);
        this.reportError("sync", report.errors.slice(0, 5).join("\n"));
      }
    } catch (e) {
      console.error("[obsync] sync failed:", e);
      this.lastReport = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, merged: 0, errors: [String(e)], unwritablePaths: [] };
      this.lastReportAt = Date.now();
      this.reportError("sync failed", String(e));
      if (!quiet) new Notice(`Syncian: sync failed — ${e}`);
    } finally {
      if (this.settings.paused) this.setStatus("paused");
      if (this.pendingSync) {
        this.pendingSync = false;
        void this.syncNow(true);
      }
    }
  }

  // Opt-out, on by default. Fire-and-forget: never awaited by a caller,
  // never throws — a failure to report an error must never itself become
  // an error. Only technical detail goes over the wire (error text, plugin
  // version, coarse OS), never note content or file names.
  reportError(context: string, message: string) {
    if (!this.settings.reportErrors || !this.connected) return;
    this.api
      .reportError({ context, message, plugin_version: this.manifest.version, platform: platformString() })
      .catch((e) => console.warn("[obsync] failed to report error:", e));
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

  // Wipe all shadow bases — must accompany every syncState reset (logout,
  // unlink, relink): bases are keyed by file_id and a different vault's ids
  // must never be able to collide with fresh ones.
  async clearBaseStore() {
    for (const id of await this.baseStore.list()) await this.baseStore.remove(id);
  }

  // One-shot at startup: drop bases whose file is no longer in the index
  // (deleted while the plugin was off, or left behind by an old bug).
  private async gcBaseStore() {
    for (const id of await this.baseStore.list()) {
      if (!this.syncState.files[id]) await this.baseStore.remove(id);
    }
  }

  async loadPersisted() {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
    // Older builds stored the interval in minutes; carry the value over once.
    const stored = data?.settings as { syncIntervalMinutes?: number; syncIntervalSeconds?: number } | undefined;
    if (stored?.syncIntervalMinutes && !stored.syncIntervalSeconds) {
      this.settings.syncIntervalSeconds = clampSyncInterval(stored.syncIntervalMinutes * 60);
    }
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

function platformString(): string {
  if (Platform.isIosApp) return "ios";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isMacOS) return "macos";
  if (Platform.isWin) return "windows";
  if (Platform.isLinux) return "linux";
  return Platform.isMobile ? "mobile-other" : "desktop-other";
}
