import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {dispatchContentReviewEmails} from "@/lib/content-review-email-delivery";

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
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    return NextResponse.json({error: "Email delivery is not configured"}, {status: 503});
  }
  try {
    const delivery = await dispatchContentReviewEmails(10);
    return NextResponse.json(delivery);
  } catch {
    return NextResponse.json({error: "Content review email dispatch failed"}, {status: 500});
  }
}
