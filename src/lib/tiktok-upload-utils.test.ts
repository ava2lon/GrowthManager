import {describe,expect,it} from "vitest";
import {parseTikTokUploadedOffset} from "@/lib/tiktok-upload-utils";

describe("TikTok uploaded byte-range reconciliation",()=>{
 it("converts an inclusive provider range into the next byte offset",()=>{
  expect(parseTikTokUploadedOffset("bytes 0-9999999/50000123",50000123)).toBe(10000000);
 });
 it("rejects malformed ranges and mismatched totals",()=>{
  expect(parseTikTokUploadedOffset(null,100)).toBeNull();
  expect(parseTikTokUploadedOffset("bytes 5-10/100",100)).toBeNull();
  expect(parseTikTokUploadedOffset("bytes 0-10/101",100)).toBeNull();
  expect(parseTikTokUploadedOffset("bytes 0-100/100",100)).toBeNull();
 });
});
