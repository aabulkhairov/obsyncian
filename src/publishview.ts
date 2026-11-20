// Obsyncian Publish in the plugin's UI: the "Publish" section of Settings →
// Syncian, and the modals it opens (site form, note picker, consent,
// progress). The pipeline itself lives in publish.ts.
//
// English only, like the rest of the plugin.
import { App, Modal, Notice, Setting, TFile, loadMermaid } from "obsidian";
import { isBoardPath, mermaidWithTheme } from "./publishdiagrams";
import { ApiError, type PublishSiteInfo, type PublishSiteParams } from "./api";
import type ObsyncPlugin from "./main";
import {
  asciiSlug,
  comparePaths,
  emptySelection,
  estimateSelection,
  isPublishablePage,
  pageName,
  isSelected,
  publishErrorMessage,
  publishSelection,
  setSelected,
  siteSlugProblem,
  type PublishManifest,
  type PublishSelection,
  type PublishSource,
  changesSincePublish,
  describeChanges,
} from "./publish";
import type { PublishSiteLocal } from "./settings";
import { formatBytes } from "./util";

// The vault as publishing reads it: plaintext from disk, links resolved by
// Obsidian itself. No codec anywhere near it — see the top of publish.ts.
export function obsidianSource(app: App): PublishSource {
  const file = (path: string): TFile => {
    const f = app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error(`"${path}" is no longer in the vault.`);
    return f;
  };
  return {
    files: () => app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
    stat: (path) => {
      const f = app.vault.getAbstractFileByPath(path);
      return f instanceof TFile ? { path: f.path, size: f.stat.size, mtime: f.stat.mtime } : null;
    },
    read: (path) => app.vault.read(file(path)),
    readBinary: (path) => app.vault.readBinary(file(path)),
    resolve: (linkpath, from) => app.metadataCache.getFirstLinkpathDest(linkpath, from)?.path ?? null,
    // So the page doesn't reflow as images arrive (the renderer sets
    // width/height from these). Best effort: SVGs and odd formats just go
    // without.
    imageSize: async (data, contentType) => {
      if (typeof createImageBitmap !== "function") return null;
      const bitmap = await createImageBitmap(new Blob([data], { type: contentType }));
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    },
    renderMermaid: async (code) => {
      const mermaid = await loadMermaid();
      const draw = async (theme: "light" | "dark"): Promise<string> => {
        const id = `obsyncian-publish-${theme}-${Math.random().toString(36).slice(2)}`;
        try {
          const { svg } = (await mermaid.render(id, mermaidWithTheme(code, theme))) as { svg: string };
          return svg;
        } finally {
          // Mermaid leaves its scratch element behind when a render throws.
          activeDocument.getElementById(id)?.remove();
          activeDocument.getElementById(`d${id}`)?.remove();
        }
      };
      try {
        return { light: await draw("light"), dark: await draw("dark") };
      } catch {
        return null; // a syntax error: the page shows the source instead
      }
    },
    // Screenshots pasted into a board are often several MB each; a reader
    // looking at a board needs nowhere near that. Longest side to 2000px,
    // WebP. Kept as is when it's already small or can't be decoded here.
    shrinkImage: async (data, contentType) => {
      if (data.byteLength < SHRINK_ABOVE_BYTES || contentType === "image/svg+xml" || contentType === "image/gif") return null;
      if (typeof createImageBitmap !== "function") return null;
      const bitmap = await createImageBitmap(new Blob([data], { type: contentType }));
      const scale = Math.min(1, SHRUNK_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = activeDocument.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
      if (!blob || blob.size >= data.byteLength) return null;
      return { data: await blob.arrayBuffer(), contentType: "image/webp" };
    },
  };
}

const SHRINK_ABOVE_BYTES = 400 * 1024;
const SHRUNK_LONG_SIDE = 2000;

function localFor(plugin: ObsyncPlugin, siteId: number): PublishSiteLocal {
  const key = String(siteId);
  const sites = plugin.settings.publishSites;
  if (!sites[key]) sites[key] = { selection: emptySelection(), consented: [] };
  return sites[key];
}

function hasSelection(sel: PublishSelection): boolean {
  return sel.include.length > 0;
}

function statusLabel(site: PublishSiteInfo): string {
  if (site.status === "live") return "Live";
  if (site.status === "disabled") return "Disabled — the plan that published it has lapsed";
  return site.last_published_at ? "Offline" : "Not published yet";
}

function relativeDate(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice("Syncian: link copied.");
  } catch {
    new Notice(`Syncian: couldn't copy — the link is ${text}`);
  }
}

type FetchState<T> = null | { error: string } | { hidden: true } | T;

// The "Publish" section at the bottom of Settings → Syncian. Paints
// immediately and re-renders the tab once the site list lands, like the
// other fetches on that screen.
export class PublishSettingsSection {
  private state: FetchState<{ sites: PublishSiteInfo[] }> = null;
  private started = false;

  constructor(private plugin: ObsyncPlugin, private rerender: () => void) {}

  reset(): void {
    this.state = null;
    this.started = false;
  }

  // For the Publish side panel, which has to say something while the section
  // itself paints nothing (still loading, or Publish not on this account).
  get availability(): "loading" | "hidden" | "ready" {
    if (this.state === null) return "loading";
    return "hidden" in this.state ? "hidden" : "ready";
  }

  // Nothing at all until the server has answered: Publish is a private beta
  // (the server answers publish_not_available to everyone else), so the
  // section must not flash up for an account that will never see it.
  display(containerEl: HTMLElement): void {
    void this.fetchSites();
    if (this.state === null || "hidden" in this.state) return;

    const s = this.plugin.settings;
    new Setting(containerEl).setName("Publish").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Publish notes you choose as a website at obsyncian.com/p/<name>. Only the notes you pick (and the images they show) " +
        "are published — as a readable copy. Everything else stays where it is" +
        (s.vaultKeyCheck ? ", end-to-end encrypted." : "."),
    });

    const state = this.state;
    if ("error" in state) {
      new Setting(containerEl).setDesc(`Couldn't load your sites: ${state.error}`).addButton((btn) =>
        btn.setButtonText("Retry").onClick(() => {
          this.reset();
          this.rerender();
        })
      );
      return;
    }

    // A site publishes one vault's notes; sites made from other vaults can
    // only be updated from a device that has those vaults.
    const mine = state.sites.filter((site) => String(site.vault_id) === s.vaultId);
    const elsewhere = state.sites.length - mine.length;
    for (const site of mine) this.displaySite(containerEl, site);
    if (elsewhere) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: `${elsewhere} more site${elsewhere === 1 ? "" : "s"} on your account publish${elsewhere === 1 ? "es" : ""} from another vault — update ${elsewhere === 1 ? "it" : "them"} from a device that syncs that vault.`,
      });
    }

    new Setting(containerEl)
      .setName(mine.length ? "Create another site" : "Create a site")
      .setDesc(mine.length ? "" : "Pick an address and a title; you choose which notes go on it next.")
      .addButton((btn) =>
        btn.setButtonText("Create site…").onClick(() =>
          new SiteFormModal(this.plugin.app, null, this.plugin.app.vault.getName(), async (params) => {
            const site = await this.plugin.api.createPublishSite(s.vaultId, params);
            this.upsert(site);
            new Notice(`Syncian: site "${site.title}" created. Choose the notes it publishes next.`);
            new NotePickerModal(this.plugin, site, () => this.rerender()).open();
          }).open()
        )
      );
  }

  private async fetchSites(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const { sites } = await this.plugin.api.listPublishSites();
      this.state = { sites };
      this.plugin.setPublishAvailable(true);
    } catch (e) {
      const hidden = e instanceof ApiError && e.code === "publish_not_available";
      this.state = hidden ? { hidden: true } : { error: publishErrorMessage(e) };
      if (hidden) this.plugin.setPublishAvailable(false);
    }
    if (this.plugin.settings.apiToken && this.plugin.settings.vaultId) this.rerender();
  }

  private upsert(site: PublishSiteInfo): void {
    if (this.state && "sites" in this.state) {
      const i = this.state.sites.findIndex((x) => x.id === site.id);
      if (i === -1) this.state.sites.push(site);
      else this.state.sites[i] = site;
    }
    this.rerender();
  }

  private remove(siteId: number): void {
    if (this.state && "sites" in this.state) this.state.sites = this.state.sites.filter((x) => x.id !== siteId);
    this.rerender();
  }

  private displaySite(containerEl: HTMLElement, site: PublishSiteInfo): void {
    const local = localFor(this.plugin, site.id);
    const published = !!site.last_published_at;
    const facts = [
      statusLabel(site),
      site.visibility === "gated" ? "Private" : "",
      published ? `${site.page_count} page${site.page_count === 1 ? "" : "s"}, ${formatBytes(site.total_bytes)}` : "",
      published ? `updated ${relativeDate(site.last_published_at)}` : "",
    ].filter(Boolean);

    const head = new Setting(containerEl).setName(site.title).setDesc(
      createFragment((f) => {
        f.createEl("a", { text: site.url, href: site.url });
        f.createEl("br");
        f.appendText(facts.join(" · "));
        if (site.visibility === "gated" && site.access) {
          f.createEl("br");
          const { pending, approved, manage_url } = site.access;
          const waiting = pending ? `${pending} new request${pending === 1 ? "" : "s"}` : "No new requests";
          f.appendText(`${waiting} · ${approved} reader${approved === 1 ? "" : "s"} approved · `);
          f.createEl("a", { text: "Manage access ↗", href: manage_url });
        }
      })
    );
    head.settingEl.addClass("obsync-publish-site");
    head
      .addExtraButton((b) => b.setIcon("copy").setTooltip("Copy link").onClick(() => void copyToClipboard(site.url)))
      .addExtraButton((b) => b.setIcon("external-link").setTooltip("Open site").onClick(() => window.open(site.url)));

    const selected = hasSelection(local.selection)
      ? (() => {
          const est = this.estimate(local.selection);
          const changed = describeChanges(
            changesSincePublish(obsidianSource(this.plugin.app).files(), local.selection, site.last_published_at, local.consented)
          );
          return `${est.notes} note${est.notes === 1 ? "" : "s"} selected${changed ? ` · ${changed}` : ""}`;
        })()
      : "No notes chosen yet.";
    const actions = new Setting(containerEl).setDesc(selected);
    actions.settingEl.addClass("obsync-publish-actions");
    actions
      .addButton((btn) => btn.setButtonText("Choose notes…").onClick(() => new NotePickerModal(this.plugin, site, () => this.rerender()).open()))
      .addButton((btn) => {
        btn.setButtonText(published ? "Update publication" : "Publish").setCta();
        if (!hasSelection(local.selection)) btn.setDisabled(true);
        btn.onClick(() => void runPublish(this.plugin, site, (updated) => this.upsert(updated)));
      })
      .addButton((btn) =>
        btn.setButtonText("Edit…").onClick(() =>
          new SiteFormModal(this.plugin.app, site, this.plugin.app.vault.getName(), async (params) => {
            this.upsert(await this.plugin.api.updatePublishSite(site.id, params));
            new Notice("Syncian: site updated.");
          }).open()
        )
      );

    if (published && site.status !== "disabled") {
      const goingOffline = site.status === "live";
      actions.addButton((btn) =>
        btn.setButtonText(goingOffline ? "Take offline" : "Put back online").onClick(async () => {
          try {
            const updated = await this.plugin.api.updatePublishSite(site.id, { status: goingOffline ? "draft" : "live" });
            this.upsert(updated);
            new Notice(goingOffline ? "Syncian: site taken offline." : "Syncian: site is live again.");
          } catch (e) {
            new Notice(`Syncian: ${publishErrorMessage(e)}`, 10_000);
          }
        })
      );
    }

    actions.addButton((btn) =>
      btn.setButtonText("Delete").setWarning().onClick(() =>
        new ConfirmDeleteModal(this.plugin.app, site, async () => {
          await this.plugin.api.deletePublishSite(site.id);
          delete this.plugin.settings.publishSites[String(site.id)];
          await this.plugin.saveSettings();
          this.remove(site.id);
          new Notice(`Syncian: site "${site.title}" deleted.`);
        }).open()
      )
    );
  }

  private estimate(sel: PublishSelection) {
    return estimateSelection(obsidianSource(this.plugin.app).files(), sel, (path) => Object.keys(this.plugin.app.metadataCache.resolvedLinks[path] ?? {}));
  }
}

// --- the publish run --------------------------------------------------------

const running = new Set<number>();

// "Publish" / "Update publication": build → consent if anything is new →
// upload → commit. One run per site at a time.
export async function runPublish(plugin: ObsyncPlugin, site: PublishSiteInfo, onPublished: (site: PublishSiteInfo) => void): Promise<void> {
  if (running.has(site.id)) {
    new Notice("Syncian: this site is already being published.");
    return;
  }
  const local = localFor(plugin, site.id);
  if (!hasSelection(local.selection)) {
    new Notice("Syncian: choose the notes this site publishes first.");
    return;
  }

  running.add(site.id);
  const progress = new PublishProgressModal(plugin.app, site);
  progress.open();
  try {
    const { manifest, outcome } = await publishSelection({
      api: plugin.api,
      siteId: site.id,
      local,
      source: obsidianSource(plugin.app),
      ask: (m, fresh, grown) => {
        progress.update("Waiting for your confirmation\u2026", 0, 0);
        return askConsent(plugin, site, m, fresh, grown);
      },
      save: () => plugin.saveSettings(),
      onBuild: (done, total, phase) =>
        progress.update(phase === "reading" ? `Reading notes ${done}/${total}\u2026` : `Hashing attachments ${done}/${total}\u2026`, done, total),
      onProgress: (p) => progress.update(p.text, p.done, p.total),
    });
    if (!outcome) {
      progress.close();
      new Notice("Syncian: nothing was published.");
      return;
    }
    onPublished(outcome.site);
    progress.succeed(outcome.site, manifest, outcome.uploaded);
  } catch (e) {
    console.warn("[obsync] publish failed:", e);
    progress.fail(publishErrorMessage(e));
  } finally {
    running.delete(site.id);
  }
}

function askConsent(plugin: ObsyncPlugin, site: PublishSiteInfo, manifest: PublishManifest, fresh: string[], grown: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    new ConsentModal(plugin.app, {
      site,
      notes: manifest.notes.length,
      attachments: manifest.attachments.length,
      bytes: manifest.bytes,
      fresh,
      grown,
      encrypted: !!plugin.settings.vaultKeyCheck,
    }, resolve).open();
  });
}

// --- modals -----------------------------------------------------------------

// Create and edit share one form. Slug changes on an existing site are
// allowed but warned about: every shared link to the old address stops
// working.
class SiteFormModal extends Modal {
  private params: Required<Pick<PublishSiteParams, "slug" | "title" | "description" | "author_label" | "locale" | "visibility">>;

  constructor(
    app: App,
    private site: PublishSiteInfo | null,
    vaultName: string,
    private submit: (params: PublishSiteParams) => Promise<void>
  ) {
    super(app);
    this.params = {
      slug: site?.slug ?? asciiSlug(vaultName).slice(0, 49).replace(/-+$/, ""),
      title: site?.title ?? vaultName,
      description: site?.description ?? "",
      author_label: site?.author_label ?? "",
      locale: site?.locale ?? "en",
      visibility: site?.visibility ?? "public",
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.site ? "Edit site" : "Create a site");

    const slugSetting = new Setting(contentEl).setName("Address");
    const updateSlugDesc = () => {
      const problem = this.params.slug ? siteSlugProblem(this.params.slug) : null;
      slugSetting.setDesc(
        problem ??
          `obsyncian.com/p/${this.params.slug || "<name>"}` +
            (this.site && this.params.slug !== this.site.slug ? " — links to the old address will stop working." : "")
      );
    };
    slugSetting.addText((text) =>
      text.setPlaceholder("my-notes").setValue(this.params.slug).onChange((v) => {
        this.params.slug = v.trim().toLowerCase();
        updateSlugDesc();
      })
    );
    updateSlugDesc();

    new Setting(contentEl).setName("Title").setDesc("Shown at the top of every page.").addText((text) =>
      text.setValue(this.params.title).onChange((v) => (this.params.title = v))
    );
    // Goes on a private site's sign-in page, its preview image and link
    // previews (Telegram, social networks). The server caps it at 300.
    new Setting(contentEl)
      .setName("Description")
      .setDesc("Optional. A sentence or two about what's inside, shown in link previews.")
      .addTextArea((text) => {
        text.setPlaceholder("Working notes on finding the first 100 customers").setValue(this.params.description)
          .onChange((v) => (this.params.description = v));
        text.inputEl.maxLength = 300;
        text.inputEl.rows = 3;
      });
    new Setting(contentEl).setName("Author").setDesc("Optional. How you're credited on the site.").addText((text) =>
      text.setPlaceholder("Your name").setValue(this.params.author_label).onChange((v) => (this.params.author_label = v))
    );
    new Setting(contentEl).setName("Site language").setDesc("Language of the site's own labels (navigation, dates).").addDropdown((dd) =>
      dd.addOption("en", "English").addOption("ru", "Русский").setValue(this.params.locale).onChange((v) => (this.params.locale = v as "en" | "ru"))
    );

    const privateSetting = new Setting(contentEl).setName("Private");
    const updatePrivateDesc = () => {
      const wasPrivate = this.site?.visibility === "gated" && !!this.site.last_published_at;
      privateSetting.setDesc(
        this.params.visibility === "gated"
          ? "Only readers you approve can read it. Everyone else sees a sign-in page with a Request access button; " +
              "you approve in Telegram or on obsyncian.com. Never indexed by search engines."
          : wasPrivate
            ? "Off: the published notes become readable by anyone with the link."
            : "Off: anyone with the link can read the site."
      );
    };
    privateSetting.addToggle((t) =>
      t.setValue(this.params.visibility === "gated").onChange((on) => {
        this.params.visibility = on ? "gated" : "public";
        updatePrivateDesc();
      })
    );
    updatePrivateDesc();

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText(this.site ? "Save" : "Create site").setCta().onClick(async () => {
        const problem = siteSlugProblem(this.params.slug);
        if (problem) {
          new Notice(`Syncian: ${problem}`);
          return;
        }
        if (!this.params.title.trim()) {
          new Notice("Syncian: give the site a title.");
          return;
        }
        btn.setDisabled(true);
        try {
          await this.submit({
            ...this.params,
            title: this.params.title.trim(),
            description: this.params.description.trim(),
            author_label: this.params.author_label.trim(),
          });
          this.close();
        } catch (e) {
          btn.setDisabled(false);
          new Notice(`Syncian: ${siteFormError(e)}`, 10_000);
        }
      })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function siteFormError(e: unknown): string {
  if (e instanceof ApiError && e.code === "invalid" && /slug/i.test(e.message) && /taken/i.test(e.message)) {
    return "That address is already taken — pick another.";
  }
  return publishErrorMessage(e);
}

class ConfirmDeleteModal extends Modal {
  constructor(app: App, private site: PublishSiteInfo, private onDelete: () => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Delete "${this.site.title}"?`);
    this.contentEl.createEl("p", {
      text: `${this.site.url} stops working immediately and everything published there is removed from our servers. ` +
        "This can't be undone. The notes in your vault are not touched.",
    });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const del = buttons.createEl("button", { text: "Delete site", cls: "mod-warning" });
    del.onclick = async () => {
      del.disabled = true;
      try {
        await this.onDelete();
        this.close();
      } catch (e) {
        del.disabled = false;
        new Notice(`Syncian: ${publishErrorMessage(e)}`, 10_000);
      }
    };
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface TreeFolder {
  name: string;
  path: string;
  folders: Map<string, TreeFolder>;
  files: string[];
}

// The vault's notes as a folder tree, for the picker.
export function buildTree(paths: string[]): TreeFolder {
  const root: TreeFolder = { name: "", path: "", folders: new Map(), files: [] };
  for (const path of [...paths].sort(comparePaths)) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const sub = parts.slice(0, i + 1).join("/");
      let next = node.folders.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: sub, folders: new Map(), files: [] };
        node.folders.set(parts[i], next);
      }
      node = next;
    }
    node.files.push(path);
  }
  return root;
}

// A checkbox tree of the vault's notes. Ticking a folder takes everything in
// it, including notes added later; unticking one note inside keeps the rest.
// The selection is saved per site on "Save".
class NotePickerModal extends Modal {
  // Not "selection": Obsidian's Modal (1.15+) keeps its own `selection`
  // property and overwrites a subclass field of that name with an object
  // holding the window — which then broke counting, and saving it made every
  // later settings save throw "circular structure".
  private picked: PublishSelection;
  private boxes = new Map<string, { input: HTMLInputElement; files: string[]; badge: HTMLElement }>();
  private totalsEl!: HTMLElement;
  private files: ReturnType<PublishSource["files"]>;

  constructor(private plugin: ObsyncPlugin, private site: PublishSiteInfo, private onSaved: () => void) {
    super(plugin.app);
    this.files = obsidianSource(plugin.app).files();
    const local = localFor(plugin, site.id);
    this.picked = { include: [...local.selection.include], exclude: [...local.selection.exclude] };
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(`Notes on "${this.site.title}"`);
    this.modalEl.addClass("obsync-picker-modal");
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Tick folders or single notes. Images and files the chosen notes show are published with them. Nothing goes online until you press Publish.",
    });

    const notes = this.files.map((f) => f.path).filter(isPublishablePage);
    const tree = buildTree(notes);
    const list = contentEl.createDiv({ cls: "obsync-picker-tree" });
    this.renderFolder(list, tree, 0, true);

    this.totalsEl = contentEl.createDiv({ cls: "obsync-picker-totals" });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Clear" }).onclick = () => {
      this.picked = emptySelection();
      this.refresh();
    };
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    buttons.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = async () => {
      try {
        localFor(this.plugin, this.site.id).selection = this.picked;
        await this.plugin.saveSettings();
      } catch (e) {
        // A failure here used to vanish into an unhandled rejection, leaving
        // a Save button that seemed to do nothing.
        console.error("Syncian: saving the publish selection failed", e);
        new Notice(`Syncian: couldn't save the selection — ${e instanceof Error ? e.message : String(e)}`, 15_000);
        return;
      }
      this.close();
      this.onSaved();
    };
    this.refresh();
  }

  private renderFolder(parent: HTMLElement, folder: TreeFolder, depth: number, open: boolean): string[] {
    const all: string[] = [];
    const row = parent.createDiv({ cls: "obsync-picker-row is-folder" });
    row.style.setProperty("--obsync-depth", String(depth));
    const caret = row.createSpan({ cls: "obsync-picker-caret", text: open ? "▾" : "▸" });
    const input = row.createEl("input", { type: "checkbox" });
    row.createSpan({ text: folder.path === "" ? `${this.plugin.app.vault.getName()} (whole vault)` : folder.name });
    const folderBadge = row.createSpan({ cls: "obsync-picker-change" });
    const children = parent.createDiv({ cls: "obsync-picker-children" });
    if (!open) children.hide();
    caret.onclick = () => {
      const show = !children.isShown();
      children.toggle(show);
      caret.setText(show ? "▾" : "▸");
    };

    for (const sub of folder.folders.values()) all.push(...this.renderFolder(children, sub, depth + 1, false));
    for (const path of folder.files) {
      const fileRow = children.createDiv({ cls: "obsync-picker-row" });
      fileRow.style.setProperty("--obsync-depth", String(depth + 1));
      const box = fileRow.createEl("input", { type: "checkbox" });
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (isBoardPath(name)) fileRow.createSpan({ cls: "obsync-picker-board", text: "✎", attr: { "aria-label": "Excalidraw board" } });
      fileRow.createSpan({ text: pageName(name) });
      const badge = fileRow.createSpan({ cls: "obsync-picker-change" });
      box.onchange = () => this.toggle(path, box.checked);
      this.boxes.set(path, { input: box, files: [path], badge });
      all.push(path);
    }

    input.onchange = () => this.toggle(folder.path, input.checked);
    this.boxes.set(`${folder.path}/`, { input, files: all, badge: folderBadge });
    return all;
  }

  private toggle(path: string, on: boolean): void {
    this.picked = setSelected(this.picked, path, on);
    this.refresh();
  }

  private refresh(): void {
    try {
      this.paintSelection();
    } catch (e) {
      console.error("Syncian: updating the note picker failed", e);
      this.totalsEl.setText(`Couldn't count the selection: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private paintSelection(): void {
    const local = localFor(this.plugin, this.site.id);
    const changes = changesSincePublish(this.files, this.picked, this.site.last_published_at, local.consented);
    for (const [key, { input, files, badge }] of this.boxes) {
      const picked = files.filter((p) => isSelected(this.picked, p)).length;
      input.checked = files.length > 0 && picked === files.length;
      input.indeterminate = picked > 0 && picked < files.length;
      if (key.endsWith("/")) {
        const changed = files.filter((p) => changes.has(p)).length;
        badge.setText(changed ? `${changed} changed` : "");
      } else {
        badge.setText(changes.get(key) ?? "");
        badge.toggleClass("is-new", changes.get(key) === "new");
      }
    }
    const est = estimateSelection(this.files, this.picked, (path) => Object.keys(this.plugin.app.metadataCache.resolvedLinks[path] ?? {}));
    const others = est.attachments - est.images;
    this.totalsEl.setText(
      `${est.notes} note${est.notes === 1 ? "" : "s"} · ${est.images} image${est.images === 1 ? "" : "s"}` +
        (others ? ` · ${others} other file${others === 1 ? "" : "s"}` : "") +
        ` · about ${formatBytes(est.bytes)}` +
        (describeChanges(changes) ? ` · ${describeChanges(changes)}` : "")
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface ConsentFacts {
  site: PublishSiteInfo;
  notes: number;
  attachments: number;
  bytes: number;
  fresh: string[];
  grown: boolean;
  encrypted: boolean;
}

// The separate, explicit consent the architecture asks for (concept §4):
// shown before a site's first publish and whenever its selection grows, and
// it can't be clicked through without ticking the box.
export class ConsentModal extends Modal {
  private answered = false;

  constructor(app: App, private facts: ConsentFacts, private onAnswer: (agreed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const f = this.facts;
    const priv = f.site.visibility === "gated";
    this.titleEl.setText(f.grown ? "Publish more notes?" : priv ? "Publish these notes?" : "Make these notes public?");

    contentEl.createEl("p", {
      text: `You're about to publish ${f.notes} note${f.notes === 1 ? "" : "s"}` +
        (f.attachments ? ` and ${f.attachments} attached file${f.attachments === 1 ? "" : "s"}` : "") +
        ` (${formatBytes(f.bytes)}) to ${f.site.url}.`,
    });
    const points = contentEl.createEl("ul");
    points.createEl("li", {
      text: priv
        ? "The site is private: only people you approve can read them, after signing in. Search engines won't list them. If you make the site public later, anyone with the link can."
        : "Anyone on the internet can read them, without an account. Search engines may list them.",
    });
    points.createEl("li", {
      text: f.encrypted
        ? "They leave end-to-end encryption. A readable copy — the text, images, note names and folder paths — is stored on Obsyncian's servers so it can be shown to visitors."
        : "A readable copy — the text, images, note names and folder paths — is stored on Obsyncian's servers so it can be shown to visitors.",
    });
    points.createEl("li", {
      text: f.encrypted
        ? "The rest of your vault stays end-to-end encrypted, exactly as before. Only what's listed here is published."
        : "Only what's listed here is published; the rest of your vault isn't shown to anyone.",
    });
    points.createEl("li", { text: "You can update or delete the site at any time, but copies visitors saved meanwhile can't be taken back." });

    if (f.grown) {
      contentEl.createEl("p", { text: `New since you last agreed (${f.fresh.length}):` });
      const list = contentEl.createEl("ul", { cls: "obsync-consent-list" });
      for (const path of f.fresh.slice(0, 15)) list.createEl("li", { text: path });
      if (f.fresh.length > 15) list.createEl("li", { text: `…and ${f.fresh.length - 15} more` });
    }

    const label = contentEl.createEl("label", { cls: "obsync-consent-check" });
    const check = label.createEl("input", { type: "checkbox" });
    label.appendText(priv
      ? " I understand: a readable copy of these notes goes to Obsyncian's servers, for the readers I approve."
      : " I understand: these notes will be public on the internet.");

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const publish = buttons.createEl("button", { text: f.grown || priv ? "Publish" : "Make public and publish", cls: "mod-cta" });
    publish.disabled = true;
    check.onchange = () => (publish.disabled = !check.checked);
    publish.onclick = () => {
      if (!check.checked) return;
      this.answer(true);
    };
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.answer(false);
  }

  private answer(agreed: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.close();
    this.onAnswer(agreed);
  }

  // Esc / clicking outside is a no.
  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) {
      this.answered = true;
      this.onAnswer(false);
    }
  }
}

// Progress while a publish runs, then its outcome. Closing it doesn't stop
// the publish; the result arrives as a notice instead.
class PublishProgressModal extends Modal {
  private textEl!: HTMLElement;
  private barEl!: HTMLProgressElement;
  private closed = false;

  constructor(app: App, private site: PublishSiteInfo) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Publishing "${this.site.title}"`);
    this.textEl = this.contentEl.createDiv({ cls: "obsync-publish-progress-text", text: "Starting…" });
    this.barEl = this.contentEl.createEl("progress", { cls: "obsync-publish-progress" });
  }

  update(text: string, done: number, total: number): void {
    if (this.closed) return;
    this.textEl.setText(text);
    if (total > 0) {
      this.barEl.max = total;
      this.barEl.value = done;
    } else {
      this.barEl.removeAttribute("value");
    }
  }

  succeed(site: PublishSiteInfo, manifest: PublishManifest, uploaded: number): void {
    const summary = `${manifest.pages.length} page${manifest.pages.length === 1 ? "" : "s"}` +
      (manifest.attachments.length ? `, ${manifest.attachments.length} file${manifest.attachments.length === 1 ? "" : "s"} (${uploaded} uploaded, the rest unchanged)` : "");
    const skipped = manifest.skipped.length
      ? ` ${manifest.skipped.length} linked file${manifest.skipped.length === 1 ? "" : "s"} couldn't be read and show${manifest.skipped.length === 1 ? "s" : ""} as missing.`
      : "";
    const offline = site.status === "live" ? "" : " The site is offline, so visitors won't see this until it's back online.";
    if (this.closed) {
      new Notice(`Syncian: published ${site.url} — ${summary}.${skipped}${offline}`, 10_000);
      return;
    }
    this.titleEl.setText("Published");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `${summary}.${skipped}${offline}` });
    const link = this.contentEl.createEl("p").createEl("a", { text: site.url, href: site.url });
    link.setAttr("target", "_blank");
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Copy link" }).onclick = () => void copyToClipboard(site.url);
    buttons.createEl("button", { text: "Open site", cls: "mod-cta" }).onclick = () => window.open(site.url);
  }

  fail(message: string): void {
    if (this.closed) {
      new Notice(`Syncian: publishing "${this.site.title}" failed — ${message}`, 15_000);
      return;
    }
    this.titleEl.setText("Publishing failed");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Close" }).onclick = () => this.close();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}
