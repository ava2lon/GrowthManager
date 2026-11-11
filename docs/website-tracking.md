# Website tracking

## Create and install

A workspace administrator creates a website in **Dashboard → Websites**. Domains are canonicalized to lowercase hostnames: protocol, path, query, fragment and a leading `www.` are removed. Custom ports, credentials, localhost and IP-literal hosts are rejected. A canonical domain is unique within its workspace.

Set `NEXT_PUBLIC_APP_URL` to the externally reachable GrowthManager origin. Copy the snippet from the website detail page and add it to the site's HTML `<head>`:

```html
<script async src="https://YOUR_GROWTHMANAGER_APP_URL/tracker.js" data-site-id="site_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></script>
```

The tracker derives the ingestion endpoint from its script URL. The tracking ID is public and is not a secret.

## Browser API

The tracker exposes `window.GrowthManager`:

```js
GrowthManager.track("signup", { method: "google" });
GrowthManager.track("button_click", { button_id: "pricing-cta" });
GrowthManager.identify({ email: "customer@example.com", external_id: "customer-123" });
```

Only explicitly supplied properties are sent. The tracker never reads form fields or arbitrary DOM content. Sensitive property names such as password, token, cookie, card and authorization are rejected. Identity fields are sent only when the site explicitly calls `identify()`.

## Events, visitors and sessions

The tracker emits `page_view` on initialization and same-document History API / popstate / hash navigation. It generates a pseudonymous visitor ID and session ID using browser cryptography when available, reuses the visitor ID, and starts a new session after 30 minutes of inactivity. The server independently enforces the 30-minute inactivity timeout and can rotate an expired session ID.

Known standard event names are categorized as their own event type; other valid event names are preserved and categorized as `custom`. The server emits `session_start` when it creates a session. Visitor IDs are pseudonymous and are not email addresses.

## API

- `GET/POST /api/v1/websites`: list/create websites (workspace authenticated).
- `GET/PATCH/DELETE /api/v1/websites/:websiteId`: read/update/delete one website.
- `GET /api/v1/websites/:websiteId/events`: paginated event history; supports `page`, `limit` (max 100), `event`, `type`, `from`, `to`, and `q`.
- `GET /api/v1/websites/:websiteId/stats?days=30`: bounded 1–90 day statistics.
- `POST /api/v1/track`: public ingestion endpoint; site ID is included as `site_id`.

## Security and privacy

Dashboard endpoints derive workspace membership from the authenticated session and active-workspace selection cookie, then scope every query by workspace ID. Public ingestion resolves the website and its workspace server-side from the unguessable tracking ID, checks website status, and validates the browser Origin hostname against the canonical configured domain. CORS is non-credentialed. The tracking ID identifies a website but is not an authentication secret.

The ingestion payload is capped at 16 KiB; event properties are capped at 4 KiB, five levels deep and 50 keys. Event names, identifiers, URLs and timestamps are bounded and validated. Production ingestion fails closed when the existing Redis rate-limit service is unavailable or unconfigured. The IP address is used transiently to derive a rate-limit key and is not stored. User-agent strings are truncated; email and external IDs are persisted only after an explicit identify call.

Deleting a website cascades to its visitors, sessions, events and identities. No retention-deletion job is included in this phase; define a retention period and operational deletion job before collecting production data at scale. Event history is paginated and dashboard queries are workspace-scoped.

## Verification and troubleshooting

The website detail page reports **Receiving events** only when an event was recorded within the last 15 minutes; otherwise it reports **Not detected**. A paused website or disabled tracking reports **Paused**. Verify the script URL and `data-site-id`, confirm the canonical domain matches the website hostname, configure `NEXT_PUBLIC_APP_URL`, and ensure production Redis rate limiting is configured. Ad blockers and browser privacy settings can prevent collection.
