// Live end-to-end walk of a trial that ends unpaid: real ApiClient over HTTP,
// real Rails dev server on :3000, real MinIO on :9000, real SyncEngine. Only
// Obsidian's filesystem is mocked. It exists to prove one thing on the real
// stack: removing the server copy of a lapsed trial never touches the notes
// on the devices. Run with:
//   OBSYNC_E2E=1 npx vitest run test/trial-live-e2e.test.ts
// after starting MinIO and `bin/rails server -p 3000`.
import { execFileSync } from "child_process";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api";
import { makeClient } from "./helpers";
import { ApiClient } from "../src/api";
import { adoptVaultState } from "../src/sync";

const SERVER = "http://localhost:3000";
const SERVER_DIR = resolve(__dirname, "../../server");
const NOTES = { "Note.md": "hello", "Deep/Idea.md": "nested", "Daily/2026-11-23.md": "today" };

// Runs Ruby inside the dev app (same database the server uses) and returns
// what it printed. Time can't be made to pass on a live server, so the days
// are moved by rewriting the account's dates, exactly and only that.
function rails(script: string): string {
  return execFileSync("bin/rails", ["runner", "eval(ENV.fetch('E2E_SCRIPT'))"], {
    cwd: SERVER_DIR,
    env: { ...process.env, E2E_SCRIPT: script, TRIAL_PURGE_ENABLED: "1", RAILS_ENV: "development" },
    encoding: "utf8",
  }).trim().split("\n").pop()!;
}

// The same client the unit tests build, pointed at the real server.
function client(token: string, vaultId: string) {
  const api = new ApiClient(() => SERVER, () => token);
  const c = makeClient(api as unknown as FakeApi);
  c.vaultRef.id = vaultId;
  return c;
}

async function relink(c: ReturnType<typeof client>, vaultId: string) {
  adoptVaultState(c.state, vaultId);
  for (const id of await c.base.list()) await c.base.remove(id);
  c.vaultRef.id = vaultId;
}

describe.skipIf(!process.env.OBSYNC_E2E)("live: a trial ends unpaid, its server copy is removed, the notes stay", () => {
  it("walks trial → pause → warning → deletion → payment → vault created again", async () => {
    const email = `trial-e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const code = rails(`u = User.create!(email: "${email}"); _r, c = LoginCode.issue!(u); puts c`);

    // First login starts the trial; two devices sync one vault.
    const anon = new ApiClient(() => SERVER, () => "");
    const tokenA = (await anon.verify(email, code, "e2e laptop")).token;
    const codeB = rails(`u = User.find_by!(email: "${email}"); _r, c = LoginCode.issue!(u); puts c`);
    const tokenB = (await anon.verify(email, codeB, "e2e phone")).token;
    expect(rails(`u = User.find_by!(email: "${email}"); puts [u.trial_active?, u.device_limit.inspect, u.storage_limit].join(",")`))
      .toBe("true,nil,1073741824");

    const apiA = new ApiClient(() => SERVER, () => tokenA);
    const first = String((await apiA.createVault("Trial notes")).id);
    const a = client(tokenA, first);
    const b = client(tokenB, first);
    for (const [path, text] of Object.entries(NOTES)) a.vault.write(path, text);
    expect((await a.engine.sync())?.pushed).toBe(3);
    expect((await b.engine.sync())?.pulled).toBe(3);
    expect(b.vault.snapshot()).toEqual(NOTES);

    // Day 8: the trial is over. Sync pauses; nothing is deleted anywhere.
    rails(`u = User.find_by!(email: "${email}"); u.update_columns(trial_started_at: 8.days.ago, free_access_until: 1.day.ago); puts :ok`);
    b.vault.write("Written-while-paused.md", "only on the phone");
    expect((await a.engine.sync())?.paymentRequired).toBe(true);
    expect((await b.engine.sync())?.paymentRequired).toBe(true);
    expect(a.vault.snapshot()).toEqual(NOTES);

    // Day 30: the warning goes out. Day 37: the copy is removed, blobs included.
    const purge = rails(`
      ActiveJob::Base.queue_adapter = :inline
      u = User.find_by!(email: "${email}")
      keys = u.vaults.flat_map { |v| v.file_entries.where.not(blob_key: nil).pluck(:blob_key) }
      before = keys.count { |k| R2.object_size(k) rescue nil }
      u.update_columns(trial_started_at: 30.days.ago, free_access_until: 23.days.ago)
      first = TrialFollowUp.call(u)
      early = PurgeTrialCopy.call(u)                       # warned a moment ago: must refuse
      AcquisitionEvent.where(user: u, name: "trial_message").update_all(occurred_at: 8.days.ago)
      u.update_columns(trial_started_at: 38.days.ago, free_access_until: 31.days.ago)
      second = TrialFollowUp.call(User.find(u.id))
      after = keys.count { |k| (R2.object_size(k) rescue nil) }
      marked = FileEntry.where(vault_id: ${first}).count
      puts [first, second, u.vaults.count, before, after, marked, keys.size, early].join(",")
    `);
    const [warning, deleted, vaultsLeft, blobsBefore, blobsAfter, rowsLeft, blobCount, early] = purge.split(",");
    expect(warning).toBe("warning");
    expect(early).toBe("skipped");
    expect(deleted).toBe("deleted");
    expect(vaultsLeft).toBe("0");
    expect(Number(blobCount)).toBe(3);
    expect(blobsBefore).toBe("3");
    expect(blobsAfter).toBe("0");   // gone from storage
    expect(rowsLeft).toBe("0");      // rows removed with the vault, none left behind as "deleted"

    // Still unpaid: the devices only ever hear "a plan is needed".
    expect((await a.engine.sync())?.paymentRequired).toBe(true);
    expect(a.vault.snapshot()).toEqual(NOTES);

    // They pay. Now the devices learn the vault is gone — and keep every note.
    rails(`u = User.find_by!(email: "${email}"); u.change_plan!("lite"); u.update!(paid_until: 1.month.from_now); puts :ok`);
    const goneA = await a.engine.sync();
    const goneB = await b.engine.sync();
    expect(goneA?.vaultGone).toBe(true);
    expect(goneB?.vaultGone).toBe(true);
    expect(goneA?.deletedLocal).toBe(0);
    expect(goneB?.deletedLocal).toBe(0);
    expect(a.vault.snapshot()).toEqual(NOTES);
    expect(b.vault.snapshot()).toEqual({ ...NOTES, "Written-while-paused.md": "only on the phone" });

    // The vault is created again; the notes upload from the devices.
    const again = String((await apiA.createVault("Trial notes")).id);
    await relink(a, again);
    await relink(b, again);
    const pushed = await a.engine.sync();
    expect(pushed?.errors).toEqual([]);
    expect(pushed?.pushed).toBe(3);
    const merged = await b.engine.sync();
    expect(merged?.errors).toEqual([]);
    expect(merged?.deletedLocal).toBe(0);
    await a.engine.sync();

    const everything = { ...NOTES, "Written-while-paused.md": "only on the phone" };
    expect(b.vault.snapshot()).toEqual(everything);
    expect(a.vault.snapshot()).toEqual(everything);
  }, 180_000);
});
