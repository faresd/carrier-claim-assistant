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
const notifications = [];
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
    onStartup: { addListener(listener) { listeners.startup = listener; } },
    onMessage: { addListener(listener) { listeners.message = listener; } },
    getURL(path) { return `chrome-extension://test/${path}`; },
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
  },
  notifications: {
    async create(id, options) { notifications.push({ id, options }); },
    onClicked: { addListener(listener) { listeners.notificationClicked = listener; } }
  }
};

require("../src/shared/carrier-rules.js");
require("../src/shared/claim-outcome.js");
require("../src/shared/tracking-records.js");
require("../src/background.js");
const trackingRecords = globalThis.CarrierTrackingRecords;

function send(message, sender = {}) {
  return new Promise((resolve, reject) => {
    const keepAlive = listeners.message(message, sender, resolve);
    if (keepAlive !== true) reject(new Error(`Message was not handled: ${message.type}`));
  });
}

test("merges new defaults without overwriting existing sender settings", async () => {
  local.senderProfile = { email: "custom@example.com", city: "Paris" };
  local.claimSettings = {
    autoStatusCheck: false,
    cloudSyncEnabled: true,
    monitorServerUrl: "https://old-monitor.example",
    monitorAccessToken: "old-origin-token"
  };
  await listeners.installed({ reason: "update" });
  assert.equal(local.senderProfile.email, "custom@example.com");
  assert.equal(local.senderProfile.city, "Paris");
  assert.equal(local.senderProfile.senderType, "part");
  assert.equal(local.senderProfile.contactTitle, "Monsieur");
  assert.equal(local.claimSettings.autoStatusCheck, false);
  assert.equal(local.claimSettings.chronopostStaleHours, 48);
  assert.equal(local.claimSettings.cloudSyncEnabled, false);
  assert.equal(local.claimSettings.monitorServerUrl, "https://tracking.cheaply.fr");
  assert.equal(local.claimSettings.monitorAccessToken, "");
  assert.ok(alarms.has("carrierReturnMonitorAlerts"));
});

test("tests a new monitor server before a browser token is paired", async () => {
  const originalFetch = global.fetch;
  let request = null;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, service: "carrier-return-monitor" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const response = await send({ type: "TEST_MONITOR_CONNECTION", serverUrl: "https://tracking.cheaply.fr", token: "" });
    assert.deepEqual(response, { ok: true });
    assert.equal(request.url, "https://tracking.cheaply.fr/api/health");
    assert.equal(request.options.headers.authorization, undefined);
    request = null;
    const rejected = await send({ type: "TEST_MONITOR_CONNECTION", serverUrl: "https://unrelated.example", token: "" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /secure HTTPS monitor server URL/i);
    assert.equal(request, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test("stores a claim-ready order package with sender, recipient, item, and carrier context", async () => {
  local.senderProfile = {
    email: "seller@example.com", phone: "+33102030405", contactFirstName: "Camille", contactLastName: "Martin",
    companyName: "Example SARL", address1: "1 rue de Paris", postalCode: "75001", city: "Paris", country: "France"
  };
  local.claimSettings = { ...local.claimSettings, cloudSyncEnabled: false };
  const response = await send({
    type: "REGISTER_TRACKED_ORDER",
    order: {
      orderId: "333-4444444-5555555", trackingNumber: "CC000000003FR", carrier: "Colissimo",
      productName: "Replacement part", asin: "B000TEST", sku: "SKU-1", quantity: "2", itemValue: "€49.90",
      recipientName: "Monsieur Jean Dupont", recipientAddress1: "2 rue de Lyon", recipientPostalCode: "69001",
      recipientCity: "Lyon", recipientCountry: "France", sellerAccountId: "merchant-one", marketplaceId: "A13V1IB3VIYZZH"
    },
    result: { statusText: "Colis introuvable", checkedAt: "2026-09-01T07:00:00.000Z" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.record.claimPayload.sender.email, "seller@example.com");
  assert.equal(response.record.claimPayload.order.asin, "B000TEST");
  assert.equal(response.record.claimPayload.order.recipientCity, "Lyon");
  assert.equal(response.record.claimPayload.carrier, "laposte");
  assert.match(response.record.claimPayload.details, /CC000000003FR/);
});

test("stores duplicate Amazon order numbers independently for two seller accounts", async () => {
  const orderId = "999-1111111-2222222";
  local.claimSettings = { ...local.claimSettings, cloudSyncEnabled: false };
  const common = { orderId, carrier: "Colissimo", marketplaceId: "A13V1IB3VIYZZH" };
  await send({
    type: "REGISTER_TRACKED_ORDER",
    order: { ...common, sellerAccountId: "merchant-a", trackingNumber: "CC000000011FR" },
    result: { statusText: "Retour à l'expéditeur", checkedAt: "2026-09-01T07:00:00.000Z" }
  });
  await send({
    type: "REGISTER_TRACKED_ORDER",
    order: { ...common, sellerAccountId: "merchant-b", trackingNumber: "CC000000022FR" },
    result: { statusText: "Votre colis a été livré.", checkedAt: "2026-09-01T08:00:00.000Z" }
  });

  const first = trackingRecords.findRecord(local.trackedOrdersByOrder, { ...common, sellerAccountId: "merchant-a" });
  const second = trackingRecords.findRecord(local.trackedOrdersByOrder, { ...common, sellerAccountId: "merchant-b" });
  assert.equal(first.trackingNumber, "CC000000011FR");
  assert.equal(first.trackingState, "returning");
  assert.equal(second.trackingNumber, "CC000000022FR");
  assert.equal(second.trackingState, "delivered");
});

test("pairing immediately backfills cached orders and marks them synchronized", async () => {
  const originalFetch = global.fetch;
  const orderId = "222-3333333-4444444";
  local.trackedOrdersByOrder = {
    [orderId]: {
      recordId: `merchant-one|A13V1IB3VIYZZH|${orderId}`,
      orderId,
      trackingNumber: "CC000000002FR",
      sellerAccountId: "merchant-one",
      marketplaceId: "A13V1IB3VIYZZH"
    }
  };
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/pairing/claim")) {
      return new Response(JSON.stringify({ token: "device-token", deviceId: "device-one", deviceName: "Work Brave" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const response = await send({
      type: "PAIR_MONITOR_DEVICE",
      serverUrl: "https://tracking.cheaply.fr",
      code: "123456",
      deviceName: "Work Brave"
    });
    assert.equal(response.ok, true);
    assert.equal(response.uploadedOrders, 1);
    assert.equal(local.claimSettings.cloudSyncEnabled, true);
    assert.equal(local.claimSettings.monitorAccessToken, "device-token");
    const recordKey = `merchant-one|A13V1IB3VIYZZH|${orderId}`;
    assert.match(local.trackedOrdersByOrder[recordKey].cloudSyncedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(requests.some((request) => request.url === "https://tracking.cheaply.fr/api/orders"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("a revoked device token disables cloud sync without deleting local history", async () => {
  const originalFetch = global.fetch;
  local.claimSettings = {
    ...local.claimSettings,
    cloudSyncEnabled: true,
    monitorServerUrl: "https://tracking.cheaply.fr",
    monitorAccessToken: "revoked-token"
  };
  local.trackedOrdersByOrder = { "111-2222222-3333333": { orderId: "111-2222222-3333333", trackingState: "returning" } };
  global.fetch = async () => new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" }
  });
  try {
    const response = await send({ type: "GET_TRACKED_RECORDS", refresh: true });
    assert.equal(response.ok, true);
    assert.equal(trackingRecords.findRecord(response.records, { orderId: "111-2222222-3333333" }).trackingState, "returning");
    assert.equal(local.claimSettings.cloudSyncEnabled, false);
    assert.equal(local.claimSettings.monitorAccessToken, "");
  } finally {
    global.fetch = originalFetch;
  }
});

test("shows and acknowledges an urgent pickup notification for the paired browser", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  const notificationsBefore = notifications.length;
  const tabsBefore = createdTabs.length;
  const recordId = "merchant-alert|A13V1IB3VIYZZH|402-2797047-3010738";
  const sourceUrl = "https://sellercentral.amazon.fr/orders-v3/order/402-2797047-3010738";
  local.claimSettings = {
    ...local.claimSettings,
    cloudSyncEnabled: true,
    monitorServerUrl: "https://tracking.cheaply.fr",
    monitorAccessToken: "pickup-device-token",
    pickupNotifications: true
  };
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/orders?alerts=1&limit=100")) {
      return Response.json({
        orders: [{
          recordId,
          orderId: "402-2797047-3010738",
          trackingNumber: "8U02230078613",
          trackingState: "pickup_ready",
          statusText: "Votre envoi retourné est disponible au bureau de poste.",
          accountId: "merchant-alert",
          accountName: "Cheaply Returns",
          marketplaceId: "A13V1IB3VIYZZH",
          amazonUrl: sourceUrl
        }]
      });
    }
    return Response.json({ ok: true });
  };

  try {
    const response = await send({ type: "REFRESH_MONITOR_ALERTS" });
    assert.deepEqual(response, { ok: true, count: 1 });
    const notification = notifications.at(-1);
    assert.equal(notifications.length, notificationsBefore + 1);
    assert.equal(notification.id, `return-pickup:${encodeURIComponent(recordId)}`);
    assert.equal(notification.options.title, "Returned package ready for pickup");
    assert.match(notification.options.message, /402-2797047-3010738.*8U02230078613/);
    assert.equal(notification.options.contextMessage, "Cheaply Returns");
    assert.equal(notification.options.requireInteraction, true);

    const acknowledgement = requests.find((request) => request.url.endsWith(`/api/orders/${encodeURIComponent(recordId)}/ack-pickup`));
    assert.ok(acknowledgement);
    assert.equal(acknowledgement.options.method, "POST");
    assert.equal(acknowledgement.options.headers.authorization, "Bearer pickup-device-token");
    assert.equal(trackingRecords.findRecord(local.trackedOrdersByOrder, {
      orderId: "402-2797047-3010738",
      sellerAccountId: "merchant-alert",
      marketplaceId: "A13V1IB3VIYZZH"
    }).trackingState, "pickup_ready");

    listeners.notificationClicked(notification.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(createdTabs.length, tabsBefore + 1);
    assert.equal(createdTabs.at(-1).url, sourceUrl);
    assert.equal(createdTabs.at(-1).active, true);
  } finally {
    global.fetch = originalFetch;
    local.claimSettings = { ...local.claimSettings, cloudSyncEnabled: false, monitorAccessToken: "" };
  }
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
  const outcome = trackingRecords.findRecord(local.claimOutcomesByOrder, claim.order);
  assert.equal(outcome.reference, "LP-8472619");
  assert.equal(outcome.trackingNumber, "CC000000002FR");
  assert.match(outcome.sellerNote, /Référence : LP-8472619/);
  const record = trackingRecords.findRecord(local.trackedOrdersByOrder, claim.order);
  assert.equal(record.claimStatus, "sent");
  assert.equal(record.claimReference, "LP-8472619");
  assert.equal(sentMessages.at(-1).tabId, 55);
  assert.equal(sentMessages.at(-1).message.type, "CLAIM_SUBMISSION_SUCCESS");
});

test("uploads the successful claim reference and sent state to the return monitor", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  local.claimSettings = {
    ...local.claimSettings,
    cloudSyncEnabled: true,
    monitorServerUrl: "https://tracking.cheaply.fr",
    monitorAccessToken: "paired-device-token"
  };
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const claim = {
    id: "claim-cloud-success-1",
    carrier: "chronopost",
    reason: "delayed",
    order: {
      orderId: "305-6121206-6903513",
      trackingNumber: "XY123456789FR",
      sellerAccountId: "merchant-cloud",
      sellerAccountName: "Cheaply France",
      marketplaceId: "A13V1IB3VIYZZH"
    },
    executionMode: "automatic"
  };
  try {
    await send({ type: "OPEN_CARRIER_CLAIM", claim }, { tab: { id: 57 } });
    await send({
      type: "UPDATE_PENDING_CLAIM",
      carrier: "chronopost",
      claim: { ...session.pendingChronopostClaim, submissionStartedAt: "2026-09-01T10:00:00.000Z" }
    });
    const response = await send({
      type: "CLAIM_SUBMISSION_SUCCESS",
      carrier: "chronopost",
      claimId: claim.id,
      reference: "CHR-2026-8472619",
      confirmationText: "Votre demande a bien été transmise."
    });

    assert.equal(response.ok, true);
    const upload = requests.find((request) => request.url === "https://tracking.cheaply.fr/api/orders");
    assert.ok(upload);
    assert.equal(upload.options.headers.authorization, "Bearer paired-device-token");
    const record = JSON.parse(upload.options.body);
    assert.equal(record.orderId, claim.order.orderId);
    assert.equal(record.claimStatus, "sent");
    assert.equal(record.claimReference, "CHR-2026-8472619");
    assert.match(record.claimSubmittedAt, /^\d{4}-\d{2}-\d{2}T/);
    const saved = trackingRecords.findRecord(local.trackedOrdersByOrder, claim.order);
    assert.equal(saved.cloudSyncError, "");
    assert.match(saved.cloudSyncedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    global.fetch = originalFetch;
    local.claimSettings = { ...local.claimSettings, cloudSyncEnabled: false, monitorAccessToken: "" };
  }
});

test("recovers a referenced La Poste confirmation when the final carrier button was clicked directly", async () => {
  const claim = {
    id: "claim-recovery-1",
    carrier: "laposte",
    reason: "lost",
    order: { orderId: "402-2797047-3010738", trackingNumber: "8U02230078613" },
    executionMode: "automatic"
  };
  await send({ type: "OPEN_CARRIER_CLAIM", claim }, { tab: { id: 56 } });

  const response = await send({
    type: "CLAIM_SUBMISSION_SUCCESS",
    carrier: "laposte",
    claimId: claim.id,
    reference: "COL-91855121",
    confirmationText: "Message envoyé !",
    recoveredFromCarrierConfirmation: true
  }, {
    url: "https://contact.aide.laposte.fr/kb/guide/fr/formulaire-courrier-colis/success",
    tab: { id: 156 }
  });

  assert.equal(response.ok, true);
  assert.equal(trackingRecords.findRecord(local.claimOutcomesByOrder, claim.order).reference, "COL-91855121");
  assert.equal(session.pendingLaPosteClaim, undefined);
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
