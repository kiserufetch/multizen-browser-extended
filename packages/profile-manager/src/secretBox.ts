import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
/** `mzenc:v1:<iv>:<tag>:<ciphertext>`, base64url. A 12-byte IV is 16 chars, a 16-byte tag 22. */
const SEALED_RE = /^mzenc:v1:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]*)$/;

/** A value exists that can't be read with the key this process has, or with no key at all. */
export class SecretKeyError extends Error {}

export interface SecretBox {
  seal(plaintext: string): string;
  /** Throws {@link SecretKeyError} when the key isn't the one that sealed it. */
  open(sealed: string): string;
}

export function isSealed(value: string): boolean {
  return SEALED_RE.test(value);
}

/** AES-256-GCM. A fresh IV per value, so equal passwords don't look equal on disk. */
export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) {
    throw new SecretKeyError(`A secret key is ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return `mzenc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
    },
    open(sealed) {
      const match = SEALED_RE.exec(sealed);
      if (!match) throw new SecretKeyError("Not a sealed value");
      const [, iv, tag, ciphertext] = match;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64url"));
        decipher.setAuthTag(Buffer.from(tag!, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext!, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch (e) {
        throw new SecretKeyError("A sealed value can't be opened with this key", { cause: e });
      }
    },
  };
}

/** Hex or base64, however the operator generated it. Names no part of the value when refusing. */
export function parseSecretKey(text: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretKeyError(`A secret key must be ${KEY_BYTES} bytes, as hex or base64`);
  }
  return key;
}

export function generateSecretKey(): Buffer {
  return randomBytes(KEY_BYTES);
}
