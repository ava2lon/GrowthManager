import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedPlatforms = new Set(["INSTAGRAM", "FACEBOOK", "LINKEDIN", "X", "TIKTOK", "YOUTUBE", "PINTEREST"]);
const textField = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

function markdownFromStrategy(value: Record<string, unknown>) {
  const lines: string[] = [];
  const add = (heading: string, content: unknown) => {
    lines.push("## " + heading);
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object") lines.push("- " + Object.entries(item as Record<string, unknown>).map(([k,v]) => k + ": " + String(v ?? "")).join(" | "));
        else lines.push("- " + String(item));
      }
    } else if (typeof content === "string") lines.push(content);
    lines.push("");
  };
  add("Strategic summary", value.strategySummary);
  add("Content pillars", value.pillars);
  add("Two-week content calendar", value.calendar);
  add("Platform variations", value.platformVariants);
  add("Testing plan", value.tests);
  add("Risks and assumptions", value.risks);
  return lines.join("\n").slice(0, 40_000);
}

export async function POST(request: Request) {
  const context = await requireWorkspaceRole("MEMBER");
  const limit = await consumeRateLimit("ai-strategist:" + context.workspace.id + ":" + context.userId, 10, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    return NextResponse.json({error: "AI generation limit reached or request protection is unavailable."}, {status: 429, headers: {"Retry-After": String(limit.retryAfter)}});
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) {
    return NextResponse.json({error: "AI provider is not configured. Add OPENAI_API_KEY and OPENAI_MODEL to the server environment."}, {status: 503});
  }

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({error: "Invalid JSON request."}, {status: 400});
  }

  const brandId = textField(input.brandId, 128);
  const campaignId = textField(input.campaignId, 128);
  const objective = textField(input.objective, 240);
  const audience = textField(input.audience, 1000);
  const offer = textField(input.offer, 1000);
  const tone = textField(input.tone, 240);
  const platforms = Array.isArray(input.platforms) ? [...new Set(input.platforms.filter((item): item is string => typeof item === "string" && allowedPlatforms.has(item)))].slice(0, 7) : [];

  if (!brandId || !objective) return NextResponse.json({error: "Select a brand and provide a primary objective."}, {status: 400});

  const brand = await db.brand.findFirst({
    where: {id: brandId, workspaceId: context.workspace.id, status: "ACTIVE"},
    select: {id: true, name: true, description: true, websiteUrl: true},
  });
  if (!brand) return NextResponse.json({error: "Selected brand is unavailable in this workspace."}, {status: 404});

  const campaign = campaignId ? await db.campaign.findFirst({
    where: {id: campaignId, workspaceId: context.workspace.id, OR: [{brandId: brand.id}, {brandId: null}]},
    select: {id: true, name: true, objective: true},
  }) : null;
  if (campaignId && !campaign) return NextResponse.json({error: "Selected campaign is unavailable for this brand."}, {status: 404});

  const connectedAccounts = await db.socialAccount.findMany({
    where: {workspaceId: context.workspace.id, brandId: brand.id, status: "CONNECTED"},
    select: {provider: true, accountName: true},
    take: 50,
  });
  const selectedPlatforms = platforms.length ? platforms : [...new Set(connectedAccounts.map(account => account.provider))];

  const systemPrompt = [
    "You are a senior, evidence-conscious growth marketing strategist.",
    "Return ONLY valid JSON with keys: strategySummary (string), pillars (array of objects), calendar (array of objects), platformVariants (array of objects), tests (array of objects), risks (array of strings).",
    "Calendar must contain a practical two-week plan with relative day, format, hook, CTA and objective. Platform variants must include platform and copy fields.",
    "Never invent product facts, customer proof, performance data, platform capabilities or dates. Mark assumptions and missing inputs. Avoid generic filler and unsupported claims.",
    "Distinguish organic from paid recommendations. Do not claim content was published, scheduled or approved.",
  ].join(" ");

  const userPrompt = JSON.stringify({
    workspace: context.workspace.name,
    brand,
    campaign: campaign ?? {name: "Standalone initiative", objective},
    primaryObjective: objective,
    targetAudience: audience || "Not specified; state assumptions.",
    offerOrMessage: offer || "Not specified; do not fabricate.",
    brandVoice: tone || "Clear, useful, confident",
    targetPlatforms: selectedPlatforms,
    connectedAccounts: connectedAccounts.map(account => ({provider: account.provider, accountName: account.accountName})),
    requiredSections: ["strategic angle and measurable KPIs", "three content pillars", "two-week publishing plan", "platform-native copy variations", "creative direction and accessibility guidance", "test hypotheses and decision rules", "risks, missing inputs and assumptions"],
  });

  let generated: Record<string, unknown>;
  try {
    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {"Authorization": "Bearer " + apiKey, "Content-Type": "application/json"},
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: {type: "json_object"},
        messages: [{role: "system", content: systemPrompt}, {role: "user", content: userPrompt}],
      }),
      signal: AbortSignal.timeout(50_000),
      cache: "no-store",
    });
    if (!response.ok) {
      const status = response.status;
      return NextResponse.json({error: status === 429 ? "AI provider rate limit reached. Retry later." : status === 401 || status === 403 ? "AI provider credentials were rejected." : "AI provider request failed."}, {status: status === 429 ? 429 : 502});
    }
    const payload = await response.json() as {choices?: Array<{message?: {content?: string}}>};
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("EMPTY_AI_RESPONSE");
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_AI_JSON");
    generated = parsed as Record<string, unknown>;
    for (const key of ["strategySummary", "pillars", "calendar", "platformVariants", "tests", "risks"]) {
      if (!(key in generated)) throw new Error("MISSING_AI_SECTION");
    }
  } catch (error) {
    const code = error instanceof Error && error.name === "TimeoutError" ? "AI_TIMEOUT" : "AI_GENERATION_FAILED";
    return NextResponse.json({error: code === "AI_TIMEOUT" ? "AI generation timed out. Retry with a shorter brief." : "Could not generate a valid strategy. Please retry."}, {status: 502});
  }

  const body = markdownFromStrategy(generated);
  const title = (brand.name + " — " + objective).slice(0, 240);
  const saved = await db.$transaction(async tx => {
    const post = await tx.contentPost.create({
      data: {workspaceId: context.workspace.id, brandId: brand.id, title, body, status: "DRAFT"},
      select: {id: true, title: true, createdAt: true},
    });
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "ai.content_strategy_generated",
        entityType: "content_post",
        entityId: post.id,
        metadata: {brandId: brand.id, campaignId: campaign?.id ?? null, model, platforms: selectedPlatforms, savedAs: "DRAFT"},
      },
    });
    return post;
  });

  return NextResponse.json({generation: generated, draft: saved, platformSelection: selectedPlatforms});
}
