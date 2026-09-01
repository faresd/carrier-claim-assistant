# Privacy Policy — Carrier Claim Assistant

Effective date: 1 September 2026

Carrier Claim Assistant is a browser extension that helps Amazon Seller Central operators check official carrier status and prepare claims for Colissimo, La Poste, and Chronopost shipments.

## Data handled

The extension may read the following information from the Amazon Seller Central pages opened by the user:

- order identifier, shipment dates, carrier, and tracking number;
- recipient name and delivery address;
- existing Seller Notes needed to append a claim confirmation without replacing prior notes.

The user may save a sender profile containing a name, email address, telephone number, company, and postal address. Claim drafts and confirmed carrier references may also be handled.

## How data is used

Data is used only to provide the extension's visible features:

- determine the shipment carrier and delivery status;
- show an editable claim recommendation and recipient preview;
- prefill a user-requested claim on the corresponding official carrier site;
- save a verified claim result to Seller Notes and prevent duplicate claims;
- cache delivery checks, including terminal delivered results, in the browser.
- when the operator explicitly enables private cloud sync, maintain a multi-account order history, run daily official tracking checks, identify returned parcels waiting for pickup, and synchronize claim/resolution state with the configured monitor service.

The extension does not send order, recipient, sender, or claim data to the extension developer. Without cloud sync, a tracking number is sent only to the official La Poste or Chronopost tracking page. When cloud sync is enabled by the operator, order, recipient, tracking, status, claim, merchant-account, and resolution details are sent to that operator's configured private monitor server. The monitor server sends tracking numbers to La Poste's official Suivi v2 API. When the user starts and confirms a claim, the required claim data is submitted directly to the selected carrier's official website.

## Storage and retention

Sender settings, cached audit results, and successful claim outcomes are stored in browser extension storage on the user's device. Pending claim details use browser session storage. Delivered results may be kept until the user clears extension data or uninstalls the extension so that repeated carrier checks are unnecessary.

When cloud sync is enabled, synchronized records—including the sender, recipient, shipment, item, and editable claim-preparation fields needed for the operator's carrier workflow—remain in the configured monitor database until the operator deletes that service/database. Marking a returned parcel as received moves it to Resolved and stops future tracking checks; it does not automatically delete the history. Browser pairing codes and claim-launch links expire after ten minutes. Per-device tokens remain until revoked or the monitor database is removed.

## Sharing and sale

The extension has no analytics, advertising, or third-party tracking libraries. Data is not sold, rented, or shared for advertising, profiling, or unrelated purposes. Data is disclosed to Amazon Seller Central, La Poste, or Chronopost only when necessary for a feature initiated by the user on those services.

## Security and user control

The extension uses Chrome Manifest V3 permissions for storage, scheduled checks, notifications, supported Amazon/carrier pages, and an operator-approved HTTPS monitor origin. Broad network access is optional and the browser asks before granting access to the exact configured server. Carrier API and cloud-administration secrets stay on the server. Per-browser tokens can be revoked independently. The extension does not collect account passwords or payment details. Final carrier submission requires explicit confirmation. Users can disable cloud sync, edit settings, recheck cached status, clear browser extension data, or uninstall the extension at any time.

## Changes

Material changes to this policy will be published with the source repository and the extension's public privacy-policy page.

## Contact

The publisher's support email is provided on the Chrome Web Store listing.
