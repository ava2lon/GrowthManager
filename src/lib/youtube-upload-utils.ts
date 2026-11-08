export type YouTubeVideoMetadata = {
  title: string;
  description: string;
  privacyStatus: "private" | "unlisted" | "public";
  categoryId?: string;
  tags?: string[];
  publishAt?: string;
};

const ALLOWED_SESSION_HOSTS = new Set(["www.googleapis.com", "youtube.googleapis.com"]);

export function validateYouTubeMetadata(value: unknown, fallbackTitle: string): YouTubeVideoMetadata {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const title = typeof raw.title === "string" ? raw.title.trim() : fallbackTitle;
  const description = typeof raw.description === "string" ? raw.description : "";
  const privacy = raw.privacyStatus;
  if (!title || title.length > 100 || description.length > 5000) {
    throw new Error("YOUTUBE_METADATA_INVALID");
  }
  const privacyStatus = privacy === "unlisted" || privacy === "public" ? privacy : "private";
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((item): item is string => typeof item === "string")
      .map(item => item.trim()).filter(Boolean).slice(0, 20) : [];
  if (tags.some(tag => tag.length > 30) || tags.join(",").length > 500) {
    throw new Error("YOUTUBE_TAGS_INVALID");
  }
  let publishAt: string | undefined;
  if (raw.publishAt !== undefined && raw.publishAt !== null && raw.publishAt !== "") {
    if (typeof raw.publishAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.publishAt)) {
      throw new Error("YOUTUBE_SCHEDULE_TIME_INVALID");
    }
    const scheduled = new Date(raw.publishAt);
    if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now() + 15 * 60_000) {
      throw new Error("YOUTUBE_SCHEDULE_MUST_BE_15_MINUTES_AHEAD");
    }
    if (privacyStatus !== "private") throw new Error("YOUTUBE_SCHEDULE_REQUIRES_PRIVATE");
    publishAt = scheduled.toISOString();
  }
  const categoryId = typeof raw.categoryId === "string" && /^\d{1,3}$/.test(raw.categoryId)
    ? raw.categoryId : undefined;
  return {title, description, privacyStatus, ...(categoryId ? {categoryId} : {}), ...(tags.length ? {tags} : {}), ...(publishAt ? {publishAt} : {})};
}

export function validateYouTubeSessionUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("YOUTUBE_UPLOAD_SESSION_INVALID"); }
  if (url.protocol !== "https:" || !ALLOWED_SESSION_HOSTS.has(url.hostname) ||
      !url.pathname.startsWith("/upload/youtube/v3/videos") || url.username || url.password ||
      url.hash || url.search.length > 4096) {
    throw new Error("YOUTUBE_UPLOAD_SESSION_INVALID");
  }
  return url;
}

export function parseYouTubeCommittedOffset(range: string | null, totalBytes: number): number {
  if (range === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  if (!match) throw new Error("YOUTUBE_UPLOAD_RANGE_INVALID");
  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) {
    throw new Error("YOUTUBE_UPLOAD_RANGE_INVALID");
  }
  return offset;
}

export function isYouTubeRetryableTransportError(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}
