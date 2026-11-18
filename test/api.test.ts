import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, findVaultByName, retryTransient, withTimeout, type VaultInfo } from "../src/api";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects a request that never settles once the timeout elapses", async () => {
    const neverSettles = new Promise(() => {});
    const result = withTimeout(neverSettles, 10_000);
    const assertion = expect(result).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("resolves normally when the request beats the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 10_000)).resolves.toBe("ok");
  });

  it("propagates the original rejection when the request fails before the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 10_000)).rejects.toThrow("boom");
  });

  it("does not fire the timeout after the request already settled", async () => {
    await withTimeout(Promise.resolve("ok"), 10_000);
    // If the timer weren't cleared, this would blow up as an unhandled rejection.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});

describe("findVaultByName", () => {
  const vault = (id: number, name: string): VaultInfo => ({ id, name, latest_revision: 0, key_check: null });

  it("matches case- and whitespace-insensitively", () => {
    const vaults = [ vault(1, "Indalamar Labs"), vault(2, "Work") ];
    expect(findVaultByName(vaults, "  indalamar labs  ")).toBe(vaults[0]);
  });

  it("returns undefined when nothing matches", () => {
    expect(findVaultByName([ vault(1, "Work") ], "Personal")).toBeUndefined();
  });

  it("returns undefined for an empty vault list", () => {
    expect(findVaultByName([], "Anything")).toBeUndefined();
  });
});

describe("retryTransient", () => {
  const replies = (...statuses: number[]) => {
    const send = vi.fn();
    for (const status of statuses) send.mockResolvedValueOnce({ status });
    return send;
  };

  it("resends after a transient 503 and returns the success", async () => {
    const send = replies(503, 200);
    await expect(retryTransient(send, [0, 0])).resolves.toEqual({ status: 200 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives back the last bad reply once the retries run out", async () => {
    const send = replies(503, 502, 503);
    await expect(retryTransient(send, [0, 0])).resolves.toEqual({ status: 503 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not resend a permanent error", async () => {
    const send = replies(403);
    await expect(retryTransient(send, [0, 0])).resolves.toEqual({ status: 403 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
