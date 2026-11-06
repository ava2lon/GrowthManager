import {afterEach,describe,expect,it,vi} from "vitest";

vi.mock("server-only", () => ({}));

import {normalizeN8nBaseUrl,validateN8nConnection} from "./n8n-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("normalizeN8nBaseUrl", () => {
  it("accepts n8n Cloud instance URLs", () => {
    expect(normalizeN8nBaseUrl("https://growth-team.app.n8n.cloud/"))
      .toBe("https://growth-team.app.n8n.cloud");
  });

  it("preserves a self-hosted base path for operator-allowlisted hosts", () => {
    vi.stubEnv("N8N_ALLOWED_HOSTS", "automation.example.com,second.example.com");
    expect(normalizeN8nBaseUrl("https://automation.example.com/n8n/"))
      .toBe("https://automation.example.com/n8n");
  });

  it("rejects unapproved hosts and non-HTTPS URLs", () => {
    expect(() => normalizeN8nBaseUrl("https://internal.example.com")).toThrow("N8N_HOST_NOT_ALLOWED");
    expect(() => normalizeN8nBaseUrl("http://growth-team.app.n8n.cloud")).toThrow("N8N_HOST_NOT_ALLOWED");
  });

  it("rejects URL credentials, query strings, and fragments", () => {
    expect(() => normalizeN8nBaseUrl("https://user:pass@growth-team.app.n8n.cloud")).toThrow();
    expect(() => normalizeN8nBaseUrl("https://growth-team.app.n8n.cloud/?token=x")).toThrow();
    expect(() => normalizeN8nBaseUrl("https://growth-team.app.n8n.cloud/#fragment")).toThrow();
  });
});

describe("validateN8nConnection", () => {
  it("uses the documented API key header and workflow-list endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({data: []}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await validateN8nConnection("https://growth-team.app.n8n.cloud", "n8n_test_api_key_123456");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://growth-team.app.n8n.cloud/api/v1/workflows?limit=1");
    expect((options.headers as Record<string,string>)["X-N8N-API-KEY"]).toBe("n8n_test_api_key_123456");
    expect(options.redirect).toBe("error");
    expect(options.cache).toBe("no-store");
  });

  it("classifies rejected API keys without exposing response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret provider body", {status: 401})));
    await expect(validateN8nConnection("https://growth-team.app.n8n.cloud", "n8n_test_api_key_123456"))
      .rejects.toThrow("N8N_AUTH_FAILED");
  });
});

  it("classifies provider rate limits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", {status: 429})));
    await expect(validateN8nConnection("https://growth-team.app.n8n.cloud", "n8n_test_api_key_123456"))
      .rejects.toThrow("N8N_PROVIDER_RATE_LIMITED");
  });
