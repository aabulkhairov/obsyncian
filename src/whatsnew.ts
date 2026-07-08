import { MarkdownRenderer, Modal, Plugin, setIcon } from "obsidian";

export interface ReleaseNote {
  version: string;
  notes: string; // markdown
}

// Newest first. Add a new entry at the top for every release with
// user-facing changes — that's the whole "changelog". Keep it short and
// benefit-oriented; this is what pops up after an update.
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "1.0.13",
    notes: [
      "### 🔀 Auto-merge for concurrent edits",
      "Edit the same note on two devices and Syncian now merges non-overlapping changes into one file, instead of leaving a `(conflict)` copy. Overlapping edits still get a conflict copy, so nothing is ever lost.",
      "",
      "### 🧩 Sync plugins & settings (optional)",
      "New toggle in **Settings → Syncian**: sync your `.obsidian` folder — plugins, themes, snippets, settings — across your devices, through the same end-to-end encryption. Off by default; your login and passphrase are never uploaded.",
      "",
      "### 📝 Release notes after updates",
      "This popup. A short summary of what changed after each update. Turn it off in **Settings → Syncian**, or reopen it any time with the **“Syncian: What's new”** command.",
    ].join("\n"),
  },
];

// Numeric semver-ish compare: -1 if a<b, 0 if equal, 1 if a>b.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Notes for versions newer than `from`, up to and including `to`, newest first.
export function notesSince(from: string, to: string): ReleaseNote[] {
  return RELEASE_NOTES
    .filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
    .sort((x, y) => compareVersions(y.version, x.version));
}

// Notes for one version — used by the "What's new" command. Falls back to the
// latest entry if this exact version has none, so the command is never empty.
export function notesFor(version: string): ReleaseNote[] {
  const exact = RELEASE_NOTES.find((r) => r.version === version);
  return exact ? [exact] : RELEASE_NOTES.slice(0, 1);
}

export class WhatsNewModal extends Modal {
  constructor(private plugin: Plugin, private entries: ReleaseNote[]) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass("obsync-whatsnew-modal");

    // Built into Obsidian's own title bar (correct alignment with the built-in
    // close button for free) — just dress it up with a small brand badge.
    titleEl.empty();
    const icon = titleEl.createSpan({ cls: "obsync-whatsnew-title-icon" });
    setIcon(icon, "gem");
    titleEl.createSpan({ text: `Syncian ${this.plugin.manifest.version}` });

    contentEl.createEl("p", { cls: "obsync-whatsnew-subtitle", text: "What's new" });
    contentEl.createEl("p", {
      cls: "obsync-whatsnew-hint",
      text: "You'll see a short summary like this after each update — turn it off any time in Settings → Syncian, or reopen it with the “Syncian: What's new” command.",
    });
    contentEl.createEl("hr", { cls: "obsync-whatsnew-divider" });

    const notes = contentEl.createDiv({ cls: "obsync-whatsnew-notes" });
    for (const entry of this.entries) {
      const section = notes.createDiv();
      // Only label versions when several are shown at once (e.g. a user who
      // skipped a couple of releases) — otherwise the title already says it.
      if (this.entries.length > 1) section.createDiv({ cls: "obsync-whatsnew-pill", text: entry.version });
      void MarkdownRenderer.render(this.app, entry.notes, section, "", this.plugin);
    }

    contentEl.createEl("hr", { cls: "obsync-whatsnew-divider" });
    const footer = contentEl.createDiv({ cls: "obsync-whatsnew-footer" });
    footer.createSpan({ cls: "obsync-whatsnew-footer-hint", text: "obsyncian.com" });
    footer.createEl("button", { text: "Got it", cls: "mod-cta" }).onclick = () => this.close();
  }

  onClose(): void {
    this.titleEl.empty();
    this.contentEl.empty();
  }
}
