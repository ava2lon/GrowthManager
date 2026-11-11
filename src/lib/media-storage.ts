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
  if (input.sizeBytes > (isVideo ? MAX_VIDEO_BYTES : MAX_FILE_BYTES)) {
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

export function storageHeaders(serviceKey: string) {
  return {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`};
}

function encodeObjectPath(objectPath: string) {
  return objectPath.split("/").map(encodeURIComponent).join("/");
}

function assertStorageUrl(value: string, baseUrl: string, pathPrefix: string) {
  const url = new URL(value, baseUrl);
  if (url.origin !== baseUrl || !url.pathname.startsWith(pathPrefix)) {
    throw new Error("Storage returned an unsafe media URL.");
  }
  return url;
}

export interface MediaStorageProvider {
  readonly name: string;
  getBucket(): string;
  createUploadUrl(objectPath: string, mimeType: string): Promise<{uploadUrl: string; method: "PUT"; headers: Record<string,string>}>;
  verifyObject(input: {bucket: string; objectPath: string}): Promise<{sizeBytes: number; mimeType: string}>;
  createDownloadUrl(input: {bucket: string; objectPath: string; expiresInSeconds: number}): Promise<string>;
}

const supabaseProvider: MediaStorageProvider = {
  name: "SUPABASE",
  getBucket() {
    return getSupabaseStorageConfig().bucket;
  },
  async createUploadUrl(objectPath, mimeType) {
    const config = getSupabaseStorageConfig();
    const path = encodeObjectPath(objectPath);
    const endpoint = config.baseUrl + "/storage/v1/object/upload/sign/" + encodeURIComponent(config.bucket) + "/" + path;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {...storageHeaders(config.serviceKey), "Content-Type": "application/json"},
      body: JSON.stringify({upsert: false}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null) as {url?: string; signedURL?: string; signedUrl?: string; token?: string} | null;
    if (!response.ok || !payload) throw new Error("Signed upload URL could not be created.");
    const returnedUrl = payload.signedURL ?? payload.signedUrl ?? payload.url;
    let uploadUrl: URL;
    if (typeof payload.token === "string" && payload.token.length > 0) {
      uploadUrl = new URL("/storage/v1/object/upload/sign/" + encodeURIComponent(config.bucket) + "/" + path, config.baseUrl);
      uploadUrl.searchParams.set("token", payload.token);
    } else if (typeof returnedUrl === "string") {
      uploadUrl = assertStorageUrl(returnedUrl.startsWith("/object/") ? "/storage/v1" + returnedUrl : returnedUrl, config.baseUrl, "/storage/v1/object/upload/sign/");
    } else {
      throw new Error("Storage returned an invalid upload URL.");
    }
    if (uploadUrl.origin !== config.baseUrl || !uploadUrl.pathname.startsWith("/storage/v1/object/upload/sign/") || !uploadUrl.searchParams.has("token")) {
      throw new Error("Storage returned an unsafe upload URL.");
    }
    return {uploadUrl: uploadUrl.toString(), method: "PUT", headers: {"Content-Type": mimeType, "x-upsert": "false"}};
  },
  async verifyObject(input) {
    const config = getSupabaseStorageConfig();
    if (input.bucket !== config.bucket) throw new Error("Storage bucket configuration changed.");
    const endpoint = config.baseUrl + "/storage/v1/object/" + encodeURIComponent(input.bucket) + "/" + encodeObjectPath(input.objectPath);
    const response = await fetch(endpoint, {method:"HEAD",headers:storageHeaders(config.serviceKey),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error("The uploaded object could not be verified.");
    const sizeBytes = Number(response.headers.get("content-length"));
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !mimeType) throw new Error("Storage returned incomplete object metadata.");
    return {sizeBytes,mimeType};
  },
  async createDownloadUrl(input) {
    const config = getSupabaseStorageConfig();
    if (input.bucket !== config.bucket) throw new Error("Storage bucket configuration changed.");
    const endpoint = config.baseUrl + "/storage/v1/object/sign/" + encodeURIComponent(input.bucket) + "/" + encodeObjectPath(input.objectPath);
    const response = await fetch(endpoint, {method:"POST",headers:{...storageHeaders(config.serviceKey),"Content-Type":"application/json"},body:JSON.stringify({expiresIn:input.expiresInSeconds}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
    const payload = await response.json().catch(() => null) as {signedURL?:string;signedUrl?:string} | null;
    const signedPath = payload?.signedURL ?? payload?.signedUrl;
    if (!response.ok || typeof signedPath !== "string") throw new Error("Could not create a temporary media URL.");
    const normalized = signedPath.startsWith("/object/") ? "/storage/v1" + signedPath : signedPath;
    return assertStorageUrl(normalized,config.baseUrl,"/storage/v1/object/sign/").toString();
  },
};

// Implement this contract to add Vercel Blob, S3, or another private object store.
// The application persists provider + object key metadata, never expiring signed URLs.
export function getMediaStorageProvider(): MediaStorageProvider {
  const provider = process.env.MEDIA_STORAGE_PROVIDER || "SUPABASE";
  if (provider !== "SUPABASE") throw new Error("The configured media storage provider is not installed.");
  return supabaseProvider;
}
