import {afterEach, describe, expect, it} from "vitest";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "./integration-crypto";

const originalEnv = {
  key: process.env.INTEGRATION_ENCRYPTION_KEY,
  keyId: process.env.INTEGRATION_ENCRYPTION_KEY_ID,
  previous: process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS,
  previousId: process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS_ID,
};
const keyA = Buffer.alloc(32, 1).toString("base64");
const keyB = Buffer.alloc(32, 2).toString("base64");

function configureCurrentKey(key = keyA, id = "key-a") {
  process.env.INTEGRATION_ENCRYPTION_KEY = key;
  process.env.INTEGRATION_ENCRYPTION_KEY_ID = id;
}

afterEach(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("INTEGRATION_ENCRYPTION_KEY", originalEnv.key);
  restore("INTEGRATION_ENCRYPTION_KEY_ID", originalEnv.keyId);
  restore("INTEGRATION_ENCRYPTION_KEY_PREVIOUS", originalEnv.previous);
  restore("INTEGRATION_ENCRYPTION_KEY_PREVIOUS_ID", originalEnv.previousId);
});

describe("integration credential encryption", () => {
  it("round-trips credentials with authenticated encryption", () => {
    configureCurrentKey();
    const credentials = {accessToken: "secret-token", nested: {refreshToken: "refresh"}};
    const encrypted = encryptIntegrationCredentials(credentials, "workspace-1", "integration-1");

    expect(encrypted).not.toContain("secret-token");
    expect(decryptIntegrationCredentials(encrypted, "workspace-1", "integration-1")).toEqual(credentials);
  });

  it("uses a fresh nonce for each encryption", () => {
    configureCurrentKey();
    const first = encryptIntegrationCredentials({token: "same"}, "workspace-1", "integration-1");
    const second = encryptIntegrationCredentials({token: "same"}, "workspace-1", "integration-1");
    expect(first).not.toBe(second);
  });

  it("rejects ciphertext copied to another workspace or integration", () => {
    configureCurrentKey();
    const encrypted = encryptIntegrationCredentials({token: "secret"}, "workspace-1", "integration-1");
    expect(() => decryptIntegrationCredentials(encrypted, "workspace-2", "integration-1")).toThrow();
    expect(() => decryptIntegrationCredentials(encrypted, "workspace-1", "integration-2")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    configureCurrentKey();
    const encrypted = encryptIntegrationCredentials({token: "secret"}, "workspace-1", "integration-1");
    const parts = encrypted.split(".");
    const ciphertext = Buffer.from(parts[4], "base64url");
    ciphertext[0] ^= 1;
    parts[4] = ciphertext.toString("base64url");
    expect(() => decryptIntegrationCredentials(parts.join("."), "workspace-1", "integration-1")).toThrow();
  });

  it("decrypts with a previous key during key rotation", () => {
    configureCurrentKey(keyA, "key-a");
    const encryptedWithOldKey = encryptIntegrationCredentials({token: "old-secret"}, "workspace-1", "integration-1");

    configureCurrentKey(keyB, "key-b");
    process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS = keyA;
    process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS_ID = "key-a";

    expect(decryptIntegrationCredentials(encryptedWithOldKey, "workspace-1", "integration-1"))
      .toEqual({token: "old-secret"});
    expect(encryptIntegrationCredentials({token: "new-secret"}, "workspace-1", "integration-1"))
      .toMatch(/^v1\.key-b\./);
  });

  it("requires a valid 32-byte key and object credentials", () => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    expect(() => encryptIntegrationCredentials({token: "x"}, "workspace-1", "integration-1")).toThrow();
    configureCurrentKey(Buffer.alloc(16, 3).toString("base64"));
    expect(() => encryptIntegrationCredentials({token: "x"}, "workspace-1", "integration-1")).toThrow();
    configureCurrentKey();
    expect(() => encryptIntegrationCredentials([] as unknown as Record<string, unknown>, "workspace-1", "integration-1")).toThrow();
  });
});
