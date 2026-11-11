import "server-only";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export function validateMediaUpload(input: {fileName: unknown; mimeType: unknown; sizeBytes: unknown}) {
  if (typeof input.fileName !== "string" || input.fileName.length < 1 || input.fileName.length > 255) {
    throw new Error("A valid filename is required.");
  }
  if (typeof input.mimeType !== "string" || !Object.hasOwn(MIME_EXTENSIONS, input.mimeType)) {
    throw new Error("Supported formats are JPEG, PNG, WebP, MP4, MOV, PDF, TXT, CSV, DOCX, XLSX and PPTX.");
  }
  if (typeof input.sizeBytes !== "number" || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new Error("A valid file size is required.");
  }
  const isVideo = input.mimeType.startsWith("video/");
  const isImage = input.mimeType.startsWith("image/");
  const maximum = isVideo ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
  if (input.sizeBytes > maximum) {
    throw new Error(isVideo ? "Videos must be 100 MB or smaller." : "Images and documents must be 20 MB or smaller.");
  }
  const safeName = input.fileName.replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
  if (!safeName) throw new Error("The filename is invalid.");
  return {safeName, extension: MIME_EXTENSIONS[input.mimeType], isVideo, isImage};
}

export function getSupabaseStorageConfig() {
  const rawUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceKey) throw new Error("Media storage is not configured.");
  const url = new URL(rawUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Media storage URL must be a project origin without credentials or a path.");
  }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "localhost")) {
    throw new Error("Media storage URL must use HTTPS.");
  }
  const bucket = process.env.SUPABASE_MEDIA_BUCKET || "growthmanager-media";
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(bucket)) throw new Error("Media storage bucket configuration is invalid.");
  return {baseUrl: url.origin, serviceKey, bucket};
}

export interface MediaStorageProvider {
  readonly name: string;
  getConfig(): ReturnType<typeof getSupabaseStorageConfig>;
}

// Storage operations use a provider boundary. Additional adapters (Vercel Blob,
// S3-compatible object stores) can implement this contract without changing the
// media metadata model or the application-facing upload/download routes.
const supabaseProvider: MediaStorageProvider = {
  name: "SUPABASE",
  getConfig: getSupabaseStorageConfig,
};

export function getMediaStorageProvider(): MediaStorageProvider {
  const provider = process.env.MEDIA_STORAGE_PROVIDER || "SUPABASE";
  if (provider !== "SUPABASE") throw new Error("The configured media storage provider is not installed.");
  return supabaseProvider;
}

export function storageHeaders(serviceKey: string) {
  return {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`};
}
