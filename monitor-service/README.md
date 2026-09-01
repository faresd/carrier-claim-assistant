# Carrier Return Monitor

The monitor is the private cloud companion for Carrier Claim Assistant. It is designed around the operational goal: recover returned parcels before the pickup deadline and keep lost parcels visible until they are resolved.

Production hostname: `https://tracking.cheaply.fr`. Cloudflare manages its DNS record and TLS certificate through the Worker's custom-domain route.

## Architecture

- **Cloudflare Worker**: authenticated order API, admin dashboard, browser pairing, and scheduled monitor.
- **Cheaply SSO**: the dashboard uses the same `auth.cheaply.fr` PKCE authorization-code login as `presence.cheaply.fr`, with RS256/JWKS verification, a secure local session, and CSRF protection.
- **Cloudflare Queue**: reliable, rate-limited carrier checks that scale beyond one Worker invocation and retry temporary carrier failures.
- **[Cloudflare D1](https://developers.cloudflare.com/d1/)**: durable multi-account order history, current state, claim context, tracking events, devices, and resolutions.
- **[La Poste Suivi v2](https://developer.laposte.fr/catalog-apis/suivi%402)**: official tracking source for tracked mail, Colissimo, and Chronopost. The API key is a Worker secret and never reaches the extension.
- **Chrome/Brave extension**: registers Amazon order context, displays row badges, polls urgent alerts, and shows desktop notifications.

Each record includes a sanitized claim-ready package: seller account, shipment and item identifiers, value/quantity, sender contact/address, recipient/title/address, detected reason, editable message, tracking context, and claim outcome. From the dashboard, **Start claim** creates a single-use ten-minute token and opens the official La Poste or Chronopost workflow. Only a paired extension can redeem that token, and the existing final confirmation remains mandatory.

The scheduled trigger runs every fifteen minutes, but the monitor creates one daily run only during the 07:00 Europe/Paris hour. Extra triggers in that hour safely resume any jobs not yet completed, which protects the morning check from a temporary deployment or queue interruption. This preserves the intended local time across daylight-saving changes. The queue consumes checks sequentially below the official API rate limit and retries temporary failures. Delivered and manually resolved parcels are terminal and are excluded from later carrier calls.

## Return state machine

| State | Meaning | Action |
| --- | --- | --- |
| `in_transit` | Normal outbound movement | Continue daily monitoring |
| `returning` | Carrier has started return-to-sender | Show in Returned tab |
| `pickup_ready` | Returned parcel is waiting for sender pickup | Urgent browser notification and badge, repeated daily until resolved |
| `lost` / `damaged` | Investigation or claim candidate | Show in Lost tab |
| `delivered` | Outbound shipment completed | Stop checking |
| `resolved` | Seller confirmed the returned parcel was physically received | Move to Resolved and stop checking |

Classification is deterministic. AI is deliberately not required for alerts; an optional future fallback may review only statuses left as `unknown`.

## One-time deployment

1. Create a Cloudflare D1 database named `carrier-return-monitor`.
2. Create a Cloudflare Queue named `carrier-tracking-checks`.
3. Create a free Okapi application, subscribe to La Poste **Suivi v2**, and obtain its `X-Okapi-Key`.
4. Add the non-sensitive GitHub Actions repository variables:
   - `CF_ACCOUNT_ID`
   - `CF_D1_DATABASE_ID`
5. Add the following encrypted GitHub Actions secrets:
   - `CF_API_TOKEN` — scoped to this Worker's deployment resources
   - `LAPOSTE_OKAPI_KEY`
   - `MONITOR_SESSION_SECRET` — a long random secret for the dashboard's secure local session
   - `MONITOR_TRACKING_CLIENT_SECRET` — the `tracking-web` client secret shared only with `auth.cheaply.fr`
6. Register `tracking-web` in the existing `cheaply-sso` Worker's client allow-list using the checked-in [`sso/tracking-web-client.json`](sso/tracking-web-client.json) contract and [`sso/README.md`](sso/README.md) source patch. Store the same client secret there as `TRACKING_CLIENT_SECRET`.
7. Run the **Deploy return monitor** workflow. It applies D1 migrations, deploys the Worker/dashboard, connects the queue consumer, and activates the scheduled trigger.
8. Open `https://tracking.cheaply.fr`; it redirects through the existing Cheaply sign-in and returns to the dashboard without exposing a token in browser storage.

The workflow validates every required variable and secret before it applies a migration or deploys anything. It also rejects malformed Cloudflare identifiers, short secrets, and accidental reuse of the SSO client secret as the dashboard session secret; validation errors name the setting but never print its value.

Only central SSO administrators may enter by default. An optional `TRACKING_ADMIN_EMAILS` Worker secret may explicitly allow selected authenticated employee emails. Browser uploads use independently revocable per-device bearer tokens; no global master upload token or dashboard bearer token is provisioned by CI.

## Pair another Chrome/Brave installation

1. In the admin dashboard choose **Add browser**.
2. Copy the Worker URL and temporary six-digit code.
3. Install Carrier Claim Assistant on the other computer/profile.
4. Open **Settings / pair browser**, enter the URL and code, then choose **Connect this browser**.

The code expires after ten minutes and can be used once. Pairing accepts at most ten attempts per network address in a fifteen-minute window. The browser receives its own device token; open **Add browser** on the dashboard to review paired installations and revoke any token. No La Poste or Cloudflare credentials are copied to the computer.

After pairing, the extension immediately backfills up to 50 cached orders and continues pending or failed uploads during its fifteen-minute background cycle. New order checks are synchronized as soon as they are saved locally.
