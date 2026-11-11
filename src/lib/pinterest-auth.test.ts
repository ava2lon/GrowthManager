import {afterEach,describe,expect,it,vi} from "vitest";

vi.mock("server-only",()=>({}));

import {pinterestApi} from "@/lib/pinterest-auth";

describe("pinterestApi network failures",()=>{
 afterEach(()=>vi.unstubAllGlobals());

 it("classifies network failures as retryable Pinterest errors",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new TypeError("fetch failed")));
  await expect(pinterestApi("token","/v5/user_account/analytics")).rejects.toThrow("PINTEREST_NETWORK_ERROR");
 });

 it("classifies request timeouts as retryable Pinterest errors",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new DOMException("The operation timed out","TimeoutError")));
  await expect(pinterestApi("token","/v5/user_account/analytics")).rejects.toThrow("PINTEREST_NETWORK_ERROR");
 });
});
