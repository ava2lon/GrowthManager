import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({
  claim:vi.fn(),
  complete:vi.fn(),
  fail:vi.fn(),
  record:vi.fn(),
  findTarget:vi.fn(),
  refreshMeta:vi.fn(),
  refreshLinkedIn:vi.fn(),
  refreshTikTokAccount:vi.fn(),
  refreshTikTokVideo:vi.fn(),
  refreshYouTubeChannel:vi.fn(),
  refreshYouTubeVideo:vi.fn(),
  refreshPinterestAccount:vi.fn(),
  refreshPinterestPin:vi.fn(),
  refreshX:vi.fn(),
}));

vi.mock("server-only",()=>({}));
vi.mock("@/lib/db",()=>({db:{socialPostTarget:{findFirst:mocks.findTarget}}}));
vi.mock("@/lib/social-analytics-retry-ledger",()=>({
  claimDueSocialAnalyticsRetry:mocks.claim,
  completeSocialAnalyticsRetry:mocks.complete,
  failClaimedSocialAnalyticsRetry:mocks.fail,
  recordSocialAnalyticsRetryFailure:mocks.record,
}));
vi.mock("@/lib/meta-analytics",()=>({refreshMetaAnalytics:mocks.refreshMeta}));
vi.mock("@/lib/linkedin-analytics",()=>({refreshLinkedInAnalytics:mocks.refreshLinkedIn}));
vi.mock("@/lib/tiktok-analytics",()=>({
  refreshTikTokAccountAnalytics:mocks.refreshTikTokAccount,
  refreshTikTokVideoAnalytics:mocks.refreshTikTokVideo,
}));
vi.mock("@/lib/youtube-analytics",()=>({
  refreshYouTubeChannelAnalytics:mocks.refreshYouTubeChannel,
  refreshYouTubeVideoAnalytics:mocks.refreshYouTubeVideo,
}));
vi.mock("@/lib/pinterest-analytics",()=>({refreshPinterestAccountAnalytics:mocks.refreshPinterestAccount}));
vi.mock("@/lib/pinterest-pin-analytics",()=>({refreshPinterestPinAnalytics:mocks.refreshPinterestPin}));
vi.mock("@/lib/x-analytics",()=>({refreshXAnalytics:mocks.refreshX}));

import {processOneDueSocialAnalyticsRetry,runWithSocialAnalyticsRetryLedger} from "./social-analytics-retry-worker";

const lockedAt=new Date("2026-11-09T00:00:00.000Z");
const reportDate=new Date("2026-11-08T00:00:00.000Z");
const baseRetry={
  id:"retry_1",
  workspaceId:"workspace_a",
  provider:"FACEBOOK",
  subjectType:"ACCOUNT",
  subjectId:"account_a",
  reportDate,
  lockedAt,
};

describe("social analytics retry worker",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue(baseRetry);
    mocks.complete.mockResolvedValue(true);
    mocks.fail.mockResolvedValue(true);
    mocks.record.mockResolvedValue({});
    mocks.findTarget.mockResolvedValue({id:"target_a",socialAccountId:"account_a"});
    for(const key of [
      "refreshMeta","refreshLinkedIn","refreshTikTokAccount","refreshTikTokVideo",
      "refreshYouTubeChannel","refreshYouTubeVideo","refreshPinterestAccount",
      "refreshPinterestPin","refreshX",
    ] as const) mocks[key].mockResolvedValue({});
  });

  it("does nothing when no retry is due",async()=>{
    mocks.claim.mockResolvedValue(null);
    await expect(processOneDueSocialAnalyticsRetry()).resolves.toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["FACEBOOK","ACCOUNT","refreshMeta"],
    ["INSTAGRAM","ACCOUNT","refreshMeta"],
    ["LINKEDIN","ACCOUNT","refreshLinkedIn"],
    ["TIKTOK","ACCOUNT","refreshTikTokAccount"],
    ["YOUTUBE","CHANNEL","refreshYouTubeChannel"],
    ["X","ACCOUNT","refreshX"],
    ["PINTEREST","ACCOUNT","refreshPinterestAccount"],
  ] as const)("dispatches account retry %s/%s to its provider adapter",async(provider,subjectType,adapter)=>{
    mocks.claim.mockResolvedValue({...baseRetry,provider,subjectType});
    await expect(processOneDueSocialAnalyticsRetry()).resolves.toBe(true);
    expect(mocks[adapter]).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId:"workspace_a",
      accountId:"account_a",
      asOf:new Date(reportDate.getTime()+86_399_999),
    }));
    expect(mocks.complete).toHaveBeenCalledWith("retry_1",lockedAt);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it.each([
    ["FACEBOOK","MEDIA","refreshMeta"],
    ["LINKEDIN","MEDIA","refreshLinkedIn"],
    ["TIKTOK","VIDEO","refreshTikTokVideo"],
    ["YOUTUBE","VIDEO","refreshYouTubeVideo"],
    ["X","POST","refreshX"],
    ["PINTEREST","PIN","refreshPinterestPin"],
  ] as const)("resolves target retry %s/%s inside the stored workspace",async(provider,subjectType,adapter)=>{
    mocks.claim.mockResolvedValue({...baseRetry,provider,subjectType,subjectId:"target_a"});
    await expect(processOneDueSocialAnalyticsRetry()).resolves.toBe(true);
    expect(mocks.findTarget).toHaveBeenCalledWith(expect.objectContaining({
      where:expect.objectContaining({id:"target_a",workspaceId:"workspace_a",status:"PUBLISHED"}),
    }));
    expect(mocks[adapter]).toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith("retry_1",lockedAt);
  });

  it("records retry failure against the original claim and workspace",async()=>{
    mocks.refreshMeta.mockRejectedValue(new Error("META_RATE_LIMITED"));
    await expect(processOneDueSocialAnalyticsRetry()).resolves.toBe(true);
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      id:"retry_1",
      lockedAt,
      workspaceId:"workspace_a",
      provider:"FACEBOOK",
      subjectId:"account_a",
      errorCode:"META_RATE_LIMITED",
    }));
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("records normal collection failures before rethrowing",async()=>{
    const identity={workspaceId:"workspace_a",provider:"X",subjectType:"ACCOUNT",subjectId:"account_a",reportDate};
    await expect(runWithSocialAnalyticsRetryLedger(identity,async()=>{throw new Error("X_RATE_LIMITED");}))
      .rejects.toThrow("X_RATE_LIMITED");
    expect(mocks.record).toHaveBeenCalledWith({...identity,errorCode:"X_RATE_LIMITED"});
  });
});
