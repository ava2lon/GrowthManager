import {createCipheriv, createDecipheriv, randomBytes} from "node:crypto";

type KeyConfig = {id: string; key: Buffer};

const ENVELOPE_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

function readKey(value: string | undefined, id: string | undefined, label: string): KeyConfig | null {
  if (!value) return null;
  const keyId = id || (label === "current" ? "primary" : "previous");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error(`Invalid integration encryption key identifier for ${label} key.`);
  }

  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(`Integration encryption ${label} key must be a canonical base64-encoded 32-byte key.`);
  }
  return {id: keyId, key};
}

function configuredKeys() {
  const current = readKey(
    process.env.INTEGRATION_ENCRYPTION_KEY,
    process.env.INTEGRATION_ENCRYPTION_KEY_ID,
    "current",
  );
  if (!current) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured.");

  const previous = readKey(
    process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS,
    process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS_ID,
    "previous",
  );

  if (previous && previous.id === current.id) {
    throw new Error("Current and previous integration encryption key identifiers must differ.");
  }
  return {current, previous};
}

function additionalData(workspaceId: string, integrationId: string) {
  if (!workspaceId || !integrationId) {
    throw new Error("Workspace and integration identifiers are required for credential encryption.");
  }
  return Buffer.from(`growthmanager:integration:${ENVELOPE_VERSION}:${workspaceId}:${integrationId}`, "utf8");
}

function assertCredentialObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Integration credentials must be a JSON object.");
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new Error();
    JSON.parse(serialized);
  } catch {
    throw new Error("Integration credentials must contain valid JSON values.");
  }
}

export function encryptIntegrationCredentials(
  credentials: Record<string, unknown>,
  workspaceId: string,
  integrationId: string,
): string {
  assertCredentialObject(credentials);
  const {current} = configuredKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, current.key, iv);
  cipher.setAAD(additionalData(workspaceId, integrationId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    current.id,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptIntegrationCredentials(
  envelope: string,
  workspaceId: string,
  integrationId: string,
): Record<string, unknown> {
  if (typeof envelope !== "string" || envelope.length > 100_000) {
    throw new Error("Invalid encrypted integration credential envelope.");
  }

  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Unsupported encrypted integration credential envelope.");
  }
  const [, keyId, ivEncoded, tagEncoded, ciphertextEncoded] = parts;
  const {current, previous} = configuredKeys();
  const selected = [current, previous].find((candidate) => candidate?.id === keyId);
  if (!selected) throw new Error("No configured key can decrypt these integration credentials.");

  const iv = Buffer.from(ivEncoded, "base64url");
  const tag = Buffer.from(tagEncoded, "base64url");
  const ciphertext = Buffer.from(ciphertextEncoded, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Invalid encrypted integration credential envelope.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, selected.key, iv);
    decipher.setAAD(additionalData(workspaceId, integrationId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    assertCredentialObject(parsed);
    return parsed;
  } catch {
    throw new Error("Unable to decrypt integration credentials. Check the key and record context.");
  }
}
