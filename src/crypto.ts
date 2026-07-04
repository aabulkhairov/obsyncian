// E2EE codec: WebCrypto only (mobile has no Node crypto). AES-256-GCM with a
// PBKDF2-derived key. The per-vault salt and a key-check value live on the
// server (vault.key_check) so every device can derive and verify the same key
// — the passphrase itself never leaves the device.
import { Codec } from "./codec";
import { base64Decode, base64Encode } from "./util";

const ITERATIONS = 600_000;
const IV_LENGTH = 12;
const MAGIC = new TextEncoder().encode("OBS1");
const KCV_PLAINTEXT = new TextEncoder().encode("obsync-key-check-v1");

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong encryption passphrase for this vault.");
  }
}

interface KeyCheck {
  v: 1;
  salt: string;
  kcv: string;
}

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [ "deriveKey" ]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [ "encrypt", "decrypt" ]
  );
}

// For a brand-new vault: random salt + key-check value, serialized for the
// server's vault.key_check field.
export async function makeKeyCheck(passphrase: string): Promise<{ keyCheck: string; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const kcv = await encryptBytes(key, KCV_PLAINTEXT.buffer);
  const keyCheck: KeyCheck = { v: 1, salt: base64Encode(salt.buffer), kcv: base64Encode(kcv) };
  return { keyCheck: JSON.stringify(keyCheck), key };
}

// For linking an existing vault: derive from the stored salt and prove the
// passphrase by decrypting the key-check value.
export async function unlock(passphrase: string, keyCheckJson: string): Promise<CryptoKey> {
  let parsed: KeyCheck;
  try {
    parsed = JSON.parse(keyCheckJson) as KeyCheck;
  } catch {
    throw new Error("Corrupt key_check on server.");
  }
  const key = await deriveKey(passphrase, new Uint8Array(base64Decode(parsed.salt)));
  try {
    const plain = new Uint8Array(await decryptBytes(key, base64Decode(parsed.kcv)));
    if (!bytesEqual(plain, KCV_PLAINTEXT)) throw new Error("mismatch");
  } catch {
    throw new WrongPassphraseError();
  }
  return key;
}

export class CryptoCodec implements Codec {
  constructor(private key: CryptoKey) {}

  async encodePath(path: string): Promise<string> {
    const ct = await encryptBytes(this.key, new TextEncoder().encode(path).buffer);
    return base64Encode(ct);
  }

  async decodePath(encoded: string): Promise<string> {
    const plain = await decryptBytes(this.key, base64Decode(encoded));
    return new TextDecoder().decode(plain);
  }

  async encodeContent(data: ArrayBuffer): Promise<ArrayBuffer> {
    return encryptBytes(this.key, data, MAGIC);
  }

  async decodeContent(data: ArrayBuffer): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength < MAGIC.byteLength || !bytesEqual(bytes.subarray(0, MAGIC.byteLength), MAGIC)) {
      throw new Error("Not an Obsyncian-encrypted blob (bad magic).");
    }
    return decryptBytes(this.key, data, MAGIC.byteLength);
  }
}

// Layout: [prefix?][iv (12)][AES-GCM ciphertext+tag]
async function encryptBytes(key: CryptoKey, data: ArrayBuffer, prefix?: Uint8Array): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data));
  const prefixLength = prefix?.byteLength ?? 0;
  const out = new Uint8Array(prefixLength + IV_LENGTH + ct.byteLength);
  if (prefix) out.set(prefix, 0);
  out.set(iv, prefixLength);
  out.set(ct, prefixLength + IV_LENGTH);
  return out.buffer;
}

async function decryptBytes(key: CryptoKey, data: ArrayBuffer, offset = 0): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  const iv = bytes.subarray(offset, offset + IV_LENGTH);
  const ct = bytes.subarray(offset + IV_LENGTH);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return a.every((v, i) => v === b[i]);
}
