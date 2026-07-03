import { requestUrl } from "obsidian";

// Plain numeric-dot version compare (works for "0.1.2" style versions; a
// missing segment counts as 0, so "1.2" < "1.2.1").
export function isNewerVersion(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv !== lv) return rv > lv;
  }
  return false;
}

export interface UpdateResult {
  updated: boolean;
  version?: string;
}

// Fetches manifest.json + main.js from the same server the plugin already
// talks to and, if the version is newer, overwrites this plugin's own files
// on disk (same trick BRAT and similar tools use for beta distribution).
// This is the pre-community-directory update path — once the plugin is
// listed officially, Obsidian's own updater takes over and /dev-plugin/
// stops being relevant.
export async function checkForUpdate(
  serverUrl: string,
  currentVersion: string,
  write: (path: string, data: string) => Promise<void>,
  pluginDir: string
): Promise<UpdateResult> {
  const base = serverUrl.replace(/\/+$/, "");

  const manifestRes = await requestUrl({ url: `${base}/dev-plugin/manifest.json`, throw: false });
  if (manifestRes.status !== 200) return { updated: false };

  let remoteManifest: { version?: string };
  try {
    remoteManifest = manifestRes.json;
  } catch {
    return { updated: false };
  }
  if (!remoteManifest.version || !isNewerVersion(remoteManifest.version, currentVersion)) {
    return { updated: false };
  }

  const mainRes = await requestUrl({ url: `${base}/dev-plugin/main.js`, throw: false });
  if (mainRes.status !== 200) return { updated: false };

  // styles.css is best-effort: an update must not fail over cosmetics, but
  // skipping it entirely leaves the plugin unstyled (raw text dump).
  const stylesRes = await requestUrl({ url: `${base}/dev-plugin/styles.css`, throw: false });

  await write(`${pluginDir}/manifest.json`, manifestRes.text);
  await write(`${pluginDir}/main.js`, mainRes.text);
  if (stylesRes.status === 200) await write(`${pluginDir}/styles.css`, stylesRes.text);
  return { updated: true, version: remoteManifest.version };
}

// Repair path for installs whose styles.css never arrived (older updater
// versions only shipped manifest.json + main.js).
export async function fetchStyles(serverUrl: string): Promise<string | null> {
  const base = serverUrl.replace(/\/+$/, "");
  const res = await requestUrl({ url: `${base}/dev-plugin/styles.css`, throw: false });
  return res.status === 200 ? res.text : null;
}
