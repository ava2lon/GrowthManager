export function parseTikTokUploadedOffset(contentRange: string | null, totalBytes: number): number | null {
  if (!contentRange || !Number.isSafeInteger(totalBytes) || totalBytes < 1) return null;

  const match = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(contentRange.trim());
  if (!match) return null;

  const lastByte = Number(match[1]);
  const reportedTotal = Number(match[2]);

  if (!Number.isSafeInteger(lastByte) || reportedTotal !== totalBytes || lastByte < 0 || lastByte >= totalBytes) {
    return null;
  }

  return lastByte + 1;
}
