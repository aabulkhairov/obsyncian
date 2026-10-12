import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./obsidian-mock"; // defines `window` for node
import { ChangeSignal, LocalChanges, SocketLike, cableUrl } from "../src/signal";

class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string, public protocols: string[]) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  receive(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const ids = { serverUrl: "https://obsyncian.com/", token: "obs_tok", vaultId: "7" };
  const revisions: number[] = [];
  let reconnects = 0;
  const signal = new ChangeSignal({
    serverUrl: () => ids.serverUrl,
    token: () => ids.token,
    vaultId: () => ids.vaultId,
    onRevision: (r) => revisions.push(r),
    onReconnect: () => reconnects++,
    createSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  });
  const subscribe = (s: FakeSocket) => { s.receive({ type: "welcome" }); s.receive({ type: "confirm_subscription" }); };
  return { signal, sockets, ids, revisions, reconnects: () => reconnects, subscribe };
}

describe("ChangeSignal", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("derives the cable URL from the server URL", () => {
    expect(cableUrl("https://obsyncian.com/")).toBe("wss://obsyncian.com/cable");
    expect(cableUrl("http://localhost:3000")).toBe("ws://localhost:3000/cable");
  });

  it("subscribes with the token in the subscription, not the URL, and relays revisions", () => {
    const h = harness();
    h.signal.refresh();
    const [s] = h.sockets;
    expect(s.url).toBe("wss://obsyncian.com/cable");
    expect(s.url).not.toContain("obs_tok");
    s.receive({ type: "welcome" });
    const sub = JSON.parse(s.sent[0]) as { command: string; identifier: string };
    expect(sub.command).toBe("subscribe");
    expect(JSON.parse(sub.identifier)).toEqual({ channel: "VaultChannel", vault_id: "7", token: "obs_tok" });

    s.receive({ type: "confirm_subscription" });
    s.receive({ type: "ping", message: 1 });
    s.receive({ identifier: sub.identifier, message: { revision: 42 } });
    expect(h.revisions).toEqual([42]);
    expect(h.reconnects()).toBe(0);
  });

  it("is idempotent while connected", () => {
    const h = harness();
    h.signal.refresh();
    h.signal.refresh();
    h.signal.refresh();
    expect(h.sockets.length).toBe(1);
  });

  it("reconnects with backoff after a drop and asks for a catch-up sync", () => {
    const h = harness();
    h.signal.refresh();
    h.subscribe(h.sockets[0]);
    h.sockets[0].onclose?.({});
    h.signal.refresh(); // a sync cycle in the meantime must not stack a second attempt
    expect(h.sockets.length).toBe(1);

    vi.advanceTimersByTime(5_000);
    expect(h.sockets.length).toBe(2);
    h.sockets[1].onerror?.({});
    vi.advanceTimersByTime(9_999);
    expect(h.sockets.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(h.sockets.length).toBe(3);

    h.subscribe(h.sockets[2]);
    expect(h.reconnects()).toBe(1);
  });

  it("treats a silent connection as dead", () => {
    const h = harness();
    h.signal.refresh();
    h.subscribe(h.sockets[0]);
    vi.advanceTimersByTime(30_000);
    h.sockets[0].receive({ type: "ping", message: 1 });
    vi.advanceTimersByTime(30_000);
    expect(h.sockets[0].closed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(h.sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(h.sockets.length).toBe(2);
  });

  it("stops asking once the server refuses the subscription, until the identity changes", () => {
    const h = harness();
    h.signal.refresh();
    h.sockets[0].receive({ type: "welcome" });
    h.sockets[0].receive({ type: "reject_subscription" });
    expect(h.sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(600_000);
    h.signal.refresh();
    expect(h.sockets.length).toBe(1);

    h.ids.token = "obs_new";
    h.signal.refresh();
    expect(h.sockets.length).toBe(2);
  });

  it("moves to the new vault when the linked vault changes, ignoring the old socket", () => {
    const h = harness();
    h.signal.refresh();
    h.subscribe(h.sockets[0]);
    h.ids.vaultId = "8";
    h.signal.refresh();
    expect(h.sockets[0].closed).toBe(true);
    expect(h.sockets.length).toBe(2);
    h.sockets[1].receive({ type: "welcome" });
    expect(JSON.parse((JSON.parse(h.sockets[1].sent[0]) as { identifier: string }).identifier)).toMatchObject({ vault_id: "8" });
    expect(h.reconnects()).toBe(0);
  });

  it("does nothing when not linked, and stop() cancels a pending retry", () => {
    const h = harness();
    h.ids.vaultId = "";
    h.signal.refresh();
    expect(h.sockets.length).toBe(0);

    h.ids.vaultId = "7";
    h.signal.refresh();
    h.sockets[0].onclose?.({});
    h.signal.stop();
    vi.advanceTimersByTime(600_000);
    expect(h.sockets.length).toBe(1);
  });

  it("survives a server with no cable endpoint: retries slow down to every five minutes", () => {
    const h = harness();
    h.signal.refresh();
    for (const seconds of [5, 10, 20, 40, 80, 160, 300, 300, 300]) {
      const before = h.sockets.length;
      h.sockets[before - 1].onerror?.({}); // the connection attempt fails
      vi.advanceTimersByTime(seconds * 1000 - 1);
      expect(h.sockets.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(h.sockets.length).toBe(before + 1);
    }
  });
});

describe("LocalChanges", () => {
  const own = new Map<string, number | null>([["pulled.md", 100], ["trashed.md", null]]);
  const isOwn = (path: string, mtime: number | null) => own.has(path) && own.get(path) === mtime;

  it("is not real when everything in it is the engine's doing", () => {
    const c = new LocalChanges();
    c.note("pulled.md", 100);
    c.note("trashed.md", null);
    expect(c.takeReal(isOwn)).toBe(false);
  });

  it("is real when the user touched anything, including a file the engine also wrote", () => {
    const c = new LocalChanges();
    c.note("pulled.md", 100);
    c.note("mine.md", 5);
    expect(c.takeReal(isOwn)).toBe(true);

    c.note("pulled.md", 101); // edited after the pull
    expect(c.takeReal(isOwn)).toBe(true);
  });

  it("empties itself, and unattributable events always count", () => {
    const c = new LocalChanges();
    c.note("mine.md", 5);
    expect(c.takeReal(isOwn)).toBe(true);
    expect(c.takeReal(isOwn)).toBe(false);
    c.noteUnknown();
    expect(c.takeReal(isOwn)).toBe(true);
    expect(c.takeReal(isOwn)).toBe(false);
  });
});
