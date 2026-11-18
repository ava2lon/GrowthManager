# Outbound workspace webhooks

## Current event contracts

Webhook subscriptions are scoped to the active workspace. The currently emitted event types are:

- `social.incident.created`
- `social.incident.reopened`
- `social.incident.resolved`
- `automation.alert.created`
- `automation.alert.resolved`

Subscriptions can select one or more event types or use the `*` wildcard. The UI only offers event types that have implemented producers. Content, website-tracking, and publishing lifecycle events are not advertised until their producers are wired.

## Delivery envelope

Every delivery uses a versioned JSON envelope:

```json
{
  "id": "stable-event-id",
  "type": "social.incident.created",
  "version": 1,
  "occurredAt": "2026-11-18T14:00:00.000Z",
  "workspaceId": "workspace-id",
  "data": {
    "incidentId": "incident-id",
    "category": "CONNECTION_ERROR",
    "severity": "CRITICAL",
    "status": "OPEN"
  }
}
```

The example illustrates the contract shape; actual `data` fields depend on the event type. Consumers must tolerate additional fields and must not assume that event types outside their subscription will be delivered.

## Signature verification

Requests are sent over HTTPS with redirects disabled and these headers:

- `X-GrowthManager-Event`: event type.
- `X-GrowthManager-Delivery`: stable delivery record ID.
- `X-GrowthManager-Timestamp`: Unix timestamp in seconds.
- `X-GrowthManager-Signature`: `v1=<64-character lowercase hex HMAC>`.
- `Idempotency-Key`: stable delivery record ID.

The signature is HMAC-SHA256 over the exact UTF-8 request body:

```text
HMAC_SHA256(signing_secret, timestamp + "." + raw_request_body)
```

Receivers must verify the signature against the raw request bytes before parsing JSON, use a constant-time comparison, and reject timestamps more than five minutes from the current time. The signing secret is shown only once when the subscription is created or rotated. Store it in the receiver's secret manager; do not commit it or log it.

Timestamp validation limits replay duration. Receivers must additionally persist processed `X-GrowthManager-Delivery` or `Idempotency-Key` values and reject duplicates. Delivery is at-least-once, not exactly-once.

## Retry and dead-letter behavior

- A successful 2xx response marks the delivery `DELIVERED`.
- 408, 425, 429, 5xx and transport failures are retried.
- Other HTTP statuses, invalid destinations and private-network DNS results are terminal.
- Automatic retry uses exponential backoff starting at 60 seconds, capped at six hours, with deterministic jitter.
- Each automatic retry round is limited to eight attempts. Manual redelivery starts a new retry round while retaining lifetime attempt history.
- A subscription is automatically paused after 20 consecutive failures. A workspace administrator can resume it after correcting the receiver.
- Response bodies are not stored. Attempt history records status, HTTP status, sanitized error code and duration only.

## Endpoint security

Only HTTPS URLs on port 443 (or the default HTTPS port) are accepted. URL credentials, IP-literal hosts, localhost, local/internal suffixes, private and reserved IPv4 destinations are rejected. DNS is re-resolved before each send and the selected public IPv4 address is pinned for the TLS request. Redirects are never followed. Requests time out after eight seconds and response reads are bounded.

## Worker scheduling

The authenticated worker endpoint is `GET /api/cron/webhook-deliveries` and requires `Authorization: Bearer <CRON_SECRET>`. It processes a bounded batch and is safe for overlapping invocations through database leases and compare-and-set claims.

The route is intentionally not added to `vercel.json` until the deployment plan's cron frequency is confirmed. Vercel Hobby cron schedules run at most once per day, while Pro and Enterprise support per-minute scheduling; a daily dispatcher is not an acceptable delivery latency for operational webhooks. Use a per-minute scheduler on an eligible plan or a trusted external scheduler to call the endpoint. See the [Vercel event-driven architecture overview](https://vercel.com/i/event-driven-architecture).
