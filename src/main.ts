import { Notice, Platform, Plugin, TFile, debounce } from "obsidian";
import { ApiClient } from "./api";
import { AdapterBaseStore } from "./basestore";
import { AdapterConfigStore } from "./configstore";
import { Codec, PlainCodec } from "./codec";
import { CryptoCodec, unlock } from "./crypto";
import { DEFAULT_SETTINGS, ObsyncSettings, ObsyncSettingTab, clampSyncInterval, parseExcludes } from "./settings";
import { ChangeSignal, LocalChanges } from "./signal";
import { hostOf, noteConnectivity } from "./connectivity";
import { SyncEngine, SyncReport, SyncState, adoptVaultState, emptySyncState } from "./sync";
import { VaultEncryption } from "./encrypt";
import { ObsyncStatusView, VIEW_TYPE_OBSYNC } from "./view";
import { WhatsNewModal, compareVersions, notesFor, notesSince } from "./whatsnew";

interface PersistedData {
  settings: ObsyncSettings;
  syncState: SyncState;
  // Manifest version the release-notes popup was last shown for. Undefined
  // until the first run that carries this feature — see maybeShowWhatsNew.
  lastNotesVersion?: string;
}

// Backoff for pendingSync's chained re-run when the previous cycle(s) errored
// — without this, a persistently-failing sync (e.g. a file stuck over a plan
// limit) re-triggers itself with zero delay, forever. Doubles per
// consecutive error up to the cap; a single clean cycle resets it.
const PENDING_BACKOFF_BASE_MS = 2_000;
const PENDING_BACKOFF_MAX_MS = 60_000;
const WAKE_SYNC_AFTER_MS = 60_000;
const PLAN_CHECK_EVERY_MS = 15 * 60_000;
const LAST_SYNC_SAVE_EVERY_MS = 10 * 60_000;

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
  private lastNotesVersion?: string;
  private pendingSync = false;
  // Consecutive cycles (chained via pendingSync) that ended in error — resets
  // to 0 on any clean cycle. Drives the backoff below; a healthy chain (new
  // edits arriving while a sync is in flight) still re-runs instantly.
  private pendingSyncErrorStreak = 0;
  // Held-deletion count the user was last told about, so the 5-minute timer
  // doesn't repeat the same notice every cycle while they decide.
  private heldDeletionsNotified = 0;
  private frozenNotified = false;
  private signal!: ChangeSignal;
  // Highest revision the server has announced that we haven't acted on.
  private signalledRevision = 0;
  // What savePersisted last wrote, to skip rewriting an unchanged data.json.
  private lastSaved = "";
  private lastSavedSyncAt = 0;

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
        conflictMode: () => this.settings.conflictResolution,
      }
    );

    // Server-pushed "the vault changed": pull now rather than at the next
    // interval tick. Wait a moment first — a device pushing a batch commits
    // several times in a row — and never start from inside a running sync.
    const actOnSignal: () => unknown = debounce(() => {
      if (this.engine.busy) {
        actOnSignal();
        return;
      }
      const revision = this.signalledRevision;
      this.signalledRevision = 0;
      // Our own commit echoed back, or something a pull has already covered.
      if (this.engine.isOwnRevision(revision) || revision <= this.syncState.cursor) return;
      void this.syncNow(true);
    }, 1_000, true);
    this.signal = new ChangeSignal({
      serverUrl: () => this.settings.serverUrl,
      token: () => this.settings.apiToken,
      vaultId: () => this.settings.vaultId,
      onRevision: (revision) => {
        this.signalledRevision = Math.max(this.signalledRevision, revision);
        actOnSignal();
      },
      onReconnect: () => void this.syncNow(true),
    });
    this.register(() => this.signal.stop());

    this.encryption = new VaultEncryption({
      app: this.app,
      api: this.api,
      engine: this.engine,
      configStore: this.configStore,
      settings: () => this.settings,
      syncState: () => this.syncState,
      resolveCodec: () => this.resolveCodec(),
      invalidateCodec: () => this.invalidateCodec(),
      save: () => this.savePersisted(),
      status: (text) => this.setStatus(text),
      notice: (text, ms) => new Notice(text, ms),
      reportError: (context, message) => this.reportError(context, message),
      changed: () => this.refreshViews(),
      syncAfter: () => void this.syncNow(true),
    });

    this.statusBarEl = this.addStatusBarItem();
    this.setStatus(this.settings.paused ? "paused" : "idle");

    this.addSettingTab(new ObsyncSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_OBSYNC, (leaf) => new ObsyncStatusView(leaf, this));
    this.addRibbonIcon("refresh-cw", "Syncian sync status", () => this.activateView());
    this.addCommand({ id: "open-status", name: "Open sync status", callback: () => this.activateView() });

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
    this.addCommand({ id: "confirm-deletions", name: "Confirm held deletions", callback: () => this.resolveHeldDeletions("delete") });
    this.addCommand({ id: "restore-missing", name: "Restore missing files from the server", callback: () => this.resolveHeldDeletions("restore") });
    this.addCommand({ id: "toggle-pause", name: "Pause/resume sync", callback: () => this.togglePause() });
    this.addCommand({ id: "whats-new", name: "What's new", callback: () => new WhatsNewModal(this, notesFor(this.manifest.version)).open() });

    // onLayoutReady fires exactly once per Obsidian session — it used to bail
    // out here if not yet connected, which meant a device that installs the
    // plugin and connects *within the same session* (the normal first-time
    // flow: install → log in → link a vault, no restart in between) never
    // got its file-watch listeners or the fallback timer registered at all,
    // silently, until the next full Obsidian restart. syncNow() already
    // no-ops quietly when not connected, so there's nothing unsafe about
    // always registering — it just does nothing useful until you actually
    // connect, then works immediately without needing a restart.
    //
    // The sync engine's own writes fire these events too. They're collected
    // and, when the debounce fires, checked against what the engine says it
    // did — only a change it didn't make is worth a sync.
    const changes = new LocalChanges();
    const scheduleSync = debounce(() => {
      if (changes.takeReal((path, mtime) => this.engine.isOwnChange(path, mtime))) void this.syncNow(true);
    }, 5_000, true);
    this.app.workspace.onLayoutReady(() => {
      void this.maybeShowWhatsNew();
      void this.gcBaseStore();
      if (this.settings.encryption) void this.resumeEncryption();
      else void this.syncNow(true);
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return; // an empty folder is nothing to sync
        changes.note(file.path, file.stat.mtime);
        scheduleSync();
      }));
      this.registerEvent(this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) changes.note(file.path, file.stat.mtime);
        scheduleSync();
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) changes.note(file.path, null);
        else changes.noteUnknown();
        scheduleSync();
      }));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          changes.note(oldPath, null);
          changes.note(file.path, file.stat.mtime);
        } else {
          changes.noteUnknown();
        }
        scheduleSync();
      }));
      this.registerInterval(
        window.setInterval(() => void this.syncNow(true), this.settings.syncIntervalSeconds * 1000)
      );
      // Back online, or back from sleep / the background: finish what a lost
      // connection interrupted right away instead of at the next timer tick.
      // Coming back to the window alone only syncs if it's been a while.
      this.registerDomEvent(window, "online", () => void this.syncNow(true));
      // Paused for lack of a plan: look every so often whether one has been
      // bought, and carry on by itself — not only after "Sync now".
      this.registerInterval(window.setInterval(() => void this.resumeIfPaid(), PLAN_CHECK_EVERY_MS));
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        const unfinished = this.lastReport?.interrupted || this.lastReport?.offline;
        const stale = Date.now() - (this.lastReportAt ?? 0) > WAKE_SYNC_AFTER_MS;
        if (unfinished || stale) void this.syncNow(true);
      });
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
      this.signal.stop();
      if (!quiet) new Notice("Syncian: connect your account first (Settings → Syncian).");
      return;
    }
    this.signal.refresh();
    // An encryption on this device runs its own sync cycles; a vault that
    // became encrypted elsewhere waits for its passphrase. Neither is helped
    // by a sync started from outside.
    if (this.settings.encryption) {
      if (!quiet) new Notice("Syncian: this vault is being encrypted — see Settings → Syncian.");
      return;
    }
    if (this.settings.needsPassphrase) {
      if (!quiet) new Notice("Syncian: this vault is now end-to-end encrypted — enter its passphrase in Settings → Syncian.");
      this.setStatus("passphrase needed");
      return;
    }
    // Auto-sync is held when the user paused, when we're waiting on a storage
    // payment (quota_exceeded), and when the account has no active plan
    // (payment_required). Either way, only an explicit "Sync now" gets past
    // this — see below, where a manual run clears the billing hold. Without
    // the billing holds, every timer tick would re-hit the same rejection and
    // report it again: the 1.0.14 quota storm.
    if (quiet && (this.settings.paused || this.settings.quotaBlocked || this.settings.paymentBlocked)) return;
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
    // An explicit "Sync now" is a good moment to retry anything that hit a
    // permanent plan limit last time — e.g. right after upgrading — without
    // waiting for the file to change or Obsidian to restart. It's also the
    // "I've paid, resume" action: drop the storage hold so the cycle actually
    // runs (it re-sets below if we're still over quota).
    if (!quiet) {
      this.engine.clearBlocked();
      this.settings.quotaBlocked = false;
      this.settings.paymentBlocked = false;
    }
    try {
      this.setStatus("starting…");
      const report = await this.engine.sync();
      if (report) {
        this.lastReport = report;
        this.lastReportAt = Date.now();
      }
      // A lost connection isn't a failure to back off from: the next attempt
      // comes when the device is back online (see the "online" listener).
      this.pendingSyncErrorStreak = report?.errors.length ? this.pendingSyncErrorStreak + 1 : 0;
      if (!quiet && report) {
        if (report.offline) new Notice("Syncian: no connection — will sync as soon as it's back.");
        else new Notice(`Syncian: ↓${report.pulled} ↑${report.pushed}` +
          (report.renamed ? `, ${report.renamed} renamed` : "") +
          (report.merged ? `, ${report.merged} merged` : "") +
          (report.conflicts ? `, ${report.conflicts} conflict(s)` : "") +
          (report.interrupted ? `, ${report.interrupted} to finish when the connection is back` : "") +
          (report.errors.length ? `, ${report.errors.length} error(s) — see console` : ""));
      }
      if (report?.signedOut) {
        await this.signedOut();
        return;
      }
      if (report) {
        const due = noteConnectivity(this.settings, report, Date.now(), hostOf(this.settings.serverUrl));
        if (due) this.reportError("connectivity", due);
        await this.savePersisted();
      }
      if (report?.errors.length) {
        console.warn("[obsync] sync errors:", report.errors);
        this.reportError("sync", report.reportable.slice(0, 5).join("\n"));
      }
      // Out of storage: hold auto-sync and tell the user, once. We deliberately
      // don't reportError() this — it's a billing state, not a bug, and it's
      // what used to spam the ops channel every cycle. The server has already
      // pinged the user's Telegram to pay; here we just stop syncing until they
      // do and press Sync now again.
      // No active plan. Same treatment as running out of storage: pause,
      // say so once, and never reportError() it — it's a billing state, not
      // a bug, and the server has already nudged them in the bot.
      if (report?.paymentRequired) {
        if (!this.settings.paymentBlocked) {
          this.settings.paymentBlocked = true;
          await this.savePersisted();
        }
        new Notice(
          "Syncian: sync needs an active plan — paused. Open the Obsyncian bot, run /upgrade, then press “Sync now”. Your notes stay on this device.",
          10_000
        );
      }
      if (report?.vaultReplaced) {
        await this.encryption.follow(report.vaultReplaced);
        return;
      }
      if (report?.vaultFrozen) {
        if (!quiet || !this.frozenNotified) {
          new Notice("Syncian: this vault is being encrypted on another device. Your changes here will sync once that's done.", 10_000);
        }
        this.frozenNotified = true;
        this.setStatus("waiting — vault being encrypted elsewhere");
      } else if (report) {
        this.frozenNotified = false;
      }
      const held = report?.heldDeletions ?? 0;
      if (held && (!quiet || held !== this.heldDeletionsNotified)) {
        new Notice(
          `Syncian: ${held} synced files are missing from this device. Nothing was deleted on the server. ` +
          "If you deleted them on purpose, run “Confirm held deletions”; to get them back, run “Restore missing files from the server” (command palette or the Syncian sidebar).",
          15_000
        );
      }
      if (report) this.heldDeletionsNotified = held;
      if (report?.quotaBlocked) {
        if (!this.settings.quotaBlocked) {
          this.settings.quotaBlocked = true;
          await this.savePersisted();
        }
        new Notice(
          "Syncian: storage full — sync paused. Free up space or upgrade, then press “Sync now” to resume.",
          10_000
        );
      }
    } catch (e) {
      this.pendingSyncErrorStreak++;
      console.error("[obsync] sync failed:", e);
      this.lastReport = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, merged: 0, renamed: 0, errors: [String(e)], reportable: [String(e)], deferred: [], unwritablePaths: [], quotaBlocked: false, paymentRequired: false, heldDeletions: 0, interrupted: 0, offline: false, signedOut: false, vaultFrozen: false, vaultReplaced: null };
      this.lastReportAt = Date.now();
      this.reportError("sync failed", String(e));
      if (!quiet) new Notice(`Syncian: sync failed — ${e}`);
    } finally {
      if (this.settings.paused) this.setStatus("paused");
      else if (this.settings.paymentBlocked) this.setStatus("plan required — paused");
      else if (this.settings.quotaBlocked) this.setStatus("storage full — paused");
      if (this.pendingSync) {
        this.pendingSync = false;
        if (this.pendingSyncErrorStreak > 0) {
          const delay = Math.min(PENDING_BACKOFF_MAX_MS, PENDING_BACKOFF_BASE_MS * 2 ** (this.pendingSyncErrorStreak - 1));
          window.setTimeout(() => void this.syncNow(true), delay);
        } else {
          void this.syncNow(true);
        }
      }
    }
  }

  // ---- encrypting a vault / changing its passphrase ----------------------
  //
  // Both copy the vault into a new one under a new key (see encrypt.ts and
  // the server's StartVaultEncryption): start → catch up → copy → switch this
  // device over → finish (the server deletes the old vault and redirects the
  // other devices). Every step is recorded in settings.encryption, so a
  // restart resumes rather than starting over.

  encryption!: VaultEncryption;

  encryptVault(passphrase: string): Promise<void> {
    return this.encryption.encrypt(passphrase);
  }

  resumeEncryption(): Promise<void> {
    new Notice("Syncian: resuming the vault encryption.");
    return this.encryption.resume();
  }

  cancelEncryption(): Promise<void> {
    return this.encryption.cancel();
  }

  get encryptionRunningNow(): boolean {
    return this.encryption.running;
  }

  enterPassphrase(passphrase: string): Promise<void> {
    return this.encryption.enterPassphrase(passphrase);
  }

  // The user's answer to a held mass deletion — see SyncEngine.push.
  resolveHeldDeletions(decision: "delete" | "restore") {
    this.engine.resolveHeldDeletions(decision);
    void this.syncNow();
  }

  async resumeIfPaid(): Promise<void> {
    if (!this.connected || !this.settings.paymentBlocked) return;
    try {
      const me = await this.api.me();
      // Servers before sync_entitled existed: any paid plan.
      const entitled = me.sync_entitled ?? me.plan !== "free";
      if (!entitled) return;
    } catch {
      return; // offline, or the server's busy: the next check will do
    }
    this.settings.paymentBlocked = false;
    await this.savePersisted();
    new Notice("Syncian: your plan is active — sync resumed.");
    void this.syncNow(true);
  }

  // The server stopped accepting this device's login. Log out the same way
  // the Log out button does — the index stays, so logging back in and
  // linking the same vault picks up where it left off — and say so once,
  // instead of failing (and reporting the failure) every few minutes.
  private async signedOut(): Promise<void> {
    this.signal.stop();
    this.settings.apiToken = "";
    this.settings.identity = "";
    this.settings.vaultId = "";
    this.settings.vaultName = "";
    this.settings.vaultKeyCheck = "";
    this.invalidateCodec();
    await this.savePersisted();
    this.setStatus("signed out — log in again");
    this.refreshViews();
    new Notice(
      "Syncian: this device was signed out of your Obsyncian account. Log in again in Settings → Syncian and pick your vault — sync carries on where it left off.",
      0
    );
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

  // Point the index at `vaultId`, clearing it only when that's a different
  // vault than the one it was built against. Every link/create/unlink path
  // goes through here so the decision lives in exactly one place.
  //
  // Clearing costs more than it looks: the next pull replays from cursor 0
  // with an empty index while every file is still on disk, and sync.ts's
  // 3-way merge is skipped entirely when there's no index entry (and the
  // shadow bases are gone too) — so every file that isn't byte-identical to
  // the server lands as a "(conflict …)" copy, ignoring the user's
  // "Automatically merge" setting. Re-linking the same vault must therefore
  // resume, not replay.
  async adoptVault(vaultId: string) {
    if (adoptVaultState(this.syncState, vaultId)) return;
    await this.clearBaseStore();
  }

  // One-shot at startup: drop bases whose file is no longer in the index
  // (deleted while the plugin was off, or left behind by an old bug).
  private async gcBaseStore() {
    for (const id of await this.baseStore.list()) {
      if (!this.syncState.files[id]) await this.baseStore.remove(id);
    }
  }

  // Show the release-notes popup once per upgrade. On the very first run that
  // carries this feature `lastNotesVersion` is undefined — we set the baseline
  // silently so existing users don't get a retroactive popup for changes
  // they've already been using; the popup only fires on the *next* upgrade.
  private async maybeShowWhatsNew() {
    const current = this.manifest.version;
    if (this.lastNotesVersion && this.settings.showReleaseNotes && compareVersions(current, this.lastNotesVersion) > 0) {
      const entries = notesSince(this.lastNotesVersion, current);
      if (entries.length) new WhatsNewModal(this, entries).open();
    }
    if (this.lastNotesVersion !== current) {
      this.lastNotesVersion = current;
      await this.savePersisted();
    }
  }

  async loadPersisted() {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
    // A copy, not DEFAULT_SETTINGS' own object, which every load would share.
    this.settings.publishSites = { ...(this.settings.publishSites ?? {}) };
    this.lastNotesVersion = data?.lastNotesVersion;
    // Older builds stored the interval in minutes; carry the value over once.
    const stored = data?.settings as { syncIntervalMinutes?: number; syncIntervalSeconds?: number } | undefined;
    if (stored?.syncIntervalMinutes && !stored.syncIntervalSeconds) {
      this.settings.syncIntervalSeconds = clampSyncInterval(stored.syncIntervalMinutes * 60);
    }
    this.syncState = data?.syncState ?? emptySyncState();
    // Indexes written before syncState carried a vaultId: adopt the vault
    // that's currently linked, so the first re-link after upgrading resumes
    // instead of replaying (which is the whole point of adoptVault).
    if (!this.syncState.vaultId && this.settings.vaultId) {
      this.syncState.vaultId = this.settings.vaultId;
    }
  }

  // The sync engine calls this several times a cycle, and most cycles change
  // nothing — so don't rewrite data.json (the whole index, megabytes on a big
  // vault) unless something in it actually differs. lastSyncAt moves every
  // cycle by design; on its own it's only worth a write once in a while.
  async savePersisted() {
    const data = { settings: this.settings, syncState: this.syncState, lastNotesVersion: this.lastNotesVersion } satisfies PersistedData;
    const { lastSyncAt, ...index } = this.syncState;
    const snapshot = JSON.stringify({ ...data, syncState: index });
    const syncedAt = lastSyncAt ?? 0;
    if (snapshot === this.lastSaved && syncedAt - this.lastSavedSyncAt < LAST_SYNC_SAVE_EVERY_MS) return;
    await this.saveData(data);
    this.lastSaved = snapshot;
    this.lastSavedSyncAt = syncedAt;
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
