import { Notice, Plugin, debounce } from "obsidian";
import { ApiClient } from "./api";
import { Codec, PlainCodec } from "./codec";
import { CryptoCodec, unlock } from "./crypto";
import { DEFAULT_SETTINGS, ObsyncSettings, ObsyncSettingTab, parseExcludes } from "./settings";
import { SyncEngine, SyncState, emptySyncState } from "./sync";
import { checkForUpdate } from "./updater";

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
    this.setStatus("idle");

    this.addSettingTab(new ObsyncSettingTab(this.app, this));

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
    this.addCommand({ id: "check-for-update", name: "Check for updates", callback: () => this.checkForPluginUpdate(true) });

    const scheduleSync = debounce(() => this.syncNow(true), 5_000, true);
    this.app.workspace.onLayoutReady(() => {
      this.checkForPluginUpdate();
      if (!this.connected) return;
      this.syncNow(true);
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
        throw new Error("This vault is encrypted — enter its passphrase in Settings → Obsyncian.");
      }
      const key = await unlock(this.settings.passphrase, this.settings.vaultKeyCheck);
      this.codecCache = new CryptoCodec(key);
    }
    return this.codecCache;
  }

  async syncNow(quiet = false) {
    if (!this.connected) {
      if (!quiet) new Notice("Obsyncian: connect your account first (Settings → Obsyncian).");
      return;
    }
    if (this.engine.busy) return;
    try {
      const report = await this.engine.sync();
      if (!quiet && report) {
        new Notice(`Obsyncian: ↓${report.pulled} ↑${report.pushed}` +
          (report.conflicts ? `, ${report.conflicts} conflict(s)` : "") +
          (report.errors.length ? `, ${report.errors.length} error(s) — see console` : ""));
      }
      if (report?.errors.length) console.warn("[obsync] sync errors:", report.errors);
    } catch (e) {
      console.error("[obsync] sync failed:", e);
      if (!quiet) new Notice(`Obsyncian: sync failed — ${e}`);
    }
  }

  setStatus(text: string) {
    this.statusBarEl.setText(`Obsyncian: ${text}`);
  }

  // Beta/manual-install update path: pulls the latest build from the same
  // server the plugin already talks to and overwrites its own files on
  // disk if it's newer, then reloads itself. Irrelevant once the plugin is
  // in the official community directory — Obsidian's own updater takes
  // over at that point.
  async checkForPluginUpdate(manual = false) {
    try {
      const dir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      const result = await checkForUpdate(
        this.settings.serverUrl,
        this.manifest.version,
        (path, data) => this.app.vault.adapter.write(path, data),
        dir
      );
      if (result.updated) {
        new Notice(`Obsyncian: updated to v${result.version} — reloading…`);
        await this.reloadSelf();
      } else if (manual) {
        new Notice("Obsyncian: already up to date.");
      }
    } catch (e) {
      console.warn("[obsync] update check failed:", e);
      if (manual) new Notice(`Obsyncian: update check failed — ${e}`);
    }
  }

  private async reloadSelf() {
    // Undocumented but stable API (same one BRAT/Hot Reload rely on) — a
    // disable+enable cycle re-reads main.js from disk. Falls back to asking
    // for a manual reload if a future Obsidian version removes it.
    const plugins = (this.app as unknown as { plugins?: { disablePlugin?: Function; enablePlugin?: Function } }).plugins;
    if (typeof plugins?.disablePlugin === "function" && typeof plugins?.enablePlugin === "function") {
      await plugins.disablePlugin(this.manifest.id);
      await plugins.enablePlugin(this.manifest.id);
    } else {
      new Notice("Obsyncian: please reload Obsidian to apply the update.");
    }
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
