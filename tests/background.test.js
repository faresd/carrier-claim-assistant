"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const listeners = {};
const local = {};
const session = {};
const createdTabs = [];
const sentMessages = [];
const removedTabs = [];
const updatedTabs = [];
const alarms = new Map();
let nextTabId = 100;

function storageArea(target) {
  return {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter((key) => key in target).map((key) => [key, target[key]]));
    },
    async set(values) {
      Object.assign(target, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete target[key];
    }
  };
}

global.chrome = {
  runtime: {
    onInstalled: { addListener(listener) { listeners.installed = listener; } },
    onMessage: { addListener(listener) { listeners.message = listener; } },
    async openOptionsPage() {}
  },
  storage: {
    local: storageArea(local),
    session: storageArea(session)
  },
  tabs: {
    async create(options) {
      const tab = { id: nextTabId++, ...options };
      createdTabs.push(tab);
      return tab;
    },
    async sendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
    },
    async remove(tabId) {
      removedTabs.push(tabId);
    },
    async update(tabId, options) {
      updatedTabs.push({ tabId, options });
      return { id: tabId, ...options };
    },
    onRemoved: { addListener(listener) { listeners.tabRemoved = listener; } }
  },
  alarms: {
    async create(name, options) { alarms.set(name, options); },
    async clear(name) { return alarms.delete(name); },
    onAlarm: { addListener(listener) { listeners.alarm = listener; } }
  }
};

require("../src/shared/carrier-rules.js");
require("../src/shared/claim-outcome.js");
require("../src/background.js");

function send(message, sender = {}) {
  return new Promise((resolve, reject) => {
    const keepAlive = listeners.message(message, sender, resolve);
    if (keepAlive !== true) reject(new Error(`Message was not handled: ${message.type}`));
  });
}

test("merges new defaults without overwriting existing sender settings", async () => {
  local.senderProfile = { email: "custom@example.com", city: "Paris" };
  local.claimSettings = { autoStatusCheck: false };
  await listeners.installed({ reason: "update" });
  assert.equal(local.senderProfile.email, "custom@example.com");
  assert.equal(local.senderProfile.city, "Paris");
  assert.equal(local.senderProfile.senderType, "part");
  assert.equal(local.senderProfile.contactTitle, "Monsieur");
  assert.equal(local.claimSettings.autoStatusCheck, false);
  assert.equal(local.claimSettings.chronopostStaleHours, 48);
});

test("starts a private La Poste tracking check and arms cleanup", async () => {
  const response = await send({
    type: "CHECK_CARRIER_STATUS",
    carrier: "laposte",
    order: { trackingNumber: "CC000000001FR" }
  }, { tab: { id: 7 } });

  assert.equal(response.ok, true);
  const tab = createdTabs.at(-1);
  assert.equal(tab.active, false);
  assert.match(tab.url, /^https:\/\/www\.laposte\.fr\/outils\/suivre-vos-envois\?code=CC000000001FR/);
  assert.match(tab.url, /#carrier-claim-check=/);
  assert.ok(session[`carrierStatusRequest:${response.requestId}`]);
  assert.equal(session[`carrierStatusTab:${tab.id}`], response.requestId);
  assert.ok(alarms.has(`carrierStatusTimeout:${response.requestId}`));
});

test("returns the carrier result to Amazon and removes temporary state", async () => {
  const requestId = Object.keys(session).find((key) => key.startsWith("carrierStatusRequest:"))?.split(":")[1];
  const request = session[`carrierStatusRequest:${requestId}`];
  const response = await send({
    type: "CARRIER_STATUS_SCRAPED",
    requestId,
    result: { statusText: "En transit" }
  }, { tab: { id: request.checkerTabId } });

  assert.equal(response.ok, true);
  assert.equal(sentMessages.at(-1).tabId, 7);
  assert.equal(sentMessages.at(-1).message.result.carrier, "laposte");
  assert.equal(session[`carrierStatusRequest:${requestId}`], undefined);
  assert.equal(session[`carrierStatusTab:${request.checkerTabId}`], undefined);
  assert.ok(removedTabs.includes(request.checkerTabId));
  assert.equal(alarms.has(`carrierStatusTimeout:${requestId}`), false);
});

test("times out and cleans a carrier tab that never returns a result", async () => {
  const response = await send({
    type: "CHECK_CARRIER_STATUS",
    carrier: "chronopost",
    order: { trackingNumber: "XY123456789FR" }
  }, { tab: { id: 8 } });
  const request = session[`carrierStatusRequest:${response.requestId}`];

  listeners.alarm({ name: `carrierStatusTimeout:${response.requestId}` });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sentMessages.at(-1).tabId, 8);
  assert.match(sentMessages.at(-1).message.result.error, /within one minute/);
  assert.equal(session[`carrierStatusRequest:${response.requestId}`], undefined);
  assert.equal(session[`carrierStatusTab:${request.checkerTabId}`], undefined);
  assert.ok(removedTabs.includes(request.checkerTabId));
});

test("opens the official carrier claim routes with session-only claim data", async () => {
  const chronopostClaim = { carrier: "chronopost", order: { trackingNumber: "XY123" } };
  const chronopost = await send({ type: "OPEN_CARRIER_CLAIM", claim: chronopostClaim });
  assert.equal(chronopost.ok, true);
  assert.deepEqual(session.pendingChronopostClaim, { ...chronopostClaim, sourceTabId: undefined });
  assert.equal(createdTabs.at(-1).url, "https://www.chronopost.fr/service-client-en-ligne/home/iv4.html?lang=fr_FR");
  assert.equal(createdTabs.at(-1).active, true);

  const laposteClaim = { carrier: "laposte", order: { trackingNumber: "CC000000001FR" } };
  const laposte = await send({ type: "OPEN_CARRIER_CLAIM", claim: { ...laposteClaim, executionMode: "automatic" } }, { tab: { id: 42 } });
  assert.equal(laposte.ok, true);
  assert.deepEqual(session.pendingLaPosteClaim, { ...laposteClaim, executionMode: "automatic", sourceTabId: 42 });
  assert.equal(createdTabs.at(-1).url, "https://contact.aide.laposte.fr/kb/guide/fr/formulaire-courrier-colis-55CJ9A5dgN/Steps/4901506");
  assert.equal(createdTabs.at(-1).active, false);
});

test("brokers session-only request and pending-claim data for content scripts", async () => {
  const statusResponse = await send({
    type: "CHECK_CARRIER_STATUS",
    carrier: "laposte",
    order: { trackingNumber: "CC000000001FR" }
  }, { tab: { id: 9 } });
  const lookup = await send({ type: "GET_CARRIER_STATUS_REQUEST", requestId: statusResponse.requestId });
  assert.equal(lookup.ok, true);
  assert.equal(lookup.request.order.trackingNumber, "CC000000001FR");

  const pending = await send({ type: "GET_PENDING_CLAIM", carrier: "laposte" });
  assert.equal(pending.ok, true);
  assert.equal(pending.claim.order.trackingNumber, "CC000000001FR");

  const updatedClaim = { ...pending.claim, reason: "delivered_missing" };
  assert.deepEqual(await send({ type: "UPDATE_PENDING_CLAIM", carrier: "laposte", claim: updatedClaim }), { ok: true });
  assert.equal(session.pendingLaPosteClaim.reason, "delivered_missing");

  const workflow = await send({
    type: "CLAIM_WORKFLOW_STATE",
    carrier: "laposte",
    status: "ready"
  }, { tab: { id: 777 } });
  assert.deepEqual(workflow, { ok: true, foregrounded: true });
  assert.deepEqual(updatedTabs.at(-1), { tabId: 777, options: { active: true } });
  assert.equal(sentMessages.at(-1).tabId, 42);
  assert.equal(sentMessages.at(-1).message.type, "CLAIM_WORKFLOW_STATE");

  assert.deepEqual(await send({ type: "CLEAR_PENDING_CLAIM", carrier: "laposte" }), { ok: true });
  assert.equal(session.pendingLaPosteClaim, undefined);
});

test("stores a successful claim, notifies Amazon, and clears the pending submission", async () => {
  const claim = {
    id: "claim-success-1",
    carrier: "laposte",
    reason: "lost",
    order: { orderId: "111-2222222-3333333", trackingNumber: "CC000000002FR" },
    executionMode: "automatic"
  };
  await send({ type: "OPEN_CARRIER_CLAIM", claim }, { tab: { id: 55 } });
  await send({
    type: "UPDATE_PENDING_CLAIM",
    carrier: "laposte",
    claim: { ...session.pendingLaPosteClaim, submissionStartedAt: "2026-08-24T14:30:00.000Z" }
  });

  const response = await send({
    type: "CLAIM_SUBMISSION_SUCCESS",
    carrier: "laposte",
    claimId: claim.id,
    reference: "LP-8472619",
    confirmationText: "Votre réclamation a bien été prise en compte."
  });

  assert.equal(response.ok, true);
  assert.equal(response.noteSaved, false);
  assert.equal(session.pendingLaPosteClaim, undefined);
  const outcome = local.claimOutcomesByOrder[claim.order.orderId];
  assert.equal(outcome.reference, "LP-8472619");
  assert.equal(outcome.trackingNumber, "CC000000002FR");
  assert.match(outcome.sellerNote, /Référence : LP-8472619/);
  assert.equal(sentMessages.at(-1).tabId, 55);
  assert.equal(sentMessages.at(-1).message.type, "CLAIM_SUBMISSION_SUCCESS");
});

test("audits a page sequentially through one reusable inactive worker tab", async () => {
  const orderId = "111-2222222-3333333";
  const createdBeforeAudit = createdTabs.length;
  const started = await send({
    type: "START_ORDER_AUDIT",
    orderId,
    orderUrl: `https://sellercentral.amazon.fr/orders-v3/order/${orderId}`
  }, { tab: { id: 70 } });

  assert.equal(started.ok, true);
  const detailTab = createdTabs.at(-1);
  assert.equal(detailTab.active, false);
  assert.match(detailTab.url, new RegExp(`/orders-v3/order/${orderId}#carrier-claim-order-audit=`));

  const order = {
    orderId,
    carrier: "Colissimo",
    trackingNumber: "CC000000002FR",
    shipDate: "Fri, 17 Jul 2026",
    deliverBy: "Sat, 25 Jul 2026"
  };
  const details = await send({
    type: "ORDER_AUDIT_DETAILS",
    auditId: started.auditId,
    order
  }, { tab: { id: detailTab.id } });

  assert.equal(details.ok, true);
  assert.ok(details.statusRequestId);
  assert.equal(removedTabs.includes(detailTab.id), false);
  const statusEntry = Object.entries(session).find(([key, value]) =>
    key.startsWith("carrierStatusRequest:") && value.auditId === started.auditId
  );
  assert.ok(statusEntry);
  const [statusKey, statusRequest] = statusEntry;
  assert.equal(statusRequest.checkerTabId, detailTab.id);
  assert.equal(createdTabs.length, createdBeforeAudit + 1);
  assert.ok(updatedTabs.some(({ tabId, options }) => tabId === detailTab.id && /laposte\.fr\/outils\/suivre-vos-envois/.test(options.url)));

  const scraped = await send({
    type: "CARRIER_STATUS_SCRAPED",
    requestId: statusKey.slice("carrierStatusRequest:".length),
    result: { statusText: "Votre Colissimo n'a pas pu vous être remis." }
  }, { tab: { id: statusRequest.checkerTabId } });

  assert.equal(scraped.ok, true);
  const resultMessage = sentMessages.findLast(({ tabId, message }) =>
    tabId === 70 && message.type === "ORDER_AUDIT_RESULT" && message.auditId === started.auditId
  );
  assert.ok(resultMessage);
  assert.equal(resultMessage.message.order.trackingNumber, "CC000000002FR");
  assert.equal(resultMessage.message.result.carrier, "laposte");
  assert.equal(removedTabs.includes(statusRequest.checkerTabId), false);

  const secondOrderId = "444-5555555-6666666";
  const second = await send({
    type: "START_ORDER_AUDIT",
    orderId: secondOrderId,
    orderUrl: `https://sellercentral.amazon.fr/orders-v3/order/${secondOrderId}`
  }, { tab: { id: 70 } });
  assert.equal(second.ok, true);
  assert.equal(createdTabs.length, createdBeforeAudit + 1);
  assert.ok(updatedTabs.some(({ tabId, options }) => tabId === detailTab.id && options.url.includes(`/orders-v3/order/${secondOrderId}`)));

  const unsupported = await send({
    type: "ORDER_AUDIT_DETAILS",
    auditId: second.auditId,
    order: { orderId: secondOrderId, carrier: "Other Carrier", trackingNumber: "OTHER123" }
  }, { tab: { id: detailTab.id } });
  assert.equal(unsupported.completed, true);

  const released = await send({ type: "RELEASE_ORDER_AUDIT_WORKER" }, { tab: { id: 70 } });
  assert.deepEqual(released, { ok: true, released: true });
  assert.equal(session["orderAuditWorker:70"], undefined);
  assert.ok(removedTabs.includes(detailTab.id));
});
