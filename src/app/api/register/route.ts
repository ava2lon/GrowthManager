import {NextResponse} from "next/server";
import {hash} from "bcryptjs";
import {z} from "zod";
import {db} from "@/lib/db";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
  rateLimitUnavailableResponse,
} from "@/lib/rate-limit";

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email(),
  password: z.string().min(12).max(128),
  workspaceName: z.string().trim().min(2).max(80),
});

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export async function POST(req: Request) {
  const limit = await consumeRateLimit(
    `register:ip:${getClientIp(req)}`,
    5,
    60 * 60,
  );

  if (limit.unavailable || (!limit.configured && process.env.NODE_ENV === "production")) {
    return rateLimitUnavailableResponse();
  }
  if (!limit.allowed) {
    return limit.configured
      ? rateLimitResponse(limit.retryAfter)
      : rateLimitUnavailableResponse();
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {error: "Check the submitted fields. Passwords must be at least 12 characters."},
      {status: 400},
    );
  }

  const email = parsed.data.email.toLowerCase().trim();

  try {
    const existingUser = await db.user.findUnique({
      where: {email},
      select: {id: true},
    });

    if (existingUser) {
      return NextResponse.json(
        {error: "An account with this email already exists."},
        {status: 409},
      );
    }

    const slug =
      (slugify(parsed.data.workspaceName) || "workspace") +
      "-" +
      crypto.randomUUID().slice(0, 8);
    const passwordHash = await hash(parsed.data.password, 12);

    await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {name: parsed.data.name, email, passwordHash},
      });
      const workspace = await tx.workspace.create({
        data: {name: parsed.data.workspaceName, slug},
      });
      await tx.workspaceMembership.create({
        data: {userId: user.id, workspaceId: workspace.id, role: "OWNER"},
      });
      await tx.activityLog.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          action: "workspace.created",
          entityType: "workspace",
        },
      });
    });

    return NextResponse.json({ok: true}, {status: 201});
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        {error: "An account with this email already exists."},
        {status: 409},
      );
    }

    console.error("Account registration failed.", error);
    return NextResponse.json(
      {error: "Registration is temporarily unavailable. Please try again."},
      {status: 503},
    );
  }
}
