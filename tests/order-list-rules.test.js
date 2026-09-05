"use strict";

const returnRules = require("../src/shared/carrier-rules.js");

const test = require("node:test");
const assert = require("node:assert/strict");
const { orderIdFromHref, auditIsTerminalDelivered, auditIsFresh, formatStatusTimestamp, badgeFor } = require("../src/shared/order-list-rules.js");

test("invalidates a falsely delivered cached return even when checked recently", () => {
  const now = Date.parse("2026-09-06T10:00:00Z");
  const audit = {
    checkedAt: "2026-09-06T09:59:00Z",
    order: { carrier: "Colissimo", trackingNumber: "CC113610754FR" },
    result: { statusText: "Votre Colissimo a été livré à son expéditeur." },
    recommendation: { recommended: false, reason: "delivered_missing", title: "Marked delivered" }
  };
  assert.equal(auditIsTerminalDelivered(audit), false);
  assert.equal(auditIsFresh(audit, 12, now), false);
  assert.equal(badgeFor({ recommendation: returnRules.repairAudit(audit).recommendation }).label, "Returned · confirm receipt");
  assert.equal(badgeFor({ recommendation: { trackingState: "pickup_ready" } }).label, "Pickup required");
});

test("extracts only canonical Amazon order-detail IDs", () => {
  assert.equal(orderIdFromHref("https://sellercentral.amazon.fr/orders-v3/order/111-2222222-3333333"), "111-2222222-3333333");
  assert.equal(orderIdFromHref("/orders-v3/order/111-2222222-3333333/edit-shipment"), "111-2222222-3333333");
  assert.equal(orderIdFromHref("/myinventory/inventory"), "");
});

test("uses a bounded freshness window for carrier audits", () => {
  const now = new Date("2026-08-24T16:00:00Z").getTime();
  assert.equal(auditIsFresh({ checkedAt: "2026-08-24T12:00:00Z" }, 12, now), true);
  assert.equal(auditIsFresh({ checkedAt: "2026-08-23T12:00:00Z" }, 12, now), false);
});

test("keeps an official delivered result fresh forever", () => {
  const deliveredAudit = {
    checkedAt: "2020-01-01T00:00:00Z",
    recommendation: { recommended: false, reason: "delivered_missing", title: "Marked delivered" }
  };
  const ordinaryAudit = {
    checkedAt: "2020-01-01T00:00:00Z",
    recommendation: { recommended: false, reason: "none", title: "No automatic claim recommended" }
  };
  const now = new Date("2026-08-24T16:00:00Z").getTime();
  assert.equal(auditIsTerminalDelivered(deliveredAudit), true);
  assert.equal(auditIsFresh(deliveredAudit, 12, now), true);
  assert.equal(auditIsFresh(ordinaryAudit, 12, now), false);
});

test("formats a saved audit time for display and rejects missing timestamps", () => {
  assert.match(formatStatusTimestamp("2026-08-24T16:30:00Z", "fr-FR"), /24\/08\/2026/);
  assert.match(formatStatusTimestamp("2026-08-24T16:30:00Z", "fr-FR"), /\d{2}:\d{2}/);
  assert.equal(formatStatusTimestamp(""), "");
});

test("prioritizes sent claims and recommended claims in list badges", () => {
  assert.deepEqual(badgeFor({ outcome: { reference: "LP-12345" } }), {
    state: "sent",
    label: "Claim sent · LP-12345",
    actionable: true
  });
  assert.equal(badgeFor({ recommendation: { recommended: true } }).state, "recommended");
  assert.equal(badgeFor({ recommendation: { recommended: false, title: "Marked delivered" } }).label, "No claim · Delivered");
  assert.equal(badgeFor({ eligibility: "unshipped" }).label, "Not eligible · Unshipped");
});
