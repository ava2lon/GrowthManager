import {describe, expect, it} from "vitest";
import {
  parseYouTubeCommittedOffset,
  validateYouTubeMetadata,
  validateYouTubeSessionUrl,
} from "./youtube-upload-utils";

describe("YouTube upload metadata", () => {
  it("defaults privacy to private and preserves supported metadata", () => {
    expect(validateYouTubeMetadata({
      title: "  Product demo  ", description: "Description",
      categoryId: "22", tags: ["demo", "launch"],
    }, "Fallback")).toEqual({
      title: "Product demo", description: "Description", privacyStatus: "private",
      categoryId: "22", tags: ["demo", "launch"],
    });
  });

  it("uses the fallback title and rejects invalid title or description lengths", () => {
    expect(validateYouTubeMetadata({}, "Fallback title").title).toBe("Fallback title");
    expect(() => validateYouTubeMetadata({title: "x".repeat(101)}, "Fallback")).toThrow("YOUTUBE_METADATA_INVALID");
    expect(() => validateYouTubeMetadata({title: "valid", description: "x".repeat(5001)}, "Fallback"))
      .toThrow("YOUTUBE_METADATA_INVALID");
  });

  it("accepts a future UTC schedule only with private privacy", () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(validateYouTubeMetadata({title: "Scheduled", privacyStatus: "private", publishAt: future}, "Fallback").publishAt).toBe(future);
    expect(() => validateYouTubeMetadata({title: "Scheduled", privacyStatus: "public", publishAt: future}, "Fallback"))
      .toThrow("YOUTUBE_SCHEDULE_REQUIRES_PRIVATE");
    expect(() => validateYouTubeMetadata({title: "Scheduled", publishAt: "2026-11-07T12:00"}, "Fallback"))
      .toThrow("YOUTUBE_SCHEDULE_TIME_INVALID");
    expect(() => validateYouTubeMetadata({title: "Scheduled", publishAt: new Date(Date.now() + 60_000).toISOString()}, "Fallback"))
      .toThrow("YOUTUBE_SCHEDULE_MUST_BE_15_MINUTES_AHEAD");
  });

  it("rejects oversized tags", () => {
    expect(() => validateYouTubeMetadata({title: "valid", tags: ["x".repeat(31)]}, "Fallback"))
      .toThrow("YOUTUBE_TAGS_INVALID");
  });
});

describe("YouTube resumable upload session URL", () => {
  it("accepts a secure Google upload session URL", () => {
    expect(validateYouTubeSessionUrl("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=opaque").hostname)
      .toBe("www.googleapis.com");
  });

  it("rejects non-Google hosts, insecure URLs and credential-bearing URLs", () => {
    expect(() => validateYouTubeSessionUrl("https://attacker.example/upload/youtube/v3/videos?id=x"))
      .toThrow("YOUTUBE_UPLOAD_SESSION_INVALID");
    expect(() => validateYouTubeSessionUrl("http://www.googleapis.com/upload/youtube/v3/videos?id=x"))
      .toThrow("YOUTUBE_UPLOAD_SESSION_INVALID");
    expect(() => validateYouTubeSessionUrl("https://user:pass@www.googleapis.com/upload/youtube/v3/videos?id=x"))
      .toThrow("YOUTUBE_UPLOAD_SESSION_INVALID");
  });
});

describe("YouTube committed byte range", () => {
  it("treats a missing range as zero bytes committed", () => {
    expect(parseYouTubeCommittedOffset(null, 1024)).toBe(0);
  });

  it("converts the inclusive provider range to the next byte offset", () => {
    expect(parseYouTubeCommittedOffset("bytes=0-1048575", 2 * 1024 * 1024)).toBe(1048576);
  });

  it("rejects malformed and out-of-bounds ranges", () => {
    expect(() => parseYouTubeCommittedOffset("bytes=5-9", 100)).toThrow("YOUTUBE_UPLOAD_RANGE_INVALID");
    expect(() => parseYouTubeCommittedOffset("bytes=0-100", 100)).toThrow("YOUTUBE_UPLOAD_RANGE_INVALID");
  });
});
