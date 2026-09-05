"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const records = require("../src/shared/tracking-records.js");

test("repairs the screenshot's return banner without resolving or forgetting the return", () => {
  const record = {
    orderId: "403-9672539-8018704", trackingNumber: "CC113610754FR", trackingState: "unknown",
    statusText: "Retour à l’expéditeur", statusSummary: "Votre Colissimo a été livré à son expéditeur. Votre colis est livré."
  };
  const repaired = records.repairRecord(record);
  assert.equal(repaired.trackingState, "returned_delivered");
  assert.deepEqual(records.badgeForRecord(repaired), { state: "returned", label: "Returned · confirm receipt", actionable: true });
  assert.equal(records.isTerminal(repaired), false);
  assert.equal(records.monitorEligible(repaired), true);
  const resolved = { ...record, trackingState: "resolved", resolvedAt: "2026-09-02T09:00:00Z" };
  assert.equal(records.repairRecord(resolved), resolved);
  assert.equal(records.buildRecord({ previous: resolved, order: record, result: { statusText: record.statusText, summaryText: record.statusSummary } }).trackingState, "resolved");
});

test("retains current status-card evidence and corrects a legacy delivered record on reload", () => {
  const previous = {
    orderId: "403-9672539-8018704", trackingNumber: "CC113610754FR", trackingState: "delivered",
    statusText: "Votre colis est livré.", statusSummary: "Retour à l’expéditeur",
    statusCurrentSummary: "Votre Colissimo a été livré à son expéditeur."
  };
  const record = records.buildRecord({ previous, order: { orderId: previous.orderId, trackingNumber: previous.trackingNumber } });
  assert.equal(record.trackingState, "returned_delivered");
  assert.equal(record.statusCurrentSummary, previous.statusCurrentSummary);
  const ordinary = { ...previous, statusCurrentSummary: "" };
  assert.equal(records.repairRecord(ordinary), ordinary);
  assert.equal(records.isTerminal(ordinary), true);
  const genericFollowup = records.buildRecord({ previous: record, order: { orderId: record.orderId, trackingNumber: record.trackingNumber }, result: { statusText: "Votre colis est livré." } });
  assert.equal(genericFollowup.trackingState, "returned_delivered");
  assert.equal(records.monitorEligible(genericFollowup), true);
});

test("detects urgent sender pickup only in a return context", () => {
  assert.equal(records.trackingState({
    statusText: "Votre envoi retourné est disponible au bureau de poste",
    summaryText: "Retour à l'expéditeur · à retirer au point de retrait"
  }), "pickup_ready");
  assert.equal(records.trackingState({
    statusText: "Votre colis est disponible au point relais pour le destinataire"
  }), "unknown");
  assert.equal(records.trackingState({
    statusText: "Votre colis est disponible au bureau de poste pour le destinataire",
    summaryText: "À défaut de retrait, il sera retourné à l'expéditeur"
  }), "unknown");
});

test("lets the current delivered or lost event override older return history", () => {
  assert.equal(records.trackingState({
    statusText: "Votre colis a été livré.",
    summaryText: "Votre colis est en retour à l'expéditeur."
  }), "delivered");
  assert.equal(records.trackingState({
    statusText: "Votre colis ne peut plus être localisé.",
    summaryText: "Votre colis est en retour à l'expéditeur."
  }), "lost");
});

test("creates a multi-account record key and return badge", () => {
  const record = records.buildRecord({
    order: {
      orderId: "111-2222222-3333333",
      trackingNumber: "CC000000001FR",
      sellerAccountId: "merchant-a",
      marketplaceId: "amazon-fr"
    },
    result: { statusText: "Retour à l'expéditeur", source: "carrier-page-laposte" },
    recommendation: { carrier: { id: "laposte", label: "Colissimo" }, reason: "returned", recommended: true }
  });
  assert.equal(record.recordId, "merchant-a|amazon-fr|111-2222222-3333333");
  assert.equal(record.trackingState, "returning");
  assert.equal(record.trackingSource, "carrier-page-laposte");
  assert.deepEqual(records.badgeForRecord(record), { state: "returned", label: "Returning to sender", actionable: true });
});

test("resolved and delivered records are excluded from monitoring", () => {
  assert.equal(records.monitorEligible({ orderId: "1", trackingNumber: "X", trackingState: "resolved" }), false);
  assert.equal(records.monitorEligible({ orderId: "1", trackingNumber: "X", trackingState: "delivered" }), false);
  assert.deepEqual(records.badgeForRecord({ trackingState: "delivered" }), {
    state: "delivered",
    label: "Delivered",
    actionable: false
  });
});

test("an Amazon page reload does not erase a server-return or pickup state", () => {
  const previous = {
    orderId: "111-2222222-3333333",
    trackingNumber: "CC000000001FR",
    trackingState: "pickup_ready",
    statusText: "Returned parcel waiting for sender pickup"
  };
  const record = records.buildRecord({
    order: { orderId: previous.orderId, trackingNumber: previous.trackingNumber },
    result: {},
    recommendation: { carrier: { id: "laposte", label: "Colissimo" } },
    previous
  });
  assert.equal(record.trackingState, "pickup_ready");
  assert.equal(record.statusText, previous.statusText);
});

test("enriching the seller account corrects an earlier fallback record key", () => {
  const record = records.buildRecord({
    order: {
      orderId: "111-2222222-3333333",
      trackingNumber: "CC000000001FR",
      sellerAccountId: "merchant-real",
      marketplaceId: "A13V1IB3VIYZZH"
    },
    previous: {
      recordId: "sellercentral.amazon.fr|A13V1IB3VIYZZH|111-2222222-3333333",
      trackingState: "unknown"
    }
  });
  assert.equal(record.recordId, "merchant-real|A13V1IB3VIYZZH|111-2222222-3333333");
});

test("keeps the same Amazon order number isolated across seller accounts", () => {
  const orderId = "999-1111111-2222222";
  const first = {
    recordId: `merchant-a|amazon-fr|${orderId}`,
    orderId,
    sellerAccountId: "merchant-a",
    marketplaceId: "amazon-fr",
    trackingNumber: "CC000000001FR"
  };
  const second = {
    recordId: `merchant-b|amazon-fr|${orderId}`,
    orderId,
    sellerAccountId: "merchant-b",
    marketplaceId: "amazon-fr",
    trackingNumber: "XY123456789FR"
  };
  const collection = records.rekeyRecords({ [orderId]: first, second });

  assert.equal(records.findRecord(collection, first).trackingNumber, "CC000000001FR");
  assert.equal(records.findRecord(collection, second).trackingNumber, "XY123456789FR");
  assert.equal(records.findRecord(collection, { orderId }), null);
  assert.deepEqual(Object.keys(collection).sort(), [first.recordId, second.recordId].sort());
});

test("reconstructs a sent claim outcome from a synchronized server record", () => {
  const outcome = records.claimOutcomeForRecord({
    recordId: "merchant-a|amazon-fr|111-2222222-3333333",
    accountId: "merchant-a",
    accountName: "Cheaply France",
    marketplaceId: "amazon-fr",
    orderId: "111-2222222-3333333",
    trackingNumber: "CC000000001FR",
    carrierId: "laposte",
    claimStatus: "sent",
    claimReason: "lost",
    claimReference: "COL-91855121",
    claimSubmittedAt: "2026-09-01T08:00:00.000Z"
  });
  assert.equal(outcome.recordId, "merchant-a|amazon-fr|111-2222222-3333333");
  assert.equal(outcome.reference, "COL-91855121");
  assert.equal(outcome.sellerAccountId, "merchant-a");
  assert.equal(outcome.noteSaved, false);
  assert.equal(records.claimOutcomeForRecord({ orderId: "111-2222222-3333333", claimStatus: "none" }), null);
});
