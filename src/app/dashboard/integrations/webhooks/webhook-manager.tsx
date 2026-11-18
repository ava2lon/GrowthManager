"use client";

import {useState, useTransition} from "react";
import {
  createWorkspaceWebhookSubscription,
  pauseWorkspaceWebhookSubscription,
  resumeWorkspaceWebhookSubscription,
  rotateWorkspaceWebhookSigningSecret,
  redeliverWorkspaceWebhookDelivery,
} from "../webhook-actions";

type Subscription = {
  id: string; name: string; endpointUrl: string; eventTypes: string[]; status: string;
  consecutiveFailures: number; lastDeliveryAt: string | null; createdAt: string;
  _count: {deliveries: number};
};
type Attempt = {
  attemptNumber: number; status: string; httpStatus: number | null; errorCode: string | null;
  startedAt: string; finishedAt: string | null;
};
type Delivery = {
  id: string; subscriptionId: string; eventId: string; eventType: string; status: string;
  attemptCount: number; retryAttempts: number; nextAttemptAt: string; deliveredAt: string | null;
  lastHttpStatus: number | null; lastErrorCode: string | null; createdAt: string;
  subscription: {name: string}; attempts: Attempt[];
};

const eventOptions = [
  ["social.incident.created", "Social incident created"],
  ["social.incident.reopened", "Social incident reopened"],
  ["social.incident.resolved", "Social incident resolved"],
  ["automation.alert.created", "Automation alert created"],
  ["automation.alert.resolved", "Automation alert resolved"],
] as const;

export function WebhookManager({canManage, subscriptions, deliveries}: {
  canManage: boolean; subscriptions: Subscription[]; deliveries: Delivery[];
}) {
  const [pending, startTransition] = useTransition();
  const [secret, setSecret] = useState<{label: string; value: string} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function runAction(action: (formData: FormData) => Promise<unknown>, values: Record<string, string>, success: string) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(values)) formData.set(key, value);
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try { await action(formData); setNotice(success); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Webhook action failed."); }
    });
  }

  function create(form: HTMLFormElement) {
    const formData = new FormData(form);
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await createWorkspaceWebhookSubscription(formData);
        setSecret({label: "Copy this signing secret now. It will not be shown again.", value: result.signingSecret});
        setNotice("Webhook subscription created.");
        form.reset();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not create webhook subscription.");
      }
    });
  }

  return (
    <div className="space-y-8">
      {error && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {notice && <div role="status" className="rounded-lg border p-3 text-sm">{notice}</div>}
      {secret && (
        <section className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">Signing secret</h2>
          <p className="text-sm">{secret.label}</p>
          <code className="block break-all rounded bg-white p-3 text-sm">{secret.value}</code>
          <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={() => navigator.clipboard.writeText(secret.value)}>Copy secret</button>
          <button type="button" className="ml-2 rounded-md border px-3 py-2 text-sm" onClick={() => setSecret(null)}>Close</button>
        </section>
      )}

      {canManage && (
        <section className="space-y-4 rounded-xl border p-5">
          <div>
            <h2 className="text-lg font-semibold">Add endpoint</h2>
            <p className="text-sm text-muted-foreground">Only public HTTPS destinations are accepted. Local and private network addresses are blocked.</p>
          </div>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={(event) => {event.preventDefault(); create(event.currentTarget);}}>
            <label className="grid gap-1 text-sm">Endpoint name
              <input name="name" required maxLength={80} className="rounded-md border bg-background px-3 py-2" placeholder="Production n8n" />
            </label>
            <label className="grid gap-1 text-sm">HTTPS endpoint URL
              <input name="endpointUrl" type="url" required maxLength={2048} className="rounded-md border bg-background px-3 py-2" placeholder="https://automation.example.com/webhook/..." />
            </label>
            <fieldset className="md:col-span-2">
              <legend className="mb-2 text-sm font-medium">Subscribe to events</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {eventOptions.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="eventTypes" value={value} defaultChecked={value.startsWith("social.") || value.startsWith("automation.")} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="md:col-span-2">
              <button disabled={pending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                {pending ? "Saving..." : "Create webhook"}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Subscriptions ({subscriptions.length})</h2>
        {subscriptions.length === 0 ? <p className="rounded-lg border p-5 text-sm text-muted-foreground">No webhook endpoints configured for this workspace.</p> : (
          <div className="grid gap-3">
            {subscriptions.map((subscription) => {
              let host = subscription.endpointUrl;
              try { host = new URL(subscription.endpointUrl).host; } catch {}
              return (
                <article key={subscription.id} className="space-y-3 rounded-xl border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold">{subscription.name}</h3>
                      <p className="text-sm text-muted-foreground">{host}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{subscription.eventTypes.join(", ")}</p>
                    </div>
                    <span className="rounded-full border px-2 py-1 text-xs">{subscription.status}</span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span>{subscription._count.deliveries} deliveries</span>
                    <span>{subscription.consecutiveFailures} consecutive failures</span>
                    <span>Last delivery: {subscription.lastDeliveryAt ? new Date(subscription.lastDeliveryAt).toLocaleString() : "Never"}</span>
                  </div>
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      {subscription.status === "ACTIVE"
                        ? <button disabled={pending} onClick={() => runAction(pauseWorkspaceWebhookSubscription, {subscriptionId: subscription.id}, "Subscription paused.")} className="rounded-md border px-3 py-2 text-xs">Pause</button>
                        : <button disabled={pending} onClick={() => runAction(resumeWorkspaceWebhookSubscription, {subscriptionId: subscription.id}, "Subscription resumed.")} className="rounded-md border px-3 py-2 text-xs">Resume</button>}
                      <button disabled={pending} onClick={() => {
                        if (window.confirm("Rotate this signing secret? The old secret will stop working immediately.")) {
                          const formData = new FormData(); formData.set("subscriptionId", subscription.id);
                          setError(null); setNotice(null);
                          startTransition(async () => {
                            try {
                              const result = await rotateWorkspaceWebhookSigningSecret(formData);
                              setSecret({label: "New signing secret. Update the receiver immediately; the previous secret is no longer valid.", value: result.signingSecret});
                              setNotice("Signing secret rotated.");
                            } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not rotate signing secret."); }
                          });
                        }
                      }} className="rounded-md border px-3 py-2 text-xs">Rotate secret</button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent deliveries</h2>
        {deliveries.length === 0 ? <p className="rounded-lg border p-5 text-sm text-muted-foreground">No event deliveries have been queued yet.</p> : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs"><tr><th className="p-3">Event</th><th className="p-3">Endpoint</th><th className="p-3">Status</th><th className="p-3">Attempts</th><th className="p-3">Last result</th><th className="p-3">Action</th></tr></thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id} className="border-b last:border-0">
                    <td className="p-3"><div>{delivery.eventType}</div><div className="text-xs text-muted-foreground">{delivery.createdAt}</div></td>
                    <td className="p-3">{delivery.subscription.name}</td>
                    <td className="p-3">{delivery.status}</td>
                    <td className="p-3">{delivery.attemptCount}</td>
                    <td className="p-3">{delivery.lastHttpStatus ?? delivery.lastErrorCode ?? "—"}</td>
                    <td className="p-3">
                      {canManage && delivery.status === "FAILED" && (
                        <button disabled={pending} onClick={() => runAction(redeliverWorkspaceWebhookDelivery, {deliveryId: delivery.id}, "Delivery queued for manual redelivery.")} className="rounded-md border px-2 py-1 text-xs">Redeliver</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
