"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const trackingRecords = require("../src/shared/tracking-records.js");
const backgroundSource = fs.readFileSync(require.resolve("../src/background.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ cloud = false } = {}) {
  const local = {
    trackedOrdersByOrder: {},
    claimSettings: { cloudSyncEnabled: cloud, monitorServerUrl: "https://tracking.cheaply.fr", monitorAccessToken: "test-device" }
  };
  const listeners = {};
  const env = { local, fetch: async () => Response.json({ ok: true }) };
  function storageArea(target) {
    return {
      async get(keys) {
        const selected = keys == null ? Object.keys(target) : Array.isArray(keys) ? keys : [keys];
        // Real Chrome returns detached values, not references into the store.
        return structuredClone(Object.fromEntries(selected.filter((key) => key in target).map((key) => [key, target[key]])));
      },
      async set(values) {
        const copy = structuredClone(values);
        await Promise.resolve();
        if (env.failNextSet) { env.failNextSet = false; throw new Error("Storage write failed"); }
        Object.assign(target, copy);
      },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete target[key]; }
    };
  }
  const addListener = { addListener() {} };
  const context = vm.createContext({
    CarrierClaimRules: require("../src/shared/carrier-rules.js"),
    CarrierClaimOutcomeRules: require("../src/shared/claim-outcome.js"),
    CarrierTrackingRecords: trackingRecords,
    chrome: {
      runtime: {
        onInstalled: { addListener(fn) { listeners.installed = fn; } },
        onStartup: addListener, onMessage: addListener,
        getURL(path) { return `chrome-extension://test/${path}`; },
        async openOptionsPage() {}
      },
      storage: { local: storageArea(local), session: storageArea({}) },
      tabs: { onRemoved: addListener },
      alarms: { onAlarm: addListener, async create() {} },
      notifications: { onClicked: addListener, async create() {} }
    },
    crypto, URL, AbortController, setTimeout, clearTimeout,
    fetch: (...args) => env.fetch(...args)
  });
  vm.runInContext(`${backgroundSource}\nglobalThis.testApi = { saveTrackingRecord, syncPendingTrackingRecords, mergeRemoteTrackingRecords, trackedRecords };`, context);
  return { ...env, api: context.testApi, listeners, setFetch(fn) { env.fetch = fn; }, failWrite() { env.failNextSet = true; } };
}

function order(index = 1, sellerAccountId = "merchant-one") {
  return {
    orderId: `403-${String(index).padStart(7, "0")}-8018704`,
    trackingNumber: `CC${String(index).padStart(9, "0")}FR`,
    sellerAccountId, marketplaceId: "A13V1IB3VIYZZH", carrier: "Colissimo",
    recipientName: "Saved recipient", recipientAddress1: "1 rue de Paris"
  };
}

const transit = { statusText: "Votre colis est en transit", checkedAt: "2026-09-01T07:00:00.000Z" };

test("simultaneous registrations retain every order across two Amazon accounts", async () => {
  const { api, local } = fixture();
  const orders = Array.from({ length: 10 }, (_, index) => [order(index + 1), order(index + 1, "merchant-two")]).flat();
  const saved = await Promise.all(orders.map((item) => api.saveTrackingRecord(item, transit)));
  assert.equal(saved.length, 20);
  assert.equal(Object.keys(local.trackedOrdersByOrder).length, 20);
  for (const item of orders) assert.equal(local.trackedOrdersByOrder[trackingRecords.recordKey(item)].trackingNumber, item.trackingNumber);
});

test("slow upload completion cannot replace a concurrent registration, cloud merge, or migration", async () => {
  const env = fixture({ cloud: true });
  const started = deferred();
  const response = deferred();
  const firstOrder = order(1);
  env.setFetch(async (_url, options) => {
    if (JSON.parse(options.body).orderId === firstOrder.orderId) { started.resolve(); return response.promise; }
    return Response.json({ ok: true });
  });
  const first = env.api.saveTrackingRecord(firstOrder, transit);
  await started.promise;
  await Promise.all([
    env.api.saveTrackingRecord(order(2), transit),
    env.api.mergeRemoteTrackingRecords([{ ...order(3), trackingState: "pickup_ready", statusText: "Retour disponible", checkedAt: transit.checkedAt }]),
    env.api.trackedRecords({ refresh: false }),
    env.listeners.installed({ reason: "update" })
  ]);
  response.resolve(Response.json({ ok: true }));
  await first;
  assert.equal(Object.keys(env.local.trackedOrdersByOrder).length, 3);
  assert.equal(env.local.trackedOrdersByOrder[trackingRecords.recordKey(order(3))].trackingState, "pickup_ready");
  assert.ok(env.local.trackedOrdersByOrder[trackingRecords.recordKey(firstOrder)].cloudSyncedAt);
});

test("an old acknowledgement does not mark a newer local version synchronized", async () => {
  const env = fixture({ cloud: true });
  const starts = [deferred(), deferred()];
  const responses = [deferred(), deferred()];
  const uploads = [];
  env.setFetch(async (_url, options) => {
    const index = uploads.length;
    uploads.push(JSON.parse(options.body));
    starts[index].resolve();
    return responses[index].promise;
  });
  const item = order(4);
  const first = env.api.saveTrackingRecord(item, transit);
  await starts[0].promise;
  const newer = env.api.saveTrackingRecord({ ...item, recipientAddress1: "Corrected address" }, {
    statusText: "Retour à l'expéditeur", checkedAt: "2026-09-02T07:00:00.000Z"
  });
  await env.api.trackedRecords({ refresh: false });
  assert.equal(uploads.length, 1, "same-order uploads must remain ordered");
  responses[0].resolve(Response.json({ ok: true }));
  await starts[1].promise;
  const current = env.local.trackedOrdersByOrder[trackingRecords.recordKey(item)];
  assert.equal(current.cloudSyncedAt, "");
  assert.equal(current.trackingState, "returning");
  assert.equal(current.recipientAddress1, "Corrected address");
  responses[1].resolve(Response.json({ error: "Temporary failure" }, { status: 503 }));
  await Promise.all([first, newer]);
  assert.equal(env.local.trackedOrdersByOrder[trackingRecords.recordKey(item)].cloudSyncedAt, "");
  assert.match(env.local.trackedOrdersByOrder[trackingRecords.recordKey(item)].cloudSyncError, /Temporary failure/);
  assert.equal(uploads[1].recipientAddress1, "Corrected address");
});

test("batch sync preserves orders added and statuses merged while its request is pending", async () => {
  const env = fixture();
  await env.api.saveTrackingRecord(order(5), transit);
  env.local.claimSettings.cloudSyncEnabled = true;
  const started = deferred();
  const response = deferred();
  env.setFetch(async (_url, options) => {
    if (JSON.parse(options.body).orderId === order(5).orderId) { started.resolve(); return response.promise; }
    return Response.json({ ok: true });
  });
  const sync = env.api.syncPendingTrackingRecords();
  await started.promise;
  await env.api.saveTrackingRecord(order(6), transit);
  await env.api.mergeRemoteTrackingRecords([{
    ...order(5), trackingState: "resolved", resolvedAt: "2026-09-02T07:00:00.000Z", resolutionNote: "Received in warehouse"
  }]);
  response.resolve(Response.json({ ok: true }));
  const result = await sync;
  assert.equal(Object.keys(env.local.trackedOrdersByOrder).length, 2);
  assert.equal(env.local.trackedOrdersByOrder[trackingRecords.recordKey(order(5))].trackingState, "resolved");
  assert.equal(env.local.trackedOrdersByOrder[trackingRecords.recordKey(order(5))].cloudSyncedAt, "");
  assert.equal(result.remaining, 1, "changed content must remain pending instead of being acknowledged by the stale upload");
});

test("deletion during upload remains suppressed despite queued saves and stale remote results", async () => {
  const env = fixture({ cloud: true });
  const started = deferred();
  const response = deferred();
  let uploads = 0;
  env.setFetch(async () => { uploads += 1; started.resolve(); return response.promise; });
  const item = order(7);
  const first = env.api.saveTrackingRecord(item, transit);
  await started.promise;
  const next = env.api.saveTrackingRecord(item, { statusText: "Colis introuvable", checkedAt: "2026-09-02T07:00:00.000Z" });
  await env.api.trackedRecords({ refresh: false });
  response.resolve(Response.json({ error: "Permanently deleted", deleted: true }, { status: 410 }));
  await Promise.all([first, next]);
  const deletedAt = env.local.trackedOrdersByOrder[trackingRecords.recordKey(item)].cloudDeletedAt;
  assert.ok(deletedAt);
  await env.api.mergeRemoteTrackingRecords([{ ...item, trackingState: "in_transit", cloudDeletedAt: "" }]);
  await env.api.syncPendingTrackingRecords();
  assert.equal(uploads, 1);
  assert.equal(env.local.trackedOrdersByOrder[trackingRecords.recordKey(item)].cloudDeletedAt, deletedAt);
});

test("a physically removed local order is not resurrected by an in-flight acknowledgement", async () => {
  const env = fixture({ cloud: true });
  const started = deferred();
  const response = deferred();
  env.setFetch(async () => { started.resolve(); return response.promise; });
  const item = order(8);
  const save = env.api.saveTrackingRecord(item, transit);
  await started.promise;
  env.local.trackedOrdersByOrder = {};
  response.resolve(Response.json({ ok: true }));
  assert.equal(await save, null);
  assert.equal(Object.keys(env.local.trackedOrdersByOrder).length, 0);
});

test("stale cloud snapshots preserve newer local fields and a discovered seller account", async () => {
  const env = fixture({ cloud: true });
  const item = order(9);
  const local = await env.api.saveTrackingRecord(item, { statusText: "Colis introuvable", checkedAt: "2026-09-02T07:00:00.000Z" });
  await env.api.mergeRemoteTrackingRecords([{
    ...item, sellerAccountId: "sellercentral.amazon.fr", accountId: "sellercentral.amazon.fr",
    recipientName: "Stale recipient", trackingState: "in_transit", statusText: transit.statusText,
    checkedAt: transit.checkedAt, updatedAt: "2026-09-01T07:00:00.000Z"
  }]);
  const saved = env.local.trackedOrdersByOrder[trackingRecords.recordKey(item)];
  assert.equal(Object.keys(env.local.trackedOrdersByOrder).length, 1);
  assert.equal(saved.sellerAccountId, item.sellerAccountId);
  assert.equal(saved.recordId, trackingRecords.recordKey(item));
  assert.equal(saved.recipientName, local.recipientName);
  assert.equal(saved.trackingState, "lost");
  assert.equal(saved.checkedAt, "2026-09-02T07:00:00.000Z");
});

test("a failed write does not poison the storage serialization queue", async () => {
  const env = fixture();
  env.failWrite();
  await assert.rejects(env.api.saveTrackingRecord(order(10), transit), /Storage write failed/);
  await env.api.saveTrackingRecord(order(11), transit);
  assert.equal(Object.keys(env.local.trackedOrdersByOrder).length, 1);
  assert.ok(env.local.trackedOrdersByOrder[trackingRecords.recordKey(order(11))]);
});

test("a newer server reopen clears local resolution, while stale server snapshots cannot undo it", async () => {
  const env = fixture();
  const item = order(12);
  const resolution = {
    ...item, trackingState: "resolved", statusText: "Received", checkedAt: transit.checkedAt,
    resolvedAt: "2026-09-02T07:00:00.000Z", updatedAt: "2026-09-02T07:00:00.000Z", resolutionNote: "Received in warehouse"
  };
  await env.api.mergeRemoteTrackingRecords([resolution]);
  const key = trackingRecords.recordKey(item);
  await env.api.mergeRemoteTrackingRecords([{
    ...item, trackingState: "returning", statusText: "Retour à l'expéditeur", checkedAt: transit.checkedAt,
    resolvedAt: "", updatedAt: "2026-09-01T09:00:00.000Z"
  }]);
  assert.equal(env.local.trackedOrdersByOrder[key].trackingState, "resolved");
  await env.api.mergeRemoteTrackingRecords([{
    ...item, trackingState: "returning", statusText: "Retour à l'expéditeur", checkedAt: transit.checkedAt,
    resolvedAt: "", resolutionNote: "", updatedAt: "2026-09-03T09:00:00.000Z"
  }]);
  assert.equal(env.local.trackedOrdersByOrder[key].trackingState, "returning");
  assert.equal(env.local.trackedOrdersByOrder[key].resolvedAt, "");
  assert.equal(env.local.trackedOrdersByOrder[key].resolutionNote, "");
  await env.api.mergeRemoteTrackingRecords([resolution]);
  assert.equal(env.local.trackedOrdersByOrder[key].trackingState, "returning");
  assert.equal(env.local.trackedOrdersByOrder[key].resolvedAt, "");
});

test("legacy sender-delivery evidence is persisted as an unsynced repair and survives a generic cloud delivery", async () => {
  const env = fixture();
  const item = order(13);
  const key = trackingRecords.recordKey(item);
  env.local.trackedOrdersByOrder[key] = {
    ...item, recordId: key, trackingState: "delivered", statusText: "Retour à l’expéditeur",
    statusCurrentSummary: "Votre Colissimo a été livré à son expéditeur.", checkedAt: transit.checkedAt,
    cloudSyncedAt: transit.checkedAt, cloudSyncRevision: "old-revision"
  };
  await env.api.trackedRecords({ refresh: false });
  let saved = env.local.trackedOrdersByOrder[key];
  assert.equal(saved.trackingState, "returned_delivered");
  assert.equal(saved.cloudSyncedAt, "");
  assert.notEqual(saved.cloudSyncRevision, "old-revision");
  await env.api.mergeRemoteTrackingRecords([{
    ...item, trackingState: "delivered", statusText: "Votre colis est livré.", statusCurrentSummary: "",
    checkedAt: "2026-09-02T07:00:00.000Z", updatedAt: "2026-09-02T07:00:00.000Z"
  }]);
  saved = env.local.trackedOrdersByOrder[key];
  assert.equal(saved.trackingState, "returned_delivered");
  assert.equal(saved.statusCurrentSummary, "Votre Colissimo a été livré à son expéditeur.");
});

test("cloud merges keep a locally confirmed claim reference when the remote sent snapshot is incomplete", async () => {
  const env = fixture();
  const item = order(14);
  await env.api.saveTrackingRecord(item, transit, null, { reference: "COL-91855121", submittedAt: "2026-09-02T08:00:00.000Z" });
  await env.api.mergeRemoteTrackingRecords([{
    ...item, claimStatus: "sent", claimReference: "", claimSubmittedAt: "2026-09-02T08:00:00.000Z"
  }]);
  assert.equal(env.local.trackedOrdersByOrder[trackingRecords.recordKey(item)].claimReference, "COL-91855121");
});
