import { App, TFile, normalizePath } from "obsidian";
import { ApiClient, ApiError, ChangeRecord, CommitPayload, type VaultInfo, vaultLabel } from "./api";
import { Codec } from "./codec";
import { ConfigStore } from "./configstore";
import { CryptoCodec, makeKeyCheck, unlock } from "./crypto";
import type { ObsyncSettings } from "./settings";
import { IndexEntry, SyncReport, SyncState, moveStateToVault } from "./sync";
import { sha256Hex } from "./util";

// Copies a vault, file by file, into another vault under a different codec:
// a plain vault into an encrypted one, or an encrypted one into a vault with
// a new passphrase. The server freezes the source while this runs (see
// StartVaultEncryption on the server), so the source can't change underneath.
//
// The copy is made from the SERVER's list of files, not from what happens to
// be on this device: files this device doesn't have — excluded folders, other
// devices' settings files, names this platform can't write — are downloaded
// and copied too, so nothing in the vault is lost. Files this device does
// have, unchanged since its last sync, are read from disk instead of
// downloaded.
//
// File ids are kept, so this device's index (and its shadow bases) carry
// over to the copy, and every file read from disk needs no download after
// the switch. Safe to run again after an interruption: files already in the
// copy are skipped.

const SLICE_BYTES = 32 * 1024 * 1024;
const BATCH = 50;
const PUT_CONCURRENCY = 6;

export interface CopyResult {
  index: Record<string, IndexEntry>;
  cursor: number;
  copied: number;
  total: number;
}

export interface CopyDeps {
  app: App;
  api: ApiClient;
  configStore: ConfigStore;
  state: SyncState; // this device's index of the source vault
  sourceId: string;
  targetId: string;
  source: Codec;
  target: Codec;
  onProgress?: (done: number, total: number) => void;
}

async function listAll(api: ApiClient, vaultId: string): Promise<{ live: ChangeRecord[]; latest: number }> {
  const byId = new Map<string, ChangeRecord>();
  let since = 0;
  let latest = 0;
  for (;;) {
    const page = await api.changes(vaultId, since);
    latest = page.latest_revision;
    for (const change of page.changes) {
      byId.set(change.file_id, change);
      since = Math.max(since, change.revision);
    }
    if (!page.has_more) break;
  }
  return { live: [...byId.values()].filter((c) => !c.deleted), latest };
}

interface Plain {
  change: ChangeRecord;
  path: string;
  bytes: ArrayBuffer;
  // Set when the bytes came from this device's own copy: what its index
  // entry for the encrypted vault will need.
  local?: { localHash: string; mtime: number; size: number };
}

export async function copyVault(deps: CopyDeps): Promise<CopyResult> {
  const { api, source } = deps;
  const { live } = await listAll(api, deps.sourceId);
  const already = new Set((await listAll(api, deps.targetId)).live.map((c) => c.file_id));
  const local = new Map<string, { path: string; localHash: string; mtime: number; size: number }>();

  let done = 0;
  const total = live.length;
  deps.onProgress?.(done, total);

  const todo: ChangeRecord[] = [];
  for (const change of live) {
    const path = normalizePath(await source.decodePath(change.encrypted_path));
    const mine = await readLocalCopy(deps, change, path);
    if (mine) local.set(change.file_id, { path, ...mine.meta });
    if (already.has(change.file_id)) {
      done++;
    } else {
      todo.push(change);
    }
  }
  deps.onProgress?.(done, total);

  // Slices bounded by bytes, like the sync engine's: everything in one is in
  // memory twice (plain and encoded) until its commit.
  let slice: ChangeRecord[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!slice.length) return;
    done += await copySlice(deps, slice, local);
    deps.onProgress?.(done, total);
    slice = [];
    bytes = 0;
  };
  for (const change of todo) {
    if (slice.length && (bytes + change.size > SLICE_BYTES || slice.length >= BATCH)) await flush();
    slice.push(change);
    bytes += change.size;
  }
  await flush();

  // Check the copy against the source before anyone switches to it.
  const copy = await listAll(api, deps.targetId);
  const copied = new Map(copy.live.map((c) => [c.file_id, c]));
  const missing = live.filter((c) => !copied.has(c.file_id));
  if (missing.length) throw new Error(`${missing.length} file(s) didn't make it into the encrypted vault; try again.`);

  const index: Record<string, IndexEntry> = {};
  for (const [fileId, meta] of local) {
    const entry = copied.get(fileId);
    if (!entry) continue;
    index[fileId] = {
      path: meta.path, version: entry.version, localHash: meta.localHash,
      remoteHash: entry.ciphertext_hash, mtime: meta.mtime, size: meta.size,
    };
  }
  return { index, cursor: copy.latest, copied: done, total };
}

// This device's copy of a source file, if it has one and it's exactly the
// version on the server (its index says so, and the bytes still match).
async function readLocalCopy(deps: CopyDeps, change: ChangeRecord, path: string) {
  const entry = deps.state.files[change.file_id];
  if (!entry || entry.version !== change.version || entry.path !== path) return null;
  try {
    let bytes: ArrayBuffer;
    let mtime: number;
    let size: number;
    if (deps.configStore.owns(path)) {
      const st = await deps.configStore.stat(path);
      if (!st) return null;
      bytes = await deps.configStore.read(path);
      ({ mtime, size } = st);
    } else {
      const file = deps.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      ({ mtime, size } = file.stat);
      bytes = await deps.app.vault.readBinary(file);
    }
    const localHash = await sha256Hex(bytes);
    if (localHash !== entry.localHash) return null;
    return { bytes, meta: { localHash, mtime, size } };
  } catch {
    return null;
  }
}

// Gets the plaintext of each file in the slice (from disk when possible),
// encodes it with the target codec, uploads and commits it under the same
// file id. Returns how many were copied; a failure throws, and a rerun picks
// up where this left off.
async function copySlice(
  deps: CopyDeps,
  slice: ChangeRecord[],
  local: Map<string, { path: string; localHash: string; mtime: number; size: number }>
): Promise<number> {
  const { api, source, target } = deps;
  const plain: Plain[] = [];
  const download: ChangeRecord[] = [];
  for (const change of slice) {
    const path = normalizePath(await source.decodePath(change.encrypted_path));
    const meta = local.get(change.file_id);
    const mine = meta ? await readLocalCopy(deps, change, path) : null;
    if (mine) plain.push({ change, path, bytes: mine.bytes, local: mine.meta });
    else download.push(change);
  }

  if (download.length) {
    const { downloads } = await api.presignDownloads(deps.sourceId, download.map((c) => c.file_id));
    const urls = new Map(downloads.map((d) => [d.file_id, d.get_url]));
    await pool(download, PUT_CONCURRENCY, async (change) => {
      const url = urls.get(change.file_id);
      if (!url) throw new Error(`no download for ${change.file_id}`);
      const bytes = await source.decodeContent(await api.getBlob(url, change.size));
      plain.push({ change, path: normalizePath(await source.decodePath(change.encrypted_path)), bytes });
    });
  }

  const encoded = await Promise.all(plain.map(async (p) => {
    const data = await target.encodeContent(p.bytes);
    return { ...p, data, hash: await sha256Hex(data) };
  }));
  const { uploads } = await api.presignUploads(deps.targetId, encoded.map((e) => e.data.byteLength));
  const payloads: CommitPayload[] = [];
  await pool(encoded.map((e, i) => ({ e, i })), PUT_CONCURRENCY, async ({ e, i }) => {
    const upload = uploads[i];
    if (!upload || "error" in upload) {
      throw new ApiError(0, upload?.error.code ?? "presign_failed", upload?.error.message ?? "no upload URL");
    }
    await api.putBlob(upload.put_url, e.data);
    payloads[i] = {
      file_id: e.change.file_id,
      base_version: 0,
      encrypted_path: await target.encodePath(e.path),
      path_token: await target.pathToken(e.path),
      size: e.data.byteLength,
      ciphertext_hash: e.hash,
      blob_key: upload.blob_key,
    };
  });

  const { results } = await api.commitBatch(deps.targetId, payloads);
  let copied = 0;
  results.forEach((result, i) => {
    // version_conflict: an earlier, interrupted run already copied it.
    if ("change" in result || result.error.code === "version_conflict") copied++;
    else throw new ApiError(0, result.error.code, `${result.error.message} (file ${encoded[i].change.file_id})`);
  });
  if (results.length < payloads.length) throw new Error("the server answered for fewer files than were sent");
  return copied;
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---- the whole operation, as the plugin runs it ---------------------------

export interface EncryptionHost {
  app: App;
  api: ApiClient;
  engine: { busy: boolean; sync(): Promise<SyncReport | null> };
  configStore: ConfigStore;
  settings(): ObsyncSettings;
  syncState(): SyncState;
  resolveCodec(): Promise<Codec>;
  invalidateCodec(): void;
  save(): Promise<void>;
  status(text: string): void;
  notice(text: string, ms?: number): void;
  reportError(context: string, message: string): void;
  changed(): void; // re-render whatever shows settings/state
  syncAfter(): void; // start an ordinary sync
}

// Encrypting a vault, or changing its passphrase: start (the server makes an
// empty encrypted vault and freezes this one) → catch up → copy → switch this
// device over → finish (the server deletes the old vault and sends the other
// devices along). Every step is recorded in settings.encryption, so a restart
// resumes rather than starting over. Also follows a vault that was encrypted
// from another device.
export class VaultEncryption {
  private active = false;

  constructor(private host: EncryptionHost) {}

  get running(): boolean {
    return this.active;
  }

  async encrypt(passphrase: string): Promise<void> {
    const h = this.host;
    const settings = h.settings();
    if (settings.encryption) return this.resume();
    const { vaults } = await h.api.listVaults();
    const current = vaults.find((v) => String(v.id) === settings.vaultId);
    if (!current) throw new Error("this vault isn't on your account any more.");
    if (current.role === "shared") throw new Error("only the vault's owner can change its encryption.");
    if (current.encrypting) throw new Error("this vault is already being encrypted from another device.");

    await this.idle();
    h.status("encrypting: syncing first…");
    const before = await h.engine.sync();
    if (before?.paymentRequired) throw new Error("sync needs an active plan first.");

    const { keyCheck } = await makeKeyCheck(passphrase);
    const { vault } = await h.api.startEncryption(settings.vaultId, keyCheck);
    settings.encryption = {
      sourceVaultId: settings.vaultId, targetVaultId: String(vault.id), targetName: vault.name,
      keyCheck, passphrase, stage: "copying", done: 0, total: 0,
    };
    await h.save();
    await this.run();
  }

  resume(): Promise<void> {
    return this.run();
  }

  async cancel(): Promise<void> {
    const h = this.host;
    const settings = h.settings();
    const job = settings.encryption;
    if (!job || job.stage !== "copying" || this.active) return;
    try {
      await h.api.cancelEncryption(job.sourceVaultId);
    } catch (e) {
      // Already gone on the server — nothing left to undo there.
      if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) throw e;
    }
    settings.encryption = null;
    await h.save();
    h.notice("Syncian: encryption cancelled. The vault is unchanged.");
    h.changed();
    h.syncAfter();
  }

  private async run(): Promise<void> {
    const h = this.host;
    const settings = h.settings();
    const job = settings.encryption;
    if (!job || this.active) return;
    this.active = true;
    job.error = undefined;
    try {
      if (job.stage === "copying") {
        await this.idle();
        // The source is frozen now; one more pull picks up anything another
        // device saved just before that. Its pushes are refused, harmlessly.
        h.status("encrypting: catching up…");
        await h.engine.sync();

        const source = await h.resolveCodec();
        const target = new CryptoCodec(await unlock(job.passphrase, job.keyCheck));
        const result = await copyVault({
          app: h.app, api: h.api, configStore: h.configStore, state: h.syncState(),
          sourceId: job.sourceVaultId, targetId: job.targetVaultId, source, target,
          onProgress: (done, total) => {
            job.done = done;
            job.total = total;
            h.status(`encrypting ${done}/${total}`);
          },
        });

        // Switch this device over before the server does, so a crash from
        // here on leaves it pointing at the copy, with only "finish" left.
        settings.vaultId = job.targetVaultId;
        settings.vaultName = job.targetName;
        settings.vaultKeyCheck = job.keyCheck;
        settings.passphrase = job.passphrase;
        settings.needsPassphrase = false;
        moveStateToVault(h.syncState(), job.targetVaultId, result.index, result.cursor);
        h.invalidateCodec();
        job.stage = "finishing";
        await h.save();
      }

      h.status("encrypting: switching over…");
      try {
        await h.api.finishEncryption(job.sourceVaultId);
      } catch (e) {
        // Finished on an earlier attempt whose answer never arrived.
        if (!(e instanceof ApiError && (e.code === "not_encrypting" || e.code === "vault_replaced"))) throw e;
      }
      settings.encryption = null;
      await h.save();
      h.notice(`Syncian: “${job.targetName}” is now end-to-end encrypted. Enter the same passphrase on your other devices.`, 15_000);
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
      await h.save();
      h.status("encryption paused");
      h.notice(`Syncian: encryption paused — ${job.error} Resume or cancel it in Settings → Syncian.`, 15_000);
      h.reportError("encrypt", job.error);
    } finally {
      this.active = false;
      h.changed();
    }
    if (!settings.encryption) h.syncAfter();
  }

  private async idle(): Promise<void> {
    while (this.host.engine.busy) await new Promise((r) => window.setTimeout(r, 200));
  }

  // The vault was encrypted (or re-keyed) from another device: follow it to
  // the copy. If the passphrase this device already has opens it, carry on
  // syncing; otherwise hold until it's entered.
  async follow(vault: VaultInfo): Promise<void> {
    const h = this.host;
    const settings = h.settings();
    settings.vaultId = String(vault.id);
    settings.vaultName = vaultLabel(vault);
    settings.vaultKeyCheck = vault.key_check ?? "";
    moveStateToVault(h.syncState(), String(vault.id));
    h.invalidateCodec();
    let opens = !vault.key_check;
    if (vault.key_check && settings.passphrase) {
      opens = await unlock(settings.passphrase, vault.key_check).then(() => true, () => false);
    }
    settings.needsPassphrase = !opens;
    await h.save();
    h.changed();
    if (opens) {
      h.syncAfter();
      return;
    }
    h.status("passphrase needed");
    h.notice(`Syncian: “${settings.vaultName}” is now end-to-end encrypted. Enter its passphrase in Settings → Syncian to keep syncing.`, 15_000);
  }

  // From the "passphrase needed" prompt in settings. Throws if it's wrong.
  async enterPassphrase(passphrase: string): Promise<void> {
    const h = this.host;
    const settings = h.settings();
    await unlock(passphrase, settings.vaultKeyCheck);
    settings.passphrase = passphrase;
    settings.needsPassphrase = false;
    h.invalidateCodec();
    await h.save();
    h.changed();
    h.syncAfter();
  }
}
