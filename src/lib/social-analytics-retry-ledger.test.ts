import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({
  transaction:vi.fn(),
  findUnique:vi.fn(),
  upsert:vi.fn(),
  findFirst:vi.fn(),
  updateMany:vi.fn(),
}));

vi.mock("@/lib/db",()=>({
  db:{
    $transaction:mocks.transaction,
    socialAnalyticsRetry:{
      findFirst:mocks.findFirst,
      updateMany:mocks.updateMany,
    },
  },
}));

import {Prisma} from "@prisma/client";
import {
  claimDueSocialAnalyticsRetry,
  recordSocialAnalyticsRetryFailure,
} from "./social-analytics-retry-ledger";

const identity={
  workspaceId:"workspace_a",
  provider:"X",
  subjectType:"ACCOUNT",
  subjectId:"account_a",
  reportDate:new Date("2026-11-09T00:00:00.000Z"),
};

describe("social analytics retry ledger concurrency",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({id:"retry_a",attemptCount:1,status:"RETRY"});
    mocks.findFirst.mockResolvedValue(null);
    mocks.updateMany.mockResolvedValue({count:1});
    mocks.transaction.mockImplementation(async(callback,options)=>{
      expect(options).toEqual({isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
      return callback({socialAnalyticsRetry:{findUnique:mocks.findUnique,upsert:mocks.upsert}});
    });
  });

  it("records a retry under serializable isolation",async()=>{
    await expect(recordSocialAnalyticsRetryFailure({...identity,errorCode:"X_RATE_LIMITED"}))
      .resolves.toMatchObject({id:"retry_a",attemptCount:1});
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a retry currently owned by a worker",async()=>{
    mocks.findUnique.mockResolvedValue({id:"retry_a",attemptCount:2,status:"PROCESSING"});
    await expect(recordSocialAnalyticsRetryFailure({...identity,errorCode:"X_RATE_LIMITED"}))
      .resolves.toMatchObject({id:"retry_a",attemptCount:2,status:"PROCESSING"});
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("retries serialization conflicts without losing the increment",async()=>{
    mocks.transaction
      .mockRejectedValueOnce({code:"P2034"})
      .mockImplementationOnce(async(callback,options)=>{
        expect(options).toEqual({isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
        return callback({socialAnalyticsRetry:{findUnique:mocks.findUnique,upsert:mocks.upsert}});
      });

    await expect(recordSocialAnalyticsRetryFailure({...identity,errorCode:"X_RATE_LIMITED"}))
      .resolves.toMatchObject({id:"retry_a",attemptCount:1});
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-conflict database failures",async()=>{
    mocks.transaction.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recordSocialAnalyticsRetryFailure({...identity,errorCode:"X_RATE_LIMITED"}))
      .rejects.toThrow("database unavailable");
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("reclaims an expired PROCESSING lease with a compare-and-set update",async()=>{
    const now=new Date("2026-11-11T12:00:00.000Z");
    const staleLockedAt=new Date(now.getTime()-3*60_000);
    const reclaimed={id:"retry_stale",status:"PROCESSING",lockedAt:now};
    mocks.findFirst
      .mockResolvedValueOnce({id:"retry_stale",status:"PROCESSING",lockedAt:staleLockedAt})
      .mockResolvedValueOnce(reclaimed);

    await expect(claimDueSocialAnalyticsRetry(now)).resolves.toEqual(reclaimed);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where:{
        id:"retry_stale",
        status:"PROCESSING",
        AND:[
          {lockedAt:staleLockedAt},
          {lockedAt:{lt:new Date(now.getTime()-2*60_000)}},
        ],
      },
      data:{status:"PROCESSING",lockedAt:now},
    });
  });
});
