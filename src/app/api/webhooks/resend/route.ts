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

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({error: "Payload too large"}, {status: 413});
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({error: "Payload too large"}, {status: 413});
  }

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

  const providerEventId = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!providerEventId || !timestamp || !signature) {
    return NextResponse.json({error: "Unauthorized"}, {status: 401});
  }

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

  if (!verifyResendWebhookSignature(rawBody, {id: providerEventId, timestamp, signature}, webhookSecret)) {
    return NextResponse.json({error: "Unauthorized"}, {status: 401});
  }

  const occurredAt = typeof payload.created_at === "string" ? new Date(payload.created_at) : new Date(NaN);
  if (!Number.isFinite(occurredAt.getTime())) {
    return NextResponse.json({error: "Invalid event timestamp"}, {status: 400});
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
