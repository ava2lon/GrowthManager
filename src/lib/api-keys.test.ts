import {describe,expect,it} from "vitest";
import {API_KEY_SCOPES,hashApiKey,isApiKeyScope} from "@/lib/api-keys";

describe("workspace API key primitives",()=>{
  it("hashes secrets deterministically without exposing the raw value",()=>{
    const key="gm_live_0123456789ab_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const first=hashApiKey(key);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey(key)).toBe(first);
    expect(first).not.toContain(key);
    expect(hashApiKey(key+"x")).not.toBe(first);
  });

  it("accepts only explicitly supported scopes",()=>{
    expect(API_KEY_SCOPES.length).toBeGreaterThan(0);
    for(const scope of API_KEY_SCOPES)expect(isApiKeyScope(scope)).toBe(true);
    expect(isApiKeyScope("*")).toBe(false);
    expect(isApiKeyScope("websites:admin")).toBe(false);
  });
});
