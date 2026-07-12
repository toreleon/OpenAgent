/**
 * Encryption for per-Site fetch-proxy secrets (Phase 3).
 *
 * Secrets (3rd-party API keys) are AES-256-GCM encrypted at rest under a single
 * key-encryption-key (SITES_SECRETS_KEK, base64 32 bytes). Each encryption uses a
 * fresh 96-bit nonce and binds the ciphertext to its Site+name via AAD, so a row
 * can't be transplanted between sites or renamed. FAIL CLOSED: if the KEK is
 * missing/wrong-length the proxy secret feature is disabled (no plaintext ever
 * stored). The decrypted value only ever exists server-side inside the proxy.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const TAG_BYTES = 16;

function kek(): Buffer | null {
  const raw = process.env.SITES_SECRETS_KEK;
  if (!raw) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return buf.length === 32 ? buf : null;
}

/** True when a valid KEK is configured (i.e. secrets can be stored). */
export function secretsEnabled(): boolean {
  return kek() !== null;
}

function aad(siteId: string, name: string): Buffer {
  return Buffer.from(`${siteId}|${name}`, "utf8");
}

/** Encrypt a secret value, or null when secrets are disabled. */
export function encryptSecret(
  plaintext: string,
  siteId: string,
  name: string,
): { ciphertext: string; nonce: string } | null {
  const key = kek();
  if (!key) return null;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(siteId, name));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]).toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

/** Decrypt a stored secret, or null on any failure (bad KEK, tampering). */
export function decryptSecret(
  ciphertext: string,
  nonce: string,
  siteId: string,
  name: string,
): string | null {
  const key = kek();
  if (!key) return null;
  try {
    const data = Buffer.from(ciphertext, "base64");
    if (data.length <= TAG_BYTES) return null;
    const enc = data.subarray(0, data.length - TAG_BYTES);
    const tag = data.subarray(data.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
    decipher.setAAD(aad(siteId, name));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
