import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks = vi.hoisted(() => ({
  policyFindMany: vi.fn(),
  policyUpdateMany: vi.fn(),
  eventFindMany: vi.fn(),
  eventUpdateMany: vi.fn(),
  integrationFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
  deliveryCreateMany: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    automationAlertPolicy: {
      findMany: mocks.policyFindMany,
      updateMany: mocks.policyUpdateMany,
    },
    automationAlertEvent: {
      findMany: mocks.eventFindMany,
    },
    integration: {findFirst: mocks.integrationFindFirst},
    workspaceMembership: {findMany: mocks.membershipFindMany},
    $transaction: mocks.transaction,
  },
}));

import {enqueueAutomationAlertEscalations} from "@/lib/automation-alert-notifications";

const tx = {
  automationAlertEvent: {updateMany: mocks.eventUpdateMany},
  automationAlertDelivery: {createMany: mocks.deliveryCreateMany},
  activityLog: {create: mocks.activityCreate},
};

describe("enqueueAutomationAlertEscalations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.policyFindMany.mockResolvedValue([{workspaceId: "workspace-1"}]);
    mocks.policyUpdateMany.mockResolvedValue({count: 1});
    mocks.eventFindMany.mockResolvedValue([{
      id: "event-1",
      escalationRecipientCursor: null,
    }]);
    mocks.eventUpdateMany.mockResolvedValue({count: 1});
    mocks.integrationFindFirst.mockResolvedValue({id: "resend-1"});
    mocks.membershipFindMany.mockResolvedValue([]);
    mocks.deliveryCreateMany.mockResolvedValue({count: 0});
    mocks.activityCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback: (transaction: typeof tx) => Promise<number>) => callback(tx));
  });

  it("bounds each recipient page and persists a cursor when more recipients remain", async () => {
    mocks.membershipFindMany.mockResolvedValue(Array.from({length: 51}, (_, index) => ({
      id: "member-" + String(index + 1).padStart(3, "0"),
      user: {email: "admin" + index + "@example.com"},
    })));
    mocks.deliveryCreateMany.mockResolvedValue({count: 50});

    const result = await enqueueAutomationAlertEscalations();

    expect(result).toEqual({eventsChecked: 1, deliveriesQueued: 50});
    expect(mocks.policyFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 5,
      orderBy: [
        {lastEscalationAt: {sort: "asc", nulls: "first"}},
        {createdAt: "asc"},
        {workspaceId: "asc"},
      ],
    }));
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 51,
      orderBy: {id: "asc"},
    }));
    expect(mocks.eventUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        id: "event-1",
        escalationRecipientCursor: null,
      }),
      data: {
        escalationRecipientCursor: "member-050",
        escalatedAt: null,
      },
    }));
    expect(mocks.deliveryCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryCreateMany.mock.calls[0][0].data).toHaveLength(50);
  });

  it("marks an event complete after its final recipient page", async () => {
    mocks.eventFindMany.mockResolvedValue([{
      id: "event-1",
      escalationRecipientCursor: "member-050",
    }]);
    mocks.membershipFindMany.mockResolvedValue([{
      id: "member-051",
      user: {email: "last-admin@example.com"},
    }]);
    mocks.deliveryCreateMany.mockResolvedValue({count: 1});

    const result = await enqueueAutomationAlertEscalations();

    expect(result).toEqual({eventsChecked: 1, deliveriesQueued: 1});
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        id: {gt: "member-050"},
      }),
    }));
    expect(mocks.eventUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        escalationRecipientCursor: null,
        escalatedAt: expect.any(Date),
      },
    }));
  });

  it("does not advance recipient cursors when the Resend integration is unavailable", async () => {
    mocks.integrationFindFirst.mockResolvedValue(null);

    const result = await enqueueAutomationAlertEscalations();

    expect(result).toEqual({eventsChecked: 1, deliveriesQueued: 0});
    expect(mocks.membershipFindMany).not.toHaveBeenCalled();
    expect(mocks.eventUpdateMany).not.toHaveBeenCalled();
  });
});
