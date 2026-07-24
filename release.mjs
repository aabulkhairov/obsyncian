// One-command release: test → build → bump → commit → push → GitHub release.
//
// The Obsidian store installs a plugin from the GitHub release whose tag
// exactly matches manifest.json's version (no `v` prefix). Bumping the version
// without publishing that release is what got us de-listed — so this script
// ties the two together and never leaves one without the other.
//
//   npm run release                 # patch bump + full release
//   npm run release -- --notes "…"  # same, with custom release notes
//
// Preconditions (checked up front, aborts cleanly if not met):
//   • gh CLI installed and authenticated
//   • on `main`, working tree clean, and in sync with origin/main
import { execSync } from "child_process";
import { readFileSync, existsSync, copyFileSync } from "fs";

const ASSETS = ["main.js", "manifest.json", "styles.css"];
const DEV_PLUGIN_DIR = "../server/public/dev-plugin";

// Capture output (trimmed). Throws on non-zero exit.
const cap = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
// Stream to the terminal so test/build/push output is visible live.
const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const step = (m) => console.log(`\n\x1b[1m▶ ${m}\x1b[0m`);
const die = (m) => {
  console.error(`\n\x1b[31m✖ ${m}\x1b[0m`);
  process.exit(1);
};

// --notes "text" (npm forwards args after `--`); falls back to a generic note.
function parseNotes() {
  const i = process.argv.indexOf("--notes");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// ---- preconditions -------------------------------------------------------
step("Checking preconditions");
try {
  cap("gh auth status");
} catch {
  die("GitHub CLI isn't authenticated. Run `gh auth login` and retry.");
}
if (cap("git status --porcelain")) {
  die("Working tree has uncommitted changes. Commit or stash them first — a release commit should only contain the version bump.");
}
const branch = cap("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") die(`You're on '${branch}', not 'main'. Switch to main to release.`);
cap("git fetch origin main --quiet");
if (cap("git rev-parse HEAD") !== cap("git rev-parse origin/main")) {
  die("Local main and origin/main have diverged. Pull/push so they match, then retry.");
}
console.log("  ✓ gh authenticated, on main, clean, in sync with origin");

// ---- gate on a green build BEFORE touching the version -------------------
// Done first so a failure here leaves the tree clean and the version untouched.
step("Running tests");
run("npm test");
step("Building production bundle");
run("npm run build");

// ---- bump ----------------------------------------------------------------
step("Bumping version");
run("node version-bump.mjs");
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
if (cap(`git tag -l ${version}`)) die(`Tag ${version} already exists — bump collided with an existing release.`);
try {
  if (cap(`gh release view ${version} --json tagName -q .tagName 2>/dev/null`)) {
    die(`A GitHub release ${version} already exists.`);
  }
} catch {
  // `gh release view` exits non-zero when the release doesn't exist — that's
  // the state we want, so swallow it.
}
console.log(`  ✓ Releasing version ${version}`);

// ---- commit + push -------------------------------------------------------
step("Committing and pushing the bump");
run("git add manifest.json package.json versions.json");
run(`git commit -m "Release ${version}"`);
run("git push origin main");

// ---- GitHub release (the step that used to get forgotten) ----------------
step("Creating the GitHub release with assets");
const notes = parseNotes() ?? `Release ${version}. See the in-app “What's new” for details.`;
const sha = cap("git rev-parse HEAD");
// Pass notes via a temp arg-safe form: gh reads --notes literally.
run(`gh release create ${version} --target ${sha} --title ${version} --notes ${JSON.stringify(notes)} ${ASSETS.join(" ")}`);

// ---- keep the server-hosted beta channel in step -------------------------
if (existsSync(DEV_PLUGIN_DIR)) {
  step("Copying assets to the server dev-plugin channel");
  for (const f of ASSETS) copyFileSync(f, `${DEV_PLUGIN_DIR}/${f}`);
  console.log(`  ✓ Updated ${DEV_PLUGIN_DIR} (commit + deploy the server repo to publish it)`);
}

// ---- done ----------------------------------------------------------------
console.log(`\n\x1b[32m✔ Released ${version}.\x1b[0m`);
console.log(`  • GitHub release: ${cap("gh repo view --json url -q .url")}/releases/tag/${version}`);
console.log("  • Obsidian re-scans automatically; if the listing still warns, hit re-scan on the plugin page.");
if (existsSync(DEV_PLUGIN_DIR)) {
  console.log("  • Server dev-plugin updated — commit & `kamal deploy` the server repo to ship the beta channel too.");
}
