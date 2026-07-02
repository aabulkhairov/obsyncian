// Transforms applied to paths and file contents before they leave the device.
// PlainCodec is a passthrough for unencrypted sync; the E2EE codec implements
// the same interface so the sync engine never knows whether encryption is on.
export interface Codec {
  encodePath(path: string): Promise<string>;
  decodePath(encoded: string): Promise<string>;
  encodeContent(data: ArrayBuffer): Promise<ArrayBuffer>;
  decodeContent(data: ArrayBuffer): Promise<ArrayBuffer>;
}

export class PlainCodec implements Codec {
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
