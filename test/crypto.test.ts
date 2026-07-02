import { describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api";
import { makeClient } from "./helpers";
import { CryptoCodec, WrongPassphraseError, makeKeyCheck, unlock } from "../src/crypto";

describe("crypto", () => {
  it("round-trips content and paths", async () => {
    const { key } = await makeKeyCheck("hunter2");
    const codec = new CryptoCodec(key);

    const path = "Deep/Заметки/मेरे नोट्स.md";
    expect(await codec.decodePath(await codec.encodePath(path))).toBe(path);

    const data = crypto.getRandomValues(new Uint8Array(10_000)).buffer as ArrayBuffer;
    const decoded = await codec.decodeContent(await codec.encodeContent(data));
    expect(new Uint8Array(decoded)).toEqual(new Uint8Array(data));
  });

  it("unlock accepts the right passphrase and rejects the wrong one", async () => {
    const { keyCheck } = await makeKeyCheck("correct horse");
    await expect(unlock("correct horse", keyCheck)).resolves.toBeDefined();
    await expect(unlock("wrong pony", keyCheck)).rejects.toThrow(WrongPassphraseError);
  });

  it("ciphertext is non-deterministic and carries the magic header", async () => {
    const { key } = await makeKeyCheck("pw");
    const codec = new CryptoCodec(key);
    const data = new TextEncoder().encode("same plaintext").buffer as ArrayBuffer;

    const a = new Uint8Array(await codec.encodeContent(data));
    const b = new Uint8Array(await codec.encodeContent(data));
    expect(new TextDecoder().decode(a.subarray(0, 4))).toBe("OBS1");
    expect(a).not.toEqual(b);
  });

  it("decoding with the wrong key fails, not corrupts", async () => {
    const codec1 = new CryptoCodec((await makeKeyCheck("one")).key);
    const codec2 = new CryptoCodec((await makeKeyCheck("two")).key);
    const blob = await codec1.encodeContent(new TextEncoder().encode("secret").buffer as ArrayBuffer);
    await expect(codec2.decodeContent(blob)).rejects.toThrow();
  });

  it("two E2EE clients converge and the server never sees plaintext", async () => {
    const server = new FakeApi();
    const { key, keyCheck } = await makeKeyCheck("shared secret");
    const a = makeClient(server, new CryptoCodec(key));
    const b = makeClient(server, new CryptoCodec(await unlock("shared secret", keyCheck)));

    a.vault.write("Secret Plans/World Domination.md", "step 1: sync notes");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.vault.read("Secret Plans/World Domination.md")).toBe("step 1: sync notes");

    // Nothing readable server-side: paths and contents are ciphertext.
    for (const entry of server.entries.values()) {
      expect(entry.encrypted_path).not.toContain("World Domination");
    }
    const allBlobs = [...server.blobs.values()]
      .map((blob) => new TextDecoder("utf-8", { fatal: false }).decode(blob))
      .join("");
    expect(allBlobs).not.toContain("step 1");
    expect(allBlobs).not.toContain("sync notes");
  });
});
