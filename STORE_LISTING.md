# Chrome Web Store listing draft

## Name

Carrier Claim Assistant

## Summary

Check La Poste, Colissimo, and Chronopost delivery status from Amazon Seller Central and prepare editable carrier claims.

## Detailed description

Carrier Claim Assistant adds a delivery-status and claim workflow to Amazon Seller Central order pages.

It detects the carrier from the Amazon shipment and tracking-number format, checks the corresponding official carrier tracking page, and shows whether a claim is recommended. The claim reason and message remain editable before the official carrier workflow begins.

Supported workflows include Colissimo and La Poste claim forms plus the authenticated Chronopost Service Client form. Recipient name/address and a locally inferred title are visible for review. A successful carrier confirmation can be appended to Seller Notes, including the claim reference when available, and the order is marked Claim sent to reduce duplicates.

Manage Orders pages can scan shipped orders sequentially through one reusable inactive tab. Results include the last-check time. Delivered results are cached until the operator explicitly rechecks them.

The extension has no analytics, advertising, or third-party libraries. Sender settings and cached outcomes remain in browser extension storage. Final claim submission always requires explicit confirmation.

## Category

Productivity

## Language

English (interface), with French carrier workflows

## Single purpose

Help Amazon Seller Central operators identify shipment problems and prepare a carrier claim on official La Poste/Colissimo or Chronopost pages.

## Permission justifications

- `storage`: saves sender settings, delivery-check cache, and confirmed claim outcomes in extension storage.
- `alarms`: safely expires status checks and audit loads that do not complete.
- Amazon Seller Central host access: reads visible order/shipment data and appends a confirmed claim result to Seller Notes.
- La Poste and Chronopost host access: reads official tracking status and prefills the corresponding user-requested claim workflow.

## Required listing assets

- Store icon: `icons/icon128.png`
- Small promotional tile: `store-assets/small-promo-tile-440x280.png`
- Screenshot: `store-assets/screenshot-order-preview-1280x800.png` (synthetic order data only)
- Privacy policy: the deployed GitHub Pages URL from `docs/index.html`
