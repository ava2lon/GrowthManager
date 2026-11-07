import {createHmac, timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

async function readBoundedBody(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return null;
  if (!request.body) return null;
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
  return Buffer.concat(chunks).toString("utf8");
}

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || header.length > 512) return false;
  const fields = new Map<string, string>();
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) return false;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if ((key !== "t" && key !== "s") || !value || fields.has(key)) return false;
    fields.set(key, value);
  }
  const timestamp = fields.get("t");
  const signature = fields.get("s");
  if (!timestamp || !signature || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(Date.now() / 1000) - seconds) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(timestamp + "." + rawBody, "utf8").digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

type TikTokWebhook = {
  client_key?: unknown;
  event?: unknown;
  create_time?: unknown;
  user_openid?: unknown;
  content?: unknown;
};

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({error: "unsupported_media_type"}, {status: 415});
  }
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    return NextResponse.json({error: "webhook_not_configured"}, {status: 503});
  }

  const rawBody = await readBoundedBody(request);
  if (rawBody === null) return NextResponse.json({error: "payload_too_large"}, {status: 413});
  if (!verifySignature(rawBody, request.headers.get("tiktok-signature"), clientSecret)) {
    return NextResponse.json({error: "invalid_signature"}, {status: 401});
  }

  let event: TikTokWebhook;
  try {
    event = JSON.parse(rawBody) as TikTokWebhook;
  } catch {
    return NextResponse.json({error: "invalid_json"}, {status: 400});
  }
  if (event.client_key !== clientKey || typeof event.event !== "string" ||
      typeof event.create_time !== "number" || !Number.isFinite(event.create_time)) {
    return NextResponse.json({error: "invalid_event"}, {status: 400});
  }

  // The documented Login Kit webhook event is an account deauthorization.
  // Content Posting API inbox upload status continues to use the status API poller.
  if (event.event === "authorization.removed") {
    if (typeof event.user_openid !== "string" || !event.user_openid || event.user_openid.length > 256) {
      return NextResponse.json({error: "invalid_user"}, {status: 400});
    }
    const accounts = await db.socialAccount.findMany({
      where: {provider: "TIKTOK", providerUserId: event.user_openid, status: {not: "DISCONNECTED"}},
      select: {id: true, workspaceId: true, status: true, credentialsEncrypted: true},
    });
    for (const account of accounts) {
      await db.$transaction(async (tx) => {
        const changed = await tx.socialAccount.updateMany({
          where: {
            id: account.id,
            workspaceId: account.workspaceId,
            provider: "TIKTOK",
            providerUserId: event.user_openid as string,
            status: account.status,
            credentialsEncrypted: account.credentialsEncrypted,
          },
          data: {
            status: "DISCONNECTED",
            credentialsEncrypted: null,
            scopes: [],
            tokenExpiresAt: null,
            lastValidatedAt: new Date(),
            lastErrorCode: "TIKTOK_AUTHORIZATION_REMOVED",
          },
        });
        if (changed.count === 1) {
          await tx.activityLog.create({
            data: {
              workspaceId: account.workspaceId,
              action: "social_account.authorization_removed",
              entityType: "SocialAccount",
              entityId: account.id,
              metadata: {provider: "TIKTOK", source: "SIGNED_WEBHOOK"},
            },
          });
        }
      });
    }
  }

  return NextResponse.json({received: true}, {status: 200});
}
