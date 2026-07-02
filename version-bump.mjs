// Bumps the patch version across manifest.json, package.json, and
// versions.json. Run standalone (npm run publish:dev calls this before
// building) — no dependency on `npm version`'s tagging/commit behavior.
import { readFileSync, writeFileSync } from "fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const [major, minor, patch] = manifest.version.split(".").map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;

manifest.version = nextVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = nextVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[nextVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Bumped to ${nextVersion}`);
