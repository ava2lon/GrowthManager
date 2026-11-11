import {describe,expect,it,vi} from "vitest";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/db",()=>({db:{}}));
vi.mock("@/lib/pinterest-auth",()=>({getPinterestCredentials:vi.fn(),pinterestApi:vi.fn()}));

import {isPinterestAnalyticsDate} from "@/lib/pinterest-analytics";

describe("isPinterestAnalyticsDate",()=>{
 it("accepts ISO calendar date strings",()=>{
  expect(isPinterestAnalyticsDate("2026-11-11")).toBe(true);
 });
 it.each([undefined,null,20261111,"2026/11/11","2026-1-11","\\\\2026-11-11","not-a-date"])("rejects invalid date values: %s",(value)=>{
  expect(isPinterestAnalyticsDate(value)).toBe(false);
 });
});
