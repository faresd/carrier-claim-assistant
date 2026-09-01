# Carrier Claim Assistant

A Chrome/Brave Manifest V3 extension for Amazon Seller Central orders shipped with:

- Colissimo
- La Poste
- Chronopost

It detects the carrier and tracking number, checks the official carrier tracking page in a temporary background tab, applies carrier-specific claim rules, and displays an editable reason/message preview directly on the order detail page.

## Install or update

### Chrome Web Store

Install the published extension from its Chrome Web Store listing. Chrome and other Chromium browsers that support Chrome Web Store extensions receive updates automatically. The extension is self-contained and does not require Codex, Node.js, a local server, or any separately installed package.

### Unpacked development build

1. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `la-poste-claim-assistant` folder.
4. If it is already loaded, choose **Reload** on the extension card.
5. Reload the Amazon order page.

The button initially says **Checking Colissimo…** or **Checking Chronopost…**. It changes to a claim recommendation when the official status check completes.
It is centered along the bottom edge of the Amazon page so extension-reserved corner controls remain unobstructed.

On **Orders → Manage Orders**, every seller-fulfilled order row receives a carrier-claim badge. Shipped orders are checked automatically through one reusable inactive worker tab; it visits the Amazon order details and official carrier tracking page sequentially, then closes once the page queue is complete. Results are normally cached for 12 hours. An official **delivered** result is terminal: it is saved indefinitely and reused on both list and order-detail pages without contacting the carrier again. Its original **Last checked** date/time remains visible across reloads. **Check again** or **Recheck page** explicitly replaces that saved result. Successful claims also retain their submission date/time and immediately display **Claim sent**. The toolbar can pause or recheck the current page. Unshipped, pending, and cancelled rows are marked ineligible without contacting a carrier.

Version 2.9 adds an optional private return-monitor service. Amazon order/tracking context is registered per Seller Central merchant and marketplace, so multiple Amazon accounts remain separated while the admin dashboard can show an All accounts view. The cloud monitor uses the official La Poste Suivi v2 API for Colissimo, La Poste, and Chronopost every morning at 07:00 Europe/Paris. Manage Orders badges prioritize **Returning to sender**, **Pickup required**, **Lost · investigate**, and **Returned · received** over generic claim labels. The extension polls the server for new pickup alerts and displays a persistent Chrome/Brave notification.

The production dashboard and API use `https://tracking.cheaply.fr`. New installations prefill this address and connect through a temporary six-digit pairing code; the cloud service remains disabled until a browser is paired. Pairing immediately uploads up to 50 cached orders, and the existing 15-minute background alarm safely continues any remaining or previously failed uploads.

The dashboard contains All, Lost, Returned, and Resolved histories, an Amazon-account filter, tracking details, a claim-ready package, a **Start La Poste/Chronopost claim** action, and explicit **Confirm received** resolution. The claim package preserves the shipment, item/SKU/ASIN/value/quantity, recipient, sender contact/address, detected reason, editable message, status history, account, and claim reference. The dashboard creates a single-use ten-minute launch link; the paired extension redeems it on the official carrier page and still pauses for operator confirmation before final submission. Installations on other computers or browser profiles connect with a one-time six-digit code and receive separate revocable device tokens. See [`monitor-service/README.md`](monitor-service/README.md).

## Workflow

1. Open an Amazon Seller Central order detail page.
2. The extension waits up to 20 seconds for Amazon's dynamically rendered shipment details.
3. It recognizes aliases such as `COLISSIMOS` as Colissimo.
   As a second check, strong tracking-number patterns override an incorrect Amazon carrier label. For example, `XN000000003JB` is routed to Chronopost even when Amazon displays Colissimo. Ambiguous international formats continue to use the declared carrier.
4. It sends only the tracking number to the corresponding official carrier tracking page.
5. It evaluates the result:
   - Lost/unlocated, damaged, or returned parcels: claim recommended.
   - Chronopost tracking stale beyond 48 hours: investigation recommended.
   - La Poste/Colissimo beyond the configured delivery threshold: claim recommended.
   - Marked delivered: no automatic claim; verify with the buyer first.
   - Future delivery instructions such as **sera livré** are never interpreted as proof of completed delivery; the latest exception line takes precedence.
6. Select the blue/orange button to review and edit the detected complaint reason and message.
7. Choose **Start automated claim** to open and advance the official carrier workflow in an inactive tab:
   - La Poste/Colissimo: Formulaire courrier colis.
   - Chronopost: the contracted, signed-in Service Client ticket form. The extension looks up the shipment by tracking number only, maps the complaint to Chronopost's live object/motive taxonomy, fills product family and comment, and pauses before **Créer le ticket**.
8. At La Poste's **À quel sujet nous contactez-vous ?** step, the first actual answer is selected automatically; navigation controls such as **Retour** are ignored.
9. The carrier tab comes forward only for a required CAPTCHA, an unresolved carrier-only choice, or final confirmation. The final carrier submission always requires a separate confirmation.
   The carrier assistant panel can be collapsed from its header while reviewing the final recap or success screen.
10. After the carrier displays a verified success confirmation, the extension appends a timestamped entry to Amazon **Seller Notes**, including the carrier claim reference when one is displayed. Existing notes are preserved.
11. The Amazon button changes to the persistent **Claim sent** state (with the reference when available), preventing accidental duplicate claims.

Success detection remains active while form automation is paused, so manually selecting the carrier's final submit control does not suppress the saved outcome. For a claim created outside the assistant or before an extension reload, open the Amazon preview, enter the carrier reference under **Existing claim reference**, and choose **Record existing claim** to restore the persistent sent state and Seller Notes entry.

Neither La Poste nor the documented Chronopost contract Webservices expose a supported claim-creation operation. Chronopost's existing contract API is used for shipping/account services; Service Client claims remain in its authenticated Pro form. The extension deliberately lets the official carrier page make the authenticated first-party submission instead of bypassing session, CSRF, or anti-abuse controls. A direct Chronopost claim API can be added later if Chronopost supplies an authorized endpoint and contract documentation.

## Settings

The options page contains editable sender identity/address settings and status thresholds. Personal sender fields are intentionally blank in the distributable build and are saved only after each operator configures their own browser. Updating from an earlier version preserves already-saved settings.

Sender type and title are configurable. Recipient country is normalized locally to the carrier's French label (for example, `Ireland` → `Irlande`). Recipient civilité is detected locally from explicit multilingual honorifics or a conservative common-first-name list—including common German names such as `Arne`—and remains editable in the Amazon preview; unknown or ambiguous names are left unselected. The preview displays the recipient's full name and destination address directly beside the title selector so an operator or assisting agent can resolve uncertain cases.

## Privacy and safety

- Sender profile: `chrome.storage.local`.
- Buyer/order and pending claim: `chrome.storage.session`.
- A Manage Orders scan reuses one inactive worker tab and closes it after the page queue completes. A status check started from an individual order still uses one temporary inactive tab.
- No analytics or third-party libraries.
- The extension never silently submits the final claim.

See [PRIVACY.md](PRIVACY.md) for the complete privacy policy.

## Portable package

The store ZIP contains only `manifest.json`, browser JavaScript/CSS/HTML, and PNG icons. It has no local runtime dependency, bundler, native application, local server, or machine-specific path. The optional return monitor is a private HTTPS service configured after installation; the extension still installs identically on any Chrome or Brave computer. Run `npm run package` when developing to create `dist/carrier-claim-assistant-vX.Y.Z.zip` with `manifest.json` at the archive root.

## Online CI/CD

GitHub Actions performs all release automation:

- `.github/workflows/ci.yml` runs the Node built-in test suite and builds a verified ZIP on every pull request and `main` push.
- `.github/workflows/deploy-monitor.yml` applies D1 migrations and deploys the private Worker, dashboard, queue consumer, and morning schedule after Cloudflare secrets are configured.
- `.github/workflows/release.yml` verifies a `vX.Y.Z` tag, creates the GitHub release, then uploads and submits the same artifact through the official Chrome Web Store API v2.
- `.github/workflows/pages.yml` publishes the public privacy page from `docs/`.

The workflow installs no project dependencies. It uses Node's built-in test runner, raster generation, and `fetch`, standard ZIP tools available on GitHub's hosted runner, GitHub Actions, Google OAuth, and the official Chrome Web Store API. `npm run generate:assets` reproducibly builds the extension icons and privacy-safe store graphics from source code.

The private monitor dashboard at `tracking.cheaply.fr` uses the existing `auth.cheaply.fr` PKCE/RS256 SSO flow shared with `presence.cheaply.fr`. No dashboard token is typed into or retained by browser storage; Chrome/Brave order uploads continue to use separate revocable device tokens.

The initial Chrome Web Store item must be created once in the Developer Dashboard because the API only updates an existing item. Configure the GitHub `chrome-web-store` environment with these encrypted secrets:

- `CWS_CLIENT_ID`
- `CWS_CLIENT_SECRET`
- `CWS_REFRESH_TOKEN`
- `CWS_PUBLISHER_ID`
- `CWS_EXTENSION_ID`

An optional environment variable named `CWS_PUBLISH_TYPE` can be set to `STAGED_PUBLISH`; otherwise approved releases publish automatically with `DEFAULT_PUBLISH`. See [STORE_LISTING.md](STORE_LISTING.md) for the first-listing content and permission justifications.

## Maintenance

Amazon and the carrier sites are dynamic. The implementation relies on visible labels, accessible names, stable transmission keys where available, and carrier text rules rather than generated CSS selectors.
