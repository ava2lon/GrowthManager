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
