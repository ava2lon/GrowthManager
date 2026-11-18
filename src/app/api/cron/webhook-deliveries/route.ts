import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {dispatchWorkspaceWebhookDeliveries} from "@/lib/webhook-delivery-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  try {
    const result = await dispatchWorkspaceWebhookDeliveries(10);
    return NextResponse.json(result, {headers: {"Cache-Control": "no-store"}});
  } catch {
    return NextResponse.json({error: "Webhook delivery worker failed."}, {status: 500, headers: {"Cache-Control": "no-store"}});
  }
}
