import "server-only";
import {createCipheriv, createDecipheriv, randomBytes} from "node:crypto";

type EncryptionKey = {id: string; key: Buffer};
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

function parseKey(value: string | undefined, id: string | undefined, label: string): EncryptionKey | null {
  if (!value) return null;
  const keyId = id || (label === "current" ? "primary" : "previous");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) throw new Error("Invalid webhook encryption key identifier.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be canonical base64 for a 32-byte key.");
  }
  return {id: keyId, key};
}

function keys() {
  const current = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY, process.env.INTEGRATION_ENCRYPTION_KEY_ID, "current");
  const previous = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS, process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS_ID, "previous");
  if (!current) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured.");
  if (previous && previous.id === current.id) throw new Error("Current and previous encryption key identifiers must differ.");
  return {current, previous};
}

function aad(workspaceId: string, subscriptionId: string) {
  if (!workspaceId || !subscriptionId) throw new Error("Webhook secret encryption requires workspace and subscription identifiers.");
  return Buffer.from(`growthmanager:webhook:v1:${workspaceId}:${subscriptionId}`, "utf8");
}

export function createWebhookSigningSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64url");
}

export function encryptWebhookSigningSecret(secret: string, workspaceId: string, subscriptionId: string): string {
  if (!/^whsec_[A-Za-z0-9_-]{40,60}$/.test(secret)) throw new Error("Invalid webhook signing secret.");
  const {current} = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, current.key, iv);
  cipher.setAAD(aad(workspaceId, subscriptionId));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [VERSION, current.id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptWebhookSigningSecret(envelope: string, workspaceId: string, subscriptionId: string): string {
  if (typeof envelope !== "string" || envelope.length > 2048) throw new Error("Invalid encrypted webhook secret.");
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error("Unsupported encrypted webhook secret.");
  const [, keyId, ivValue, tagValue, ciphertextValue] = parts;
  const {current, previous} = keys();
  const selected = [current, previous].find((item) => item?.id === keyId);
  if (!selected) throw new Error("No configured encryption key can decrypt this webhook secret.");
  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  const ciphertext = Buffer.from(ciphertextValue, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("Malformed encrypted webhook secret.");
  try {
    const decipher = createDecipheriv(ALGORITHM, selected.key, iv);
    decipher.setAAD(aad(workspaceId, subscriptionId));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!/^whsec_[A-Za-z0-9_-]{40,60}$/.test(secret)) throw new Error();
    return secret;
  } catch {
    throw new Error("Unable to decrypt webhook signing secret for this workspace subscription.");
  }
}
