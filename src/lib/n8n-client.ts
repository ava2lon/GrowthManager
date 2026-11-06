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
