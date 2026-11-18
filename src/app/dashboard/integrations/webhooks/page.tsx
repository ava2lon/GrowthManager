import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {WebhookManager} from "./webhook-manager";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const context = await requireWorkspaceContext();
  const [subscriptions, deliveries] = await Promise.all([
    db.webhookSubscription.findMany({
      where: {workspaceId: context.workspace.id},
      orderBy: {createdAt: "desc"},
      select: {
        id: true, name: true, endpointUrl: true, eventTypes: true, status: true,
        consecutiveFailures: true, lastDeliveryAt: true, createdAt: true,
        _count: {select: {deliveries: true}},
      },
    }),
    db.webhookDelivery.findMany({
      where: {workspaceId: context.workspace.id},
      orderBy: {createdAt: "desc"},
      take: 30,
      select: {
        id: true, subscriptionId: true, eventId: true, eventType: true, status: true,
        attemptCount: true, retryAttempts: true, nextAttemptAt: true, deliveredAt: true,
        lastHttpStatus: true, lastErrorCode: true, createdAt: true,
        subscription: {select: {name: true}},
        attempts: {orderBy: {attemptNumber: "desc"}, take: 3, select: {attemptNumber: true, status: true, httpStatus: true, errorCode: true, startedAt: true, finishedAt: true}},
      },
    }),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 p-6">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">Integrations / Webhooks</p>
        <h1 className="text-2xl font-semibold">Outbound webhooks</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Deliver signed, workspace-scoped GrowthManager events to HTTPS endpoints. Signing secrets are shown only when created or rotated.
        </p>
      </header>
      <WebhookManager
        canManage={context.membership.role === "OWNER" || context.membership.role === "ADMIN"}
        subscriptions={subscriptions.map((item) => ({
          ...item,
          lastDeliveryAt: item.lastDeliveryAt?.toISOString() ?? null,
          createdAt: item.createdAt.toISOString(),
        }))}
        deliveries={deliveries.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          nextAttemptAt: item.nextAttemptAt.toISOString(),
          deliveredAt: item.deliveredAt?.toISOString() ?? null,
          attempts: item.attempts.map((attempt) => ({
            ...attempt,
            startedAt: attempt.startedAt.toISOString(),
            finishedAt: attempt.finishedAt?.toISOString() ?? null,
          })),
        }))}
      />
    </main>
  );
}
