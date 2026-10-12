// A WebSocket to the server's "vault changed" channel (ActionCable). The
// server pushes a bare revision number after every commit to the vault, so
// this device can pull right away instead of at its next polling interval.
// Strictly an accelerator: if the socket can't connect, drops, or the server
// predates the channel, the interval timer still syncs exactly as before.

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ChangeSignalOptions {
  serverUrl: () => string;
  token: () => string;
  vaultId: () => string;
  // A commit landed in the vault, bringing it to this revision.
  onRevision: (revision: number) => void;
  // The connection is back after a drop — anything may have been missed.
  onReconnect: () => void;
  createSocket?: (url: string, protocols: string[]) => SocketLike;
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
// The server pings every 3 s; this long without hearing anything means the
// connection is dead even if the socket hasn't noticed (a phone that slept).
const SILENCE_LIMIT_MS = 45_000;
const WATCHDOG_EVERY_MS = 15_000;

export function cableUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "").replace(/^http/i, "ws") + "/cable";
}

export class ChangeSignal {
  private socket: SocketLike | null = null;
  // Which server/account/vault the current socket (or pending retry) is for.
  private identity = "";
  // An identity the server refused to subscribe: don't keep asking.
  private refused = "";
  private attempts = 0;
  private everSubscribed = false;
  private lastHeard = 0;
  private retryTimer: number | null = null;
  private watchdog: number | null = null;

  constructor(private opts: ChangeSignalOptions) {}

  // Makes sure there is a connection for the vault currently linked. Cheap to
  // call often: does nothing while one is up or a retry is already scheduled.
  refresh(): void {
    const wanted = this.wanted();
    if (wanted !== this.identity) {
      this.teardown();
      this.identity = wanted;
      this.attempts = 0;
      this.everSubscribed = false;
    }
    if (!wanted || wanted === this.refused || this.socket || this.retryTimer !== null) return;
    this.connect();
  }

  stop(): void {
    this.teardown();
    this.identity = "";
  }

  private wanted(): string {
    const { serverUrl, token, vaultId } = this.opts;
    return serverUrl() && token() && vaultId() ? `${serverUrl()}\n${token()}\n${vaultId()}` : "";
  }

  private connect(): void {
    const identity = this.identity;
    const subscription = JSON.stringify({ channel: "VaultChannel", vault_id: this.opts.vaultId(), token: this.opts.token() });
    let socket: SocketLike;
    try {
      const create = this.opts.createSocket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
      socket = create(cableUrl(this.opts.serverUrl()), ["actioncable-v1-json"]);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.lastHeard = Date.now();
    this.watchdog = window.setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) this.drop(socket);
    }, WATCHDOG_EVERY_MS);

    socket.onmessage = (ev) => {
      if (this.socket !== socket || this.identity !== identity) return;
      this.lastHeard = Date.now();
      let msg: { type?: string; message?: { revision?: unknown } };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "welcome") {
        socket.send(JSON.stringify({ command: "subscribe", identifier: subscription }));
      } else if (msg.type === "confirm_subscription") {
        this.attempts = 0;
        if (this.everSubscribed) this.opts.onReconnect();
        this.everSubscribed = true;
      } else if (msg.type === "reject_subscription") {
        // Token no longer valid, or no access to the vault: the next sync
        // will say so properly. Nothing to gain from reconnecting.
        this.refused = identity;
        this.teardown();
      } else if (msg.type === "disconnect") {
        this.drop(socket);
      } else if (typeof msg.message?.revision === "number") {
        this.opts.onRevision(msg.message.revision);
      }
    };
    socket.onclose = () => this.drop(socket);
    socket.onerror = () => this.drop(socket);
  }

  private drop(socket: SocketLike): void {
    if (this.socket !== socket) return;
    this.teardown();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.identity || this.identity === this.refused || this.retryTimer !== null) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempts++);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.identity === this.wanted()) this.connect();
    }, delay);
  }

  private teardown(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.retryTimer = null;
    this.watchdog = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }
}

// File events since the last sync was scheduled. Every write the sync engine
// makes fires the same vault events a user's edit does; without telling them
// apart, each pull would schedule another, empty, cycle. A path maps to the
// mtime it had when the event fired, or null if it stopped existing there.
export class LocalChanges {
  private touched = new Map<string, number | null>();
  private force = false;

  note(path: string, mtime: number | null): void {
    this.touched.set(path, mtime);
  }

  // For events that can't be attributed (a folder moved or removed).
  noteUnknown(): void {
    this.force = true;
  }

  // Empties the set; true if anything in it wasn't the engine's own doing.
  takeReal(isOwn: (path: string, mtime: number | null) => boolean): boolean {
    let real = this.force;
    for (const [path, mtime] of this.touched) {
      if (!isOwn(path, mtime)) real = true;
    }
    this.touched.clear();
    this.force = false;
    return real;
  }
}
