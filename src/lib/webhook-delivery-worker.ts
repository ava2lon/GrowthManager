import "server-only";
import {createHmac} from "node:crypto";
import {request as httpsRequest} from "node:https";
import {db} from "@/lib/db";
import {decryptWebhookSigningSecret} from "@/lib/webhook-secret-crypto";
import {resolveSafeWebhookEndpoint} from "@/lib/webhook-endpoint-security";
import {
  WEBHOOK_DELIVERY_LOCK_TTL_MS,
  WEBHOOK_DELIVERY_MAX_ATTEMPTS,
  classifyWebhookResponse,
  getWebhookRetryAt,
} from "@/lib/webhook-delivery-policy";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8_192;
const MAX_BATCH_SIZE = 10;
const MAX_CONSECUTIVE_FAILURES = 20;

type Candidate = {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  attemptCount: number;
  retryAttempts: number;
  subscription: {endpointUrl: string; signingSecretEncrypted: string; status: string};
};

function postPinned(input: {
  url: URL;
  ipv4: string;
  body: string;
  headers: Record<string, string>;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const lookup = ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
      callback(null, input.ipv4, 4);
    }) as never;
    const request = httpsRequest({
      protocol: "https:",
      hostname: input.url.hostname,
      port: 443,
      path: input.url.pathname + input.url.search,
      method: "POST",
      servername: input.url.hostname,
      lookup,
      headers: {
        ...input.headers,
        Host: input.url.host,
        "Content-Length": String(Buffer.byteLength(input.body)),
      },
    }, (response) => {
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) request.destroy(new Error("WEBHOOK_RESPONSE_TOO_LARGE"));
      });
      response.on("error", reject);
      response.on("end", () => resolve(response.statusCode ?? 0));
      response.resume();
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("WEBHOOK_REQUEST_TIMEOUT")));
    request.on("error", reject);
    request.end(input.body);
  });
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^WEBHOOK_[A-Z0-9_]+$/.test(message)) return message;
  if (message === "ETIMEDOUT" || message === "WEBHOOK_REQUEST_TIMEOUT") return "WEBHOOK_REQUEST_TIMEOUT";
  if (message === "ECONNRESET" || message === "ECONNREFUSED" || message === "EHOSTUNREACH" || message === "ENETUNREACH") return "WEBHOOK_NETWORK_ERROR";
  return "WEBHOOK_DELIVERY_FAILED";
}

async function claimDelivery(candidate: Candidate, now: Date) {
  const staleLock = new Date(now.getTime() - WEBHOOK_DELIVERY_LOCK_TTL_MS);
  return db.$transaction(async (tx) => {
    const claimed = await tx.webhookDelivery.updateMany({
      where: {
        id: candidate.id,
        workspaceId: candidate.workspaceId,
        subscriptionId: candidate.subscriptionId,
        attemptCount: candidate.attemptCount,
        retryAttempts: candidate.retryAttempts,
        status: {in: ["PENDING", "RETRY", "PROCESSING"]},
        nextAttemptAt: {lte: now},
        OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}],
        subscription: {status: "ACTIVE"},
      },
      data: {status: "PROCESSING", lockedAt: now, attemptCount: {increment: 1}, retryAttempts: {increment: 1}},
    });
    if (claimed.count !== 1) return null;
    const attemptNumber = candidate.attemptCount + 1;
    const attempt = await tx.webhookDeliveryAttempt.create({
      data: {
        workspaceId: candidate.workspaceId,
        deliveryId: candidate.id,
        attemptNumber,
        status: "PROCESSING",
        startedAt: now,
      },
      select: {id: true},
    });
    return {attemptNumber, attemptId: attempt.id};
  });
}

export async function dispatchWorkspaceWebhookDeliveries(batchSize = MAX_BATCH_SIZE) {
  const now = new Date();
  const limit = Math.max(1, Math.min(Math.floor(batchSize), MAX_BATCH_SIZE));
  const candidates = await db.webhookDelivery.findMany({
    where: {
      status: {in: ["PENDING", "RETRY", "PROCESSING"]},
      nextAttemptAt: {lte: now},
      OR: [{lockedAt: null}, {lockedAt: {lte: new Date(now.getTime() - WEBHOOK_DELIVERY_LOCK_TTL_MS)}}],
      subscription: {status: "ACTIVE", disabledAt: null},
    },
    orderBy: [{nextAttemptAt: "asc"}, {createdAt: "asc"}],
    take: limit * 4,
    select: {
      id: true, workspaceId: true, subscriptionId: true, eventId: true,
      eventType: true, payload: true, attemptCount: true, retryAttempts: true,
      subscription: {select: {endpointUrl: true, signingSecretEncrypted: true, status: true}},
    },
  });

  const result = {examined: candidates.length, claimed: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0};
  for (const candidate of candidates) {
    if (result.claimed >= limit) break;
    const claim = await claimDelivery(candidate as Candidate, now);
    if (!claim) { result.skipped++; continue; }
    result.claimed++;
    const started = Date.now();
    let httpStatus: number | null = null;
    let errorCode: string | null = null;
    let outcome: "DELIVERED" | "RETRY" | "TERMINAL" = "TERMINAL";
    let retryAt: Date | null = null;

    try {
      const destination = await resolveSafeWebhookEndpoint(candidate.subscription.endpointUrl);
      const secret = decryptWebhookSigningSecret(
        candidate.subscription.signingSecretEncrypted,
        candidate.workspaceId,
        candidate.subscriptionId,
      );
      const body = JSON.stringify(candidate.payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(timestamp + "." + body, "utf8").digest("hex");
      httpStatus = await postPinned({
        url: destination.url,
        ipv4: destination.ipv4,
        body,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "GrowthManager-Webhooks/1.0",
          "X-GrowthManager-Event": candidate.eventType,
          "X-GrowthManager-Delivery": candidate.id,
          "X-GrowthManager-Timestamp": timestamp,
          "X-GrowthManager-Signature": "v1=" + signature,
          "Idempotency-Key": candidate.id,
        },
      });
      outcome = classifyWebhookResponse(httpStatus);
      if (outcome !== "DELIVERED") errorCode = "WEBHOOK_HTTP_" + httpStatus;
    } catch (error) {
      errorCode = safeErrorCode(error);
      outcome = ["WEBHOOK_URL_INVALID", "WEBHOOK_URL_NOT_ALLOWED", "WEBHOOK_DESTINATION_NOT_PUBLIC", "WEBHOOK_DNS_LOOKUP_FAILED"].includes(errorCode)
        ? "TERMINAL"
        : "RETRY";
    }

    const finishedAt = new Date();
    if (outcome === "RETRY") {
      retryAt = getWebhookRetryAt({attempt: candidate.retryAttempts + 1, now: finishedAt, deliveryId: candidate.id});
    }
    const finalStatus = outcome === "DELIVERED" ? "DELIVERED"
      : outcome === "RETRY" && retryAt ? "RETRY" : "FAILED";

    await db.$transaction(async (tx) => {
      await tx.webhookDeliveryAttempt.updateMany({
        where: {id: claim.attemptId, workspaceId: candidate.workspaceId, deliveryId: candidate.id, attemptNumber: claim.attemptNumber},
        data: {
          status: finalStatus,
          httpStatus,
          errorCode,
          durationMs: Math.max(0, finishedAt.getTime() - started),
          finishedAt,
        },
      });
      const saved = await tx.webhookDelivery.updateMany({
        where: {id: candidate.id, workspaceId: candidate.workspaceId, status: "PROCESSING", lockedAt: now},
        data: {
          status: finalStatus,
          lockedAt: null,
          nextAttemptAt: retryAt ?? finishedAt,
          deliveredAt: outcome === "DELIVERED" ? finishedAt : null,
          ...(outcome === "DELIVERED" ? {retryAttempts: 0} : {}),
          lastHttpStatus: httpStatus,
          lastErrorCode: outcome === "DELIVERED" ? null : errorCode ?? "WEBHOOK_DELIVERY_FAILED",
        },
      });
      if (saved.count !== 1) return;

      if (outcome === "DELIVERED") {
        await tx.webhookSubscription.updateMany({
          where: {id: candidate.subscriptionId, workspaceId: candidate.workspaceId},
          data: {consecutiveFailures: 0, lastDeliveryAt: finishedAt},
        });
      } else {
        await tx.webhookSubscription.updateMany({
          where: {id: candidate.subscriptionId, workspaceId: candidate.workspaceId},
          data: {consecutiveFailures: {increment: 1}},
        });
        await tx.webhookSubscription.updateMany({
          where: {id: candidate.subscriptionId, workspaceId: candidate.workspaceId, consecutiveFailures: {gte: MAX_CONSECUTIVE_FAILURES - 1}},
          data: {status: "PAUSED", disabledAt: finishedAt},
        });
      }
    });

    if (outcome === "DELIVERED") result.delivered++;
    else if (finalStatus === "RETRY") result.retried++;
    else result.deadLettered++;
  }
  return result;
}
