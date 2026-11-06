import "server-only";

import {isIP} from "node:net";

const N8N_API_TIMEOUT_MS = 10_000;

function approvedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host)) return false;

  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.app\.n8n\.cloud$/.test(host)) {
    return true;
  }

  const allowlisted = (process.env.N8N_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  return allowlisted.includes(host);
}

export function normalizeN8nBaseUrl(input: string): string {
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("Invalid n8n base URL.");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid n8n base URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !approvedHostname(url.hostname)
  ) {
    throw new Error("N8N_HOST_NOT_ALLOWED");
  }

  if (url.pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid n8n base URL path.");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return "https://" + url.hostname.toLowerCase() + (pathname === "/" ? "" : pathname);
}

export async function validateN8nConnection(baseUrl: string, apiKey: string): Promise<void> {
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512) {
    throw new Error("Invalid n8n API key.");
  }

  const normalizedBaseUrl = normalizeN8nBaseUrl(baseUrl);
  let response: Response;
  try {
    response = await fetch(normalizedBaseUrl + "/api/v1/workflows?limit=1", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-N8N-API-KEY": apiKey,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(N8N_API_TIMEOUT_MS),
    });
  } catch {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("N8N_AUTH_FAILED");
  }
  if (response.status === 429) throw new Error("N8N_PROVIDER_RATE_LIMITED");
  if (!response.ok) throw new Error("N8N_PROVIDER_UNAVAILABLE");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as {data?: unknown}).data)) {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }
}


export type N8nWorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string | null;
};

export async function listN8nWorkflows(
  baseUrl: string,
  apiKey: string,
): Promise<{workflows: N8nWorkflowSummary[]; hasMore: boolean}> {
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512) {
    throw new Error("Invalid n8n API key.");
  }

  const normalizedBaseUrl = normalizeN8nBaseUrl(baseUrl);
  const workflows: N8nWorkflowSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let hasMore = false;

  for (let page = 0; page < 3; page += 1) {
    const url = new URL(normalizedBaseUrl + "/api/v1/workflows");
    url.searchParams.set("limit", "50");
    url.searchParams.set("excludePinnedData", "true");
    if (cursor) url.searchParams.set("cursor", cursor);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {Accept: "application/json", "X-N8N-API-KEY": apiKey},
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(N8N_API_TIMEOUT_MS),
      });
    } catch {
      throw new Error("N8N_PROVIDER_UNAVAILABLE");
    }

    if (response.status === 401 || response.status === 403) throw new Error("N8N_AUTH_FAILED");
    if (response.status === 429) throw new Error("N8N_PROVIDER_RATE_LIMITED");
    if (!response.ok) throw new Error("N8N_PROVIDER_UNAVAILABLE");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("N8N_PROVIDER_UNAVAILABLE");
    }
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as {data?: unknown}).data)) {
      throw new Error("N8N_PROVIDER_UNAVAILABLE");
    }

    for (const item of (payload as {data: unknown[]}).data) {
      if (!item || typeof item !== "object") continue;
      const workflow = item as {id?: unknown; name?: unknown; active?: unknown; updatedAt?: unknown};
      if (typeof workflow.id !== "string" || typeof workflow.name !== "string" || typeof workflow.active !== "boolean") continue;
      workflows.push({
        id: workflow.id.slice(0, 128),
        name: workflow.name.slice(0, 240),
        active: workflow.active,
        updatedAt: typeof workflow.updatedAt === "string" && !Number.isNaN(Date.parse(workflow.updatedAt))
          ? workflow.updatedAt
          : null,
      });
    }

    const nextCursor = (payload as {nextCursor?: unknown}).nextCursor;
    if (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 2048 || seenCursors.has(nextCursor)) {
      hasMore = false;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    hasMore = page === 2;
  }

  return {workflows, hasMore};
}


export type N8nWorkflowDetail = {
  id: string;
  name: string;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  nodeCount: number;
  nodes: Array<{name: string; type: string}>;
  connectionCount: number;
};

export async function getN8nWorkflowDetail(
  baseUrl: string,
  apiKey: string,
  workflowId: string,
): Promise<N8nWorkflowDetail> {
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512) {
    throw new Error("Invalid n8n API key.");
  }
  if (typeof workflowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) {
    throw new Error("Invalid n8n workflow ID.");
  }

  const normalizedBaseUrl = normalizeN8nBaseUrl(baseUrl);
  let response: Response;
  try {
    response = await fetch(
      normalizedBaseUrl + "/api/v1/workflows/" + encodeURIComponent(workflowId) + "?excludePinnedData=true",
      {
        method: "GET",
        headers: {Accept: "application/json", "X-N8N-API-KEY": apiKey},
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(N8N_API_TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }

  if (response.status === 401 || response.status === 403) throw new Error("N8N_AUTH_FAILED");
  if (response.status === 404) throw new Error("N8N_WORKFLOW_NOT_FOUND");
  if (response.status === 429) throw new Error("N8N_PROVIDER_RATE_LIMITED");
  if (!response.ok) throw new Error("N8N_PROVIDER_UNAVAILABLE");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }
  if (!payload || typeof payload !== "object") throw new Error("N8N_PROVIDER_UNAVAILABLE");

  const workflow = payload as {
    id?: unknown; name?: unknown; active?: unknown; createdAt?: unknown; updatedAt?: unknown;
    nodes?: unknown; connections?: unknown;
  };
  if (
    workflow.id !== workflowId || typeof workflow.name !== "string" ||
    typeof workflow.active !== "boolean" || !Array.isArray(workflow.nodes) ||
    !workflow.connections || typeof workflow.connections !== "object" || Array.isArray(workflow.connections)
  ) throw new Error("N8N_PROVIDER_UNAVAILABLE");

  const nodes = workflow.nodes.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const node = item as {name?: unknown; type?: unknown};
    if (typeof node.name !== "string" || typeof node.type !== "string") return [];
    return [{name: node.name.slice(0, 160), type: node.type.slice(0, 200)}];
  });
  const connectionMap = workflow.connections as Record<string, unknown>;
  let connectionCount = 0;
  for (const outputs of Object.values(connectionMap)) {
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) continue;
    for (const channels of Object.values(outputs as Record<string, unknown>)) {
      if (!Array.isArray(channels)) continue;
      for (const targets of channels) if (Array.isArray(targets)) connectionCount += targets.length;
    }
  }
  const safeDate = (value: unknown) =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

  return {
    id: workflowId, name: workflow.name.slice(0, 240), active: workflow.active,
    createdAt: safeDate(workflow.createdAt), updatedAt: safeDate(workflow.updatedAt),
    nodeCount: nodes.length, nodes, connectionCount,
  };
}



export type N8nExecutionStatus = "error" | "success" | "waiting";
export type N8nExecutionSummary = {
  id: string;
  workflowId: string;
  status: string;
  mode: string;
  startedAt: string | null;
  stoppedAt: string | null;
  waitTill: string | null;
  retryOf: string | null;
  retrySuccessId: string | null;
};

export async function listN8nExecutions(
  baseUrl: string,
  apiKey: string,
  options: {status?: N8nExecutionStatus; workflowId?: string} = {},
): Promise<{executions: N8nExecutionSummary[]; hasMore: boolean}> {
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512) throw new Error("Invalid n8n API key.");
  if (options.status && !["error", "success", "waiting"].includes(options.status)) throw new Error("Invalid n8n execution status.");
  if (options.workflowId && !/^[A-Za-z0-9_-]{1,128}$/.test(options.workflowId)) throw new Error("Invalid n8n workflow ID.");

  const normalizedBaseUrl = normalizeN8nBaseUrl(baseUrl);
  const executions: N8nExecutionSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let hasMore = false;

  for (let page = 0; page < 3; page += 1) {
    const url = new URL(normalizedBaseUrl + "/api/v1/executions");
    url.searchParams.set("limit", "50");
    url.searchParams.set("includeData", "false");
    if (options.status) url.searchParams.set("status", options.status);
    if (options.workflowId) url.searchParams.set("workflowId", options.workflowId);
    if (cursor) url.searchParams.set("cursor", cursor);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {Accept: "application/json", "X-N8N-API-KEY": apiKey},
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(N8N_API_TIMEOUT_MS),
      });
    } catch {
      throw new Error("N8N_PROVIDER_UNAVAILABLE");
    }
    if (response.status === 401 || response.status === 403) throw new Error("N8N_AUTH_FAILED");
    if (response.status === 429) throw new Error("N8N_PROVIDER_RATE_LIMITED");
    if (!response.ok) throw new Error("N8N_PROVIDER_UNAVAILABLE");

    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("N8N_PROVIDER_UNAVAILABLE"); }
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as {data?: unknown}).data)) {
      throw new Error("N8N_PROVIDER_UNAVAILABLE");
    }

    for (const item of (payload as {data: unknown[]}).data) {
      if (!item || typeof item !== "object") continue;
      const execution = item as Record<string, unknown>;
      if (typeof execution.id !== "string" || typeof execution.workflowId !== "string") continue;
      const safeDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
      const safeId = (value: unknown) => typeof value === "string" && value.length <= 128 ? value : null;
      executions.push({
        id: execution.id.slice(0, 128),
        workflowId: execution.workflowId.slice(0, 128),
        status: typeof execution.status === "string" ? execution.status.slice(0, 40) : "unknown",
        mode: typeof execution.mode === "string" ? execution.mode.slice(0, 40) : "unknown",
        startedAt: safeDate(execution.startedAt),
        stoppedAt: safeDate(execution.stoppedAt),
        waitTill: safeDate(execution.waitTill),
        retryOf: safeId(execution.retryOf),
        retrySuccessId: safeId(execution.retrySuccessId),
      });
    }

    const nextCursor = (payload as {nextCursor?: unknown}).nextCursor;
    if (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 2048 || seenCursors.has(nextCursor)) {
      hasMore = false;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    hasMore = page === 2;
  }
  return {executions, hasMore};
}


export type N8nExecutionRetryResult = {
  id: string;
  retryOf: string;
  workflowId: string;
  status: string;
};

export async function retryN8nExecution(
  baseUrl: string,
  apiKey: string,
  executionId: string,
): Promise<N8nExecutionRetryResult> {
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512) {
    throw new Error("Invalid n8n API key.");
  }
  // n8n execution IDs are numeric path identifiers; reject all other input.
  if (typeof executionId !== "string" || !/^\d{1,20}$/.test(executionId)) {
    throw new Error("Invalid n8n execution ID.");
  }

  const normalizedBaseUrl = normalizeN8nBaseUrl(baseUrl);
  let currentResponse: Response;
  try {
    currentResponse = await fetch(
      normalizedBaseUrl + "/api/v1/executions/" + executionId + "?includeData=false",
      {
        method: "GET",
        headers: {Accept: "application/json", "X-N8N-API-KEY": apiKey},
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(N8N_API_TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }
  if (currentResponse.status === 401 || currentResponse.status === 403) throw new Error("N8N_AUTH_FAILED");
  if (currentResponse.status === 404) throw new Error("N8N_EXECUTION_NOT_FOUND");
  if (currentResponse.status === 429) throw new Error("N8N_PROVIDER_RATE_LIMITED");
  if (!currentResponse.ok) throw new Error("N8N_PROVIDER_UNAVAILABLE");

  let currentPayload: unknown;
  try { currentPayload = await currentResponse.json(); } catch { throw new Error("N8N_PROVIDER_UNAVAILABLE"); }
  if (!currentPayload || typeof currentPayload !== "object") throw new Error("N8N_PROVIDER_UNAVAILABLE");
  const current = currentPayload as Record<string, unknown>;
  if (String(current.id ?? "") !== executionId || typeof current.workflowId !== "string") {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }
  if (current.status !== "error" && current.status !== "crashed") {
    throw new Error("N8N_EXECUTION_NOT_RETRYABLE");
  }

  let retryResponse: Response;
  try {
    retryResponse = await fetch(
      normalizedBaseUrl + "/api/v1/executions/" + executionId + "/retry",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-N8N-API-KEY": apiKey,
        },
        body: JSON.stringify({loadWorkflow: false}),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(N8N_API_TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("N8N_RETRY_OUTCOME_UNKNOWN");
  }
  if (retryResponse.status === 401 || retryResponse.status === 403) throw new Error("N8N_AUTH_FAILED");
  if (retryResponse.status === 404) throw new Error("N8N_EXECUTION_NOT_FOUND");
  if (retryResponse.status === 400 || retryResponse.status === 409 || retryResponse.status === 422) throw new Error("N8N_EXECUTION_NOT_RETRYABLE");
  if (retryResponse.status === 429) throw new Error("N8N_PROVIDER_RATE_LIMITED");
  // A server-side failure may occur after n8n has accepted the retry; treat it as ambiguous.
  if (retryResponse.status >= 500) throw new Error("N8N_RETRY_OUTCOME_UNKNOWN");
  if (!retryResponse.ok) throw new Error("N8N_PROVIDER_UNAVAILABLE");

  let retryPayload: unknown;
  try { retryPayload = await retryResponse.json(); } catch { throw new Error("N8N_RETRY_OUTCOME_UNKNOWN"); }
  if (!retryPayload || typeof retryPayload !== "object") throw new Error("N8N_RETRY_OUTCOME_UNKNOWN");
  const retried = retryPayload as Record<string, unknown>;
  const retryId = typeof retried.id === "number" || typeof retried.id === "string" ? String(retried.id) : "";
  const retryOf = typeof retried.retryOf === "number" || typeof retried.retryOf === "string" ? String(retried.retryOf) : "";
  if (!/^\d{1,20}$/.test(retryId) || retryOf !== executionId ||
      String(retried.workflowId ?? "") !== current.workflowId) {
    throw new Error("N8N_RETRY_OUTCOME_UNKNOWN");
  }

  return {
    id: retryId,
    retryOf,
    workflowId: current.workflowId,
    status: typeof retried.status === "string" ? retried.status.slice(0, 40) : "unknown",
  };
}

export async function setN8nWorkflowActive(
  baseUrl: string,
  apiKey: string,
  workflowId: string,
  active: boolean,
): Promise<void> {
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512) {
    throw new Error("Invalid n8n API key.");
  }
  if (typeof workflowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) {
    throw new Error("Invalid n8n workflow ID.");
  }

  const normalizedBaseUrl = normalizeN8nBaseUrl(baseUrl);
  let response: Response;
  try {
    response = await fetch(
      normalizedBaseUrl + "/api/v1/workflows/" + encodeURIComponent(workflowId) + (active ? "/activate" : "/deactivate"),
      {
        method: "POST",
        headers: {Accept: "application/json", "X-N8N-API-KEY": apiKey},
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(N8N_API_TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("N8N_PROVIDER_UNAVAILABLE");
  }

  if (response.status === 401 || response.status === 403) throw new Error("N8N_AUTH_FAILED");
  if (response.status === 404) throw new Error("N8N_WORKFLOW_NOT_FOUND");
  if (response.status === 429) throw new Error("N8N_PROVIDER_RATE_LIMITED");
  if (!response.ok) throw new Error("N8N_PROVIDER_UNAVAILABLE");
}
