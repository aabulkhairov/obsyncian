import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ObsyncPlugin from "./main";
import { PublishSettingsSection } from "./publishview";

export const VIEW_TYPE_PUBLISH = "obsyncian-publish-view";
export const PUBLISH_ICON = "send";

// Publish in its own side panel, opened from the ribbon — the same section
// Settings → Syncian shows, without the trip through Settings.
export class PublishPanelView extends ItemView {
  private section: PublishSettingsSection;

  constructor(leaf: WorkspaceLeaf, private plugin: ObsyncPlugin) {
    super(leaf);
    this.section = new PublishSettingsSection(plugin, () => this.render());
  }

  getViewType(): string {
    return VIEW_TYPE_PUBLISH;
  }

  getDisplayText(): string {
    return "Syncian Publish";
  }

  getIcon(): string {
    return PUBLISH_ICON;
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  // Fetches the site list afresh, so a site changed in Settings, on another
  // device or on the web shows up.
  refresh(): void {
    this.section.reset();
    this.render();
  }

  render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("obsync-publish-panel");

    const s = this.plugin.settings;
    if (!s.apiToken || !s.vaultId) {
      el.createEl("p", { cls: "setting-item-description", text: "Log in and pick a vault in Settings → Syncian to publish notes." });
      return;
    }

    const bar = el.createDiv({ cls: "obsync-publish-panel-bar" });
    const reload = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(reload, "refresh-cw");
    reload.onclick = () => this.refresh();

    this.section.display(el);
    const availability = this.section.availability;
    if (availability === "loading") el.createEl("p", { cls: "setting-item-description", text: "Loading your sites…" });
    if (availability === "hidden") {
      el.createEl("p", { cls: "setting-item-description", text: "Publish isn't available on your account yet." });
    }
  }
}
