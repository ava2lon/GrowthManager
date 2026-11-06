import "server-only";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function validateMediaUpload(input: {fileName: unknown; mimeType: unknown; sizeBytes: unknown}) {
  if (typeof input.fileName !== "string" || input.fileName.length < 1 || input.fileName.length > 255) {
    throw new Error("A valid filename is required.");
  }
  if (typeof input.mimeType !== "string" || !(input.mimeType in MIME_EXTENSIONS)) {
    throw new Error("Supported formats are JPEG, PNG, WebP, MP4, and MOV.");
  }
  if (typeof input.sizeBytes !== "number" || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new Error("A valid file size is required.");
  }
  const isVideo = input.mimeType.startsWith("video/");
  const maximum = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (input.sizeBytes > maximum) {
    throw new Error(isVideo ? "Videos must be 100 MB or smaller." : "Images must be 20 MB or smaller.");
  }
  const safeName = input.fileName.replace(/[^\\p{L}\\p{N}._ -]/gu, "_").trim();
  if (!safeName) throw new Error("The filename is invalid.");
  return {safeName, extension: MIME_EXTENSIONS[input.mimeType], isVideo};
}

export function getSupabaseStorageConfig() {
  const rawUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceKey) throw new Error("Media storage is not configured.");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "localhost")) {
    throw new Error("Media storage URL must use HTTPS.");
  }
  const bucket = process.env.SUPABASE_MEDIA_BUCKET || "growthmanager-media";
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(bucket)) throw new Error("Media storage bucket configuration is invalid.");
  return {baseUrl: url.origin, serviceKey, bucket};
}

export function storageHeaders(serviceKey: string) {
  return {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`};
}
