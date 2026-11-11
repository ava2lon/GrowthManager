import {describe,it,expect} from "vitest";
import {normalizeWebsiteDomain,trackingEventSchema,validateMetadataDepth,isSafeTrackingId} from "./validation";
describe("website tracking validation",()=>{
 it("normalizes full URLs, www and paths",()=>{expect(normalizeWebsiteDomain("https://www.Example.com/path?q=1")).toBe("example.com");expect(normalizeWebsiteDomain("example.com/")).toBe("example.com");});
 it("rejects local, IP and custom-port hosts",()=>{expect(()=>normalizeWebsiteDomain("localhost:3000")).toThrow();expect(()=>normalizeWebsiteDomain("127.0.0.1")).toThrow();expect(()=>normalizeWebsiteDomain("https://example.com:8443")).toThrow();});
 it("requires bounded pseudonymous IDs",()=>{const base={event:"page_view",anonymous_id:"anon_1234567890123456",session_id:"sess_1234567890123456"};expect(trackingEventSchema.safeParse(base).success).toBe(true);expect(trackingEventSchema.safeParse({...base,anonymous_id:"customer@example.com"}).success).toBe(false);});
 it("rejects sensitive metadata keys",()=>{expect(validateMetadataDepth({form_id:"contact"})).toEqual({form_id:"contact"});expect(validateMetadataDepth({password:"secret"})).toBeNull();});
 it("accepts only public tracking identifiers",()=>{expect(isSafeTrackingId("site_1234567890123456")).toBe(true);expect(isSafeTrackingId("site_1")).toBe(false);});
});
