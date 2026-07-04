import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { vaultLabel } from "./api";
import { makeKeyCheck, unlock } from "./crypto";
import type ObsyncPlugin from "./main";
import { emptySyncState } from "./sync";

export interface ObsyncSettings {
  serverUrl: string;
  email: string;
  identity: string;
  apiToken: string;
  vaultId: string;
  vaultName: string;
  vaultKeyCheck: string; // non-empty = E2EE vault; holds salt + key-check JSON
  passphrase: string;
  syncIntervalMinutes: number;
  excludedFolders: string;
  paused: boolean;
}

export const DEFAULT_SETTINGS: ObsyncSettings = {
  serverUrl: "https://obsyncian.com",
  email: "",
  identity: "",
  apiToken: "",
  vaultId: "",
  vaultName: "",
  vaultKeyCheck: "",
  passphrase: "",
  syncIntervalMinutes: 5,
  excludedFolders: "",
  paused: false,
};

export function parseExcludes(excludedFolders: string): string[] {
  return excludedFolders
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type FetchState<T> = null | { error: string } | T;

export class ObsyncSettingTab extends PluginSettingTab {
  plugin: ObsyncPlugin;
  private pendingCode = "";
  private pendingVaultName: string | null = null;
  // Nothing here fires a network request on its own — every section below
  // starts idle and only calls the API in response to a button press. That's
  // deliberate: opening Settings must never hang waiting on a server.
  private telegramState: FetchState<{ bot: string }> = null;
  private vaultsState: FetchState<{ vaults: import("./api").VaultInfo[] }> = null;

  constructor(app: App, plugin: ObsyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Obsyncian API endpoint. Leave default unless self-hosting.")
      .addText((text) =>
        text.setValue(s.serverUrl).onChange(async (value) => {
          s.serverUrl = value.trim();
          await this.plugin.saveSettings();
        })
      );

    if (!s.apiToken) {
      this.displayLogin(containerEl);
      return;
    }

    new Setting(containerEl)
      .setName("Account")
      .setDesc(s.identity || s.email)
      .addButton((btn) =>
        btn.setButtonText("Log out").setWarning().onClick(async () => {
          s.apiToken = "";
          s.identity = "";
          s.vaultId = "";
          s.vaultName = "";
          s.vaultKeyCheck = "";
          Object.assign(this.plugin.syncState, emptySyncState());
          this.plugin.invalidateCodec();
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (!s.vaultId) {
      this.displayVaultLink(containerEl);
      return;
    }

    new Setting(containerEl)
      .setName("Synced vault")
      .setDesc(
        `"${s.vaultName}" — all changes in this vault sync automatically. ` +
        (s.vaultKeyCheck ? "End-to-end encrypted." : "Not encrypted.")
      )
      .addButton((btn) =>
        btn.setButtonText("Unlink").setWarning().onClick(async () => {
          s.vaultId = "";
          s.vaultName = "";
          s.vaultKeyCheck = "";
          Object.assign(this.plugin.syncState, emptySyncState());
          this.plugin.invalidateCodec();
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (s.vaultKeyCheck) {
      new Setting(containerEl)
        .setName("Encryption passphrase")
        .setDesc("Needed to decrypt this vault. Stored on this device only.")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(s.passphrase).onChange(async (value) => {
            s.passphrase = value;
            this.plugin.invalidateCodec();
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Minutes between automatic syncs.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 60, 1)
          .setValue(s.syncIntervalMinutes)
          .onChange(async (value) => {
            s.syncIntervalMinutes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folder paths that never sync (e.g. Private, Scratch). Excluding a synced folder does not delete it from other devices.")
      .addTextArea((text) =>
        text.setPlaceholder("Private, Scratch").setValue(s.excludedFolders).onChange(async (value) => {
          s.excludedFolders = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync now")
      .addButton((btn) =>
        btn.setButtonText("Sync").setCta().onClick(() => this.plugin.syncNow())
      );
  }

  private displayLogin(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Email")
      .setDesc("A 6-digit login code will be sent to this address.")
      .addText((text) =>
        text.setPlaceholder("you@example.com").setValue(s.email).onChange(async (value) => {
          s.email = value.trim();
          await this.plugin.saveSettings();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Send code").setCta().onClick(async () => {
          try {
            await this.plugin.api.requestCode(s.email);
            new Notice("Obsyncian: code sent — check your inbox.");
          } catch (e) {
            new Notice(`Obsyncian: ${e}`);
          }
        })
      );

    new Setting(containerEl)
      .setName("Login code")
      .addText((text) => text.setPlaceholder("123456").onChange((v) => (this.pendingCode = v.trim())))
      .addButton((btn) =>
        btn.setButtonText("Verify").setCta().onClick(async () => {
          try {
            const res = await this.plugin.api.verify(s.email, this.pendingCode, this.deviceName());
            await this.completeLogin(res.token, res.identity ?? res.email, res.email);
          } catch (e) {
            new Notice(`Obsyncian: ${e}`);
          }
        })
      );

    this.displayTelegramLogin(containerEl);
  }

  // Zero-email alternative: the bot hands out codes like "K3-482910". Stays
  // fully idle (no request) until "Continue with Telegram" is pressed.
  private displayTelegramLogin(containerEl: HTMLElement): void {
    const state = this.telegramState;

    if (state && "bot" in state) {
      new Setting(containerEl)
        .setName("Or log in with Telegram")
        .setDesc(`Open @${state.bot}, press Start, and enter the code it sends you.`)
        .addButton((btn) => btn.setButtonText(`Open @${state.bot}`).onClick(() => window.open(`https://t.me/${state.bot}`)));

      let tgCode = "";
      new Setting(containerEl)
        .setName("Telegram code")
        .addText((text) => text.setPlaceholder("K3-482910").onChange((v) => (tgCode = v.trim())))
        .addButton((btn) =>
          btn.setButtonText("Verify").setCta().onClick(async () => {
            try {
              const res = await this.plugin.api.verifyTelegram(tgCode, this.deviceName());
              await this.completeLogin(res.token, res.identity, res.email ?? "");
            } catch (e) {
              new Notice(`Obsyncian: ${e}`);
            }
          })
        );
      return;
    }

    const setting = new Setting(containerEl)
      .setName("Or log in with Telegram")
      .setDesc(
        state && "error" in state
          ? `Couldn't reach the server: ${state.error}`
          : "No email needed — get a login code from our Telegram bot."
      );

    setting.addButton((btn) =>
      btn.setButtonText(state && "error" in state ? "Retry" : "Continue with Telegram").onClick(async () => {
        btn.setDisabled(true).setButtonText("Checking…");
        try {
          const { telegram_bot, telegram_login } = await this.plugin.api.config();
          this.telegramState =
            telegram_login && telegram_bot ? { bot: telegram_bot } : { error: "not available on this server" };
        } catch (e) {
          this.telegramState = { error: e instanceof Error ? e.message : String(e) };
        }
        this.display();
      })
    );
  }

  private deviceName(): string {
    return `${Platform.isMobile ? "Mobile" : "Desktop"} · ${this.app.vault.getName()}`;
  }

  private async completeLogin(token: string, identity: string, email: string): Promise<void> {
    const s = this.plugin.settings;
    s.apiToken = token;
    s.identity = identity;
    if (email) s.email = email;
    await this.plugin.saveSettings();
    new Notice("Obsyncian: logged in.");
    this.display();
  }

  private displayVaultLink(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    if (this.pendingVaultName === null) this.pendingVaultName = this.app.vault.getName();

    new Setting(containerEl)
      .setName("Encryption passphrase")
      .setDesc(
        "Encrypts everything on this device before upload — we can never read your notes. " +
        "You'll need it on every device; if you lose it, your synced data is unrecoverable. " +
        "Leave empty to sync unencrypted."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("passphrase").setValue(s.passphrase).onChange(async (value) => {
          s.passphrase = value;
          this.plugin.invalidateCodec();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Vault name")
      .setDesc("Shown in the vault picker on other devices. Defaults to this folder's name.")
      .addText((text) =>
        text.setValue(this.pendingVaultName!).onChange((value) => {
          this.pendingVaultName = value;
        })
      );

    new Setting(containerEl)
      .setName("Link a vault")
      .setDesc("Create a new synced vault on the server, or pick an existing one to pull it into this vault.")
      .addButton((btn) =>
        btn.setButtonText("Create vault").setCta().onClick(async () => {
          // Encryption must be a decision, not an accident of an empty field:
          // with no passphrase, make the user explicitly pick plaintext.
          if (!s.passphrase) {
            new UnencryptedConfirmModal(this.app, (syncPlaintext) => {
              if (syncPlaintext) void this.createVault();
              // "Set a passphrase" → just stay on the tab; field is right above.
            }).open();
            return;
          }
          await this.createVault();
        })
      );

    this.displayExistingVaults(containerEl, s);
  }

  private async createVault(): Promise<void> {
    const s = this.plugin.settings;
    const name = this.pendingVaultName?.trim() || this.app.vault.getName();
    try {
      let keyCheck: string | undefined;
      if (s.passphrase) {
        ({ keyCheck } = await makeKeyCheck(s.passphrase));
      }
      const vault = await this.plugin.api.createVault(name, keyCheck);
      s.vaultId = String(vault.id);
      s.vaultName = vault.name;
      s.vaultKeyCheck = keyCheck ?? "";
      this.plugin.invalidateCodec();
      await this.plugin.saveSettings();
      new Notice(`Obsyncian: vault "${vault.name}" created and linked${keyCheck ? " (end-to-end encrypted)" : " (unencrypted)"}.`);
      this.display();
    } catch (e) {
      new Notice(`Obsyncian: ${e}`);
    }
  }

  // Only calls the API once "Load existing vaults" is pressed.
  private displayExistingVaults(containerEl: HTMLElement, s: ObsyncSettings): void {
    const state = this.vaultsState;

    if (state && "vaults" in state) {
      const existing = new Setting(containerEl).setName("Existing vaults");
      if (!state.vaults.length) {
        existing.setDesc("No vaults on this account yet.");
        return;
      }
      existing.addDropdown((dd) => {
        for (const v of state.vaults) dd.addOption(String(v.id), vaultLabel(v));
        dd.onChange(async (id) => {
          const vault = state.vaults.find((v) => String(v.id) === id);
          if (!vault) return;
          if (vault.key_check) {
            if (!s.passphrase) {
              new Notice("Obsyncian: this vault is encrypted — enter its passphrase above first.");
              return;
            }
            try {
              await unlock(s.passphrase, vault.key_check);
            } catch (e) {
              new Notice(`Obsyncian: ${e instanceof Error ? e.message : e}`);
              return;
            }
          }
          s.vaultId = id;
          s.vaultName = vaultLabel(vault); // shared vaults show as "@owner — Name" everywhere
          s.vaultKeyCheck = vault.key_check ?? "";
          Object.assign(this.plugin.syncState, emptySyncState());
          this.plugin.invalidateCodec();
          await this.plugin.saveSettings();
          new Notice(`Obsyncian: linked "${s.vaultName}" — next sync will merge its contents into this vault.`);
          this.display();
        });
        dd.setValue("");
      });
      return;
    }

    const setting = new Setting(containerEl)
      .setName("Existing vaults")
      .setDesc(state && "error" in state ? `Couldn't load vaults: ${state.error}` : "Pick a vault synced from another device.");

    setting.addButton((btn) =>
      btn.setButtonText(state && "error" in state ? "Retry" : "Load existing vaults").onClick(async () => {
        btn.setDisabled(true).setButtonText("Loading…");
        try {
          const { vaults } = await this.plugin.api.listVaults();
          this.vaultsState = { vaults };
        } catch (e) {
          this.vaultsState = { error: e instanceof Error ? e.message : String(e) };
        }
        this.display();
      })
    );
  }
}

// Shown when "Create vault" is pressed with an empty passphrase — plaintext
// sync stays available, but it has to be an explicit choice, never a default
// someone stumbles into by skipping a field.
class UnencryptedConfirmModal extends Modal {
  constructor(app: App, private onChoice: (syncPlaintext: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Sync without encryption?");
    this.contentEl.createEl("p", {
      text: "You haven't set an encryption passphrase. Without one, your notes are stored unencrypted on our servers — we could technically read them.",
    });
    this.contentEl.createEl("p", {
      text: "With a passphrase, notes and file names are end-to-end encrypted on your device. The trade-off: if you lose the passphrase, your synced data is unrecoverable.",
    });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const setBtn = buttons.createEl("button", { text: "Set a passphrase", cls: "mod-cta" });
    setBtn.onclick = () => {
      this.close();
      this.onChoice(false);
    };
    const plainBtn = buttons.createEl("button", { text: "Sync unencrypted" });
    plainBtn.onclick = () => {
      this.close();
      this.onChoice(true);
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
