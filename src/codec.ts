import { sha256Hex } from "./util";

// Transforms applied to paths and file contents before they leave the device.
// PlainCodec is a passthrough for unencrypted sync; the E2EE codec implements
// the same interface so the sync engine never knows whether encryption is on.
export interface Codec {
  encodePath(path: string): Promise<string>;
  decodePath(encoded: string): Promise<string>;
  encodeContent(data: ArrayBuffer): Promise<ArrayBuffer>;
  decodeContent(data: ArrayBuffer): Promise<ArrayBuffer>;
  // Deterministic fingerprint of a path: the same path always gives the same
  // token (unlike encodePath, which is randomized), and without the vault
  // key it reveals nothing about the path. The server uses it to refuse a
  // second live file at a path that already has one.
  pathToken(path: string): Promise<string>;
}

export const PATH_TOKEN_DOMAIN = "obsync-path-v1\n";

export function pathTokenInput(path: string): ArrayBuffer {
  return new TextEncoder().encode(PATH_TOKEN_DOMAIN + path.normalize("NFC")).buffer as ArrayBuffer;
}

export class PlainCodec implements Codec {
  // The server already sees a plain vault's paths, so a bare hash is enough.
  async pathToken(path: string): Promise<string> {
    return sha256Hex(pathTokenInput(path));
  }
  async encodePath(path: string): Promise<string> {
    return path;
  }
  async decodePath(encoded: string): Promise<string> {
    return encoded;
  }
  async encodeContent(data: ArrayBuffer): Promise<ArrayBuffer> {
    return data;
  }
  async decodeContent(data: ArrayBuffer): Promise<ArrayBuffer> {
    return data;
  }
}
