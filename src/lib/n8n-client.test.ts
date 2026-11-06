import {afterEach,describe,expect,it,vi} from "vitest";

vi.mock("server-only", () => ({}));

import {listN8nWorkflows,normalizeN8nBaseUrl,validateN8nConnection} from "./n8n-client";

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


describe("listN8nWorkflows", () => {
  it("returns only safe workflow summary fields and follows cursor pagination", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {id: "wf_1", name: "Daily report", active: true, updatedAt: "2026-11-01T10:00:00.000Z", nodes: [{parameters: {secret: "must-not-leak"}}]},
        ],
        nextCursor: "cursor-page-two",
      }), {status: 200, headers: {"content-type": "application/json"}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{id: "wf_2", name: "Lead sync", active: false}],
      }), {status: 200, headers: {"content-type": "application/json"}}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listN8nWorkflows(
      "https://growth-team.app.n8n.cloud",
      "n8n_test_api_key_123456",
    );

    expect(result).toEqual({
      workflows: [
        {id: "wf_1", name: "Daily report", active: true, updatedAt: "2026-11-01T10:00:00.000Z"},
        {id: "wf_2", name: "Lead sync", active: false, updatedAt: null},
      ],
      hasMore: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-page-two");
    expect(secondUrl.searchParams.get("excludePinnedData")).toBe("true");
  });

  it("caps discovery at three pages and indicates remaining results", async () => {
    const page = (cursor: string) => new Response(JSON.stringify({
      data: [{id: cursor, name: "Workflow " + cursor, active: true}],
      nextCursor: "cursor-" + (Number(cursor) + 1),
    }), {status: 200, headers: {"content-type": "application/json"}});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page("1"))
      .mockResolvedValueOnce(page("2"))
      .mockResolvedValueOnce(page("3"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listN8nWorkflows(
      "https://growth-team.app.n8n.cloud",
      "n8n_test_api_key_123456",
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.workflows).toHaveLength(3);
    expect(result.hasMore).toBe(true);
  });

  it("rejects an invalid workflow response without exposing its body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private response details", {status: 200})));
    await expect(listN8nWorkflows(
      "https://growth-team.app.n8n.cloud",
      "n8n_test_api_key_123456",
    )).rejects.toThrow("N8N_PROVIDER_UNAVAILABLE");
  });
});


describe("getN8nWorkflowDetail", () => {
  it("returns node names and types without returning node parameters or credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "wf_123",
      name: "Lead pipeline",
      active: true,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      nodes: [
        {name: "Webhook", type: "n8n-nodes-base.webhook", parameters: {path: "private-path"}, credentials: {httpBasicAuth: {id: "secret-id"}}},
        {name: "CRM", type: "n8n-nodes-base.httpRequest", parameters: {url: "https://private.example"}},
      ],
      connections: {Webhook: {main: [[{node: "CRM", type: "main", index: 0}]]}},
      pinData: {Webhook: [{json: {private: "data"}}]},
    }), {status: 200, headers: {"content-type": "application/json"}}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getN8nWorkflowDetail(
      "https://growth-team.app.n8n.cloud",
      "n8n_test_api_key_123456",
      "wf_123",
    );

    expect(result).toEqual({
      id: "wf_123",
      name: "Lead pipeline",
      active: true,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      nodeCount: 2,
      nodes: [
        {name: "Webhook", type: "n8n-nodes-base.webhook"},
        {name: "CRM", type: "n8n-nodes-base.httpRequest"},
      ],
      connectionCount: 1,
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/workflows/wf_123?excludePinnedData=true");
  });

  it("rejects malformed workflow IDs before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getN8nWorkflowDetail(
      "https://growth-team.app.n8n.cloud",
      "n8n_test_api_key_123456",
      "../other",
    )).rejects.toThrow("Invalid n8n workflow ID.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes not-found responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private provider body", {status: 404})));
    await expect(getN8nWorkflowDetail(
      "https://growth-team.app.n8n.cloud",
      "n8n_test_api_key_123456",
      "wf_missing",
    )).rejects.toThrow("N8N_WORKFLOW_NOT_FOUND");
  });
});
