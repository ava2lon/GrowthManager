import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {verifyResendWebhookSignature} from "@/lib/resend-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;
const EVENT_STATUS: Record<string, string> = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
  "email.delivery_delayed": "DELAYED",
  "email.failed": "FAILED",
};

type ResendEvent = {
  type?: unknown;
  created_at?: unknown;
  data?: {email_id?: unknown};
};

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

function webhookHeaders(request: Request) {
  return {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  };
}

async function updateContentReviewDelivery(input: {
  emailId: string;
  eventType: string;
  providerEventId: string;
  rawBody: string;
  headers: ReturnType<typeof webhookHeaders>;
  occurredAt: Date;
}) {
  const delivery = await db.contentReviewEmailDelivery.findFirst({
    where: {providerMessageId: input.emailId},
    select: {id: true, workspaceId: true},
  });
  if (!delivery) return null;

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret || !verifyResendWebhookSignature(input.rawBody, input.headers, secret)) {
    return NextResponse.json({error: "Unauthorized"}, {status: 401});
  }

  const result = await db.$transaction(async (tx) => {
    const inserted = await tx.contentReviewEmailWebhookEvent.createMany({
      data: [{
        deliveryId: delivery.id,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return {duplicate: true, updated: false};

    const changed = await tx.contentReviewEmailDelivery.updateMany({
      where: {
        id: delivery.id,
        workspaceId: delivery.workspaceId,
        OR: [{lastProviderEventAt: null}, {lastProviderEventAt: {lt: input.occurredAt}}],
      },
      data: {status: EVENT_STATUS[input.eventType], lastProviderEventAt: input.occurredAt},
    });
    return {duplicate: false, updated: changed.count === 1};
  });

  return NextResponse.json({received: true, duplicate: result.duplicate, updated: result.updated});
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({error: "Unsupported content type"}, {status: 415});
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({error: "Payload too large"}, {status: 413});
  }

  const rawBody = await readBoundedBody(request);
  if (rawBody === null) return NextResponse.json({error: "Payload too large"}, {status: 413});

  let payload: ResendEvent;
  try {
    payload = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return NextResponse.json({error: "Invalid payload"}, {status: 400});
  }

  if (typeof payload.type !== "string" || typeof payload.data?.email_id !== "string" ||
      payload.data.email_id.length < 1 || payload.data.email_id.length > 200) {
    return NextResponse.json({error: "Invalid event"}, {status: 400});
  }

  const nextStatus = EVENT_STATUS[payload.type];
  if (!nextStatus) return NextResponse.json({received: true, ignored: true});

  const headers = webhookHeaders(request);
  const providerEventId = headers.id ?? "";
  if (!providerEventId || !headers.timestamp || !headers.signature) {
    return NextResponse.json({error: "Unauthorized"}, {status: 401});
  }

  const occurredAt = typeof payload.created_at === "string" ? new Date(payload.created_at) : new Date(NaN);
  if (!Number.isFinite(occurredAt.getTime())) {
    return NextResponse.json({error: "Invalid event timestamp"}, {status: 400});
  }

  const reviewResult = await updateContentReviewDelivery({
    emailId: payload.data.email_id,
    eventType: payload.type,
    providerEventId,
    rawBody,
    headers,
    occurredAt,
  });
  if (reviewResult) return reviewResult;

  const delivery = await db.automationAlertDelivery.findFirst({
    where: {providerMessageId: payload.data.email_id, channel: "EMAIL"},
    select: {
      id: true,
      workspaceId: true,
      integrationId: true,
      integration: {select: {credentialsEncrypted: true, status: true, provider: true}},
    },
  });
  // Unknown provider IDs are acknowledged to avoid infinite retries and do not reveal tenant data.
  if (!delivery) return NextResponse.json({received: true, matched: false});
  if (delivery.integration.provider !== "resend" || delivery.integration.status !== "CONNECTED" ||
      !delivery.integration.credentialsEncrypted) {
    return NextResponse.json({error: "Webhook configuration unavailable"}, {status: 503});
  }

  let webhookSecret: string;
  try {
    const credentials = decryptIntegrationCredentials(
      delivery.integration.credentialsEncrypted,
      delivery.workspaceId,
      delivery.integrationId,
    );
    if (typeof credentials.webhookSecret !== "string") {
      return NextResponse.json({error: "Webhook signing secret not configured"}, {status: 503});
    }
    webhookSecret = credentials.webhookSecret;
  } catch {
    return NextResponse.json({error: "Webhook configuration unavailable"}, {status: 503});
  }

  if (!verifyResendWebhookSignature(rawBody, headers, webhookSecret)) {
    return NextResponse.json({error: "Unauthorized"}, {status: 401});
  }

  const result = await db.$transaction(async (tx) => {
    const inserted = await tx.resendWebhookEvent.createMany({
      data: [{
        workspaceId: delivery.workspaceId,
        integrationId: delivery.integrationId,
        providerEventId,
        eventType: payload.type as string,
        processedAt: new Date(),
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return {duplicate: true, updated: false};

    const changed = await tx.automationAlertDelivery.updateMany({
      where: {
        id: delivery.id,
        workspaceId: delivery.workspaceId,
        OR: [{lastProviderEventAt: null}, {lastProviderEventAt: {lt: occurredAt}}],
      },
      data: {status: nextStatus, lastProviderEventAt: occurredAt},
    });
    return {duplicate: false, updated: changed.count === 1};
  });

  return NextResponse.json({received: true, duplicate: result.duplicate, updated: result.updated});
}
