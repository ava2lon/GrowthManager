import {afterEach, describe, expect, it, vi} from "vitest";
import {
  createWebhookSigningSecret,
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
} from "@/lib/webhook-secret-crypto";

afterEach(() => vi.unstubAllEnvs());

describe("webhook signing secret encryption", () => {
  it("round-trips secrets with workspace and subscription binding", () => {
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY_ID", "test-primary");
    const secret = createWebhookSigningSecret();
    const encrypted = encryptWebhookSigningSecret(secret, "workspace-a", "subscription-a");
    expect(decryptWebhookSigningSecret(encrypted, "workspace-a", "subscription-a")).toBe(secret);
    expect(() => decryptWebhookSigningSecret(encrypted, "workspace-b", "subscription-a")).toThrow();
    expect(() => decryptWebhookSigningSecret(encrypted, "workspace-a", "subscription-b")).toThrow();
  });

  it("supports key rotation with the previous key", () => {
    const previous = Buffer.alloc(32, 3).toString("base64");
    const current = Buffer.alloc(32, 9).toString("base64");
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", previous);
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY_ID", "old");
    const secret = createWebhookSigningSecret();
    const encrypted = encryptWebhookSigningSecret(secret, "workspace-a", "subscription-a");
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", current);
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY_ID", "new");
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY_PREVIOUS", previous);
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY_PREVIOUS_ID", "old");
    expect(decryptWebhookSigningSecret(encrypted, "workspace-a", "subscription-a")).toBe(secret);
  });

  it("rejects malformed encrypted envelopes and missing keys", () => {
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", "");
    expect(() => decryptWebhookSigningSecret("invalid", "workspace-a", "subscription-a")).toThrow();
  });
});
