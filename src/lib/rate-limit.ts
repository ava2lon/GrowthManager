import {createHash} from "node:crypto";

type RateLimitResult = {
  allowed: boolean;
  retryAfter: number;
  configured: boolean;
  unavailable?: boolean;
};

const incrementScript = [
  "local current = redis.call('INCR', KEYS[1])",
  "if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
  "local ttl = redis.call('TTL', KEYS[1])",
  "return {current, ttl}",
].join("\n");

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim();
  return ip || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return {
      allowed: process.env.NODE_ENV !== "production",
      retryAfter: windowSeconds,
      configured: false,
    };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        "EVAL",
        incrementScript,
        "1",
        `growthmanager:ratelimit:${digest(key)}`,
        String(windowSeconds),
      ]),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Rate-limit store returned HTTP ${response.status}`);
    }

    const payload: {result?: unknown; error?: string} = await response.json();
    if (payload.error || !Array.isArray(payload.result)) {
      throw new Error("Rate-limit store returned an invalid response");
    }

    const count = Number(payload.result[0]);
    const ttl = Math.max(1, Number(payload.result[1]) || windowSeconds);

    if (!Number.isFinite(count)) {
      throw new Error("Rate-limit store returned an invalid counter");
    }

    return {
      allowed: count <= limit,
      retryAfter: ttl,
      configured: true,
    };
  } catch (error) {
    console.error("Rate-limit check failed.", error);
    return {allowed: false, retryAfter: 60, configured: true, unavailable: true};
  }
}

export function rateLimitResponse(retryAfter: number) {
  return new Response(
    JSON.stringify({error: "Too many attempts. Please try again later."}),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, retryAfter)),
        "Cache-Control": "no-store",
      },
    },
  );
}

export function rateLimitUnavailableResponse() {
  return new Response(
    JSON.stringify({error: "Authentication is temporarily unavailable. Please try again later."}),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": "60",
      },
    },
  );
}
