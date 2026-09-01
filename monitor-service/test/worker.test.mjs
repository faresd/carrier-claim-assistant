import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import monitorWorker, {
  allowedApiOrigin,
  classifyTrackingState,
  enqueueDailyMonitor,
  fetchOfficialTracking,
  monitorHealth,
  normalizeCarrierPayload,
  processTrackingMessage,
  shouldRunMorningMonitor,
  upsertOrder
} from "../src/worker.mjs";
import { csrfTokenForSession, signAuthPayload } from "../src/auth.mjs";

class D1SqliteAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    let parameters = [];
    const bound = {
      bind: (...values) => {
        parameters = values;
        return bound;
      },
      first: async () => statement.get(...parameters) || null,
      all: async () => ({ results: statement.all(...parameters) }),
      run: async () => ({ success: true, meta: statement.run(...parameters) })
    };
    return bound;
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

async function monitorDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  database.exec(await readFile(new URL("../migrations/0002_resolved_deletion_indexes.sql", import.meta.url), "utf8"));
  database.exec(await readFile(new URL("../migrations/0003_deleted_order_tombstones.sql", import.meta.url), "utf8"));
  return { database, db: new D1SqliteAdapter(database) };
}

test("classifies a returned parcel waiting for sender pickup as urgent", () => {
  assert.equal(classifyTrackingState(
    "Votre envoi retourné est disponible au bureau de poste.",
    "Retour à l'expéditeur. Le colis est à retirer au point de retrait."
  ), "pickup_ready");
});

test("does not treat a future return warning as sender pickup", () => {
  assert.equal(classifyTrackingState(
    "Votre colis est disponible au bureau de poste pour le destinataire.",
    "À défaut de retrait avant le 8 septembre, il sera retourné à l'expéditeur."
  ), "unknown");
});

test("keeps return-in-transit and lost parcels in separate queues", () => {
  assert.equal(classifyTrackingState("Votre colis est en retour à l'expéditeur."), "returning");
  assert.equal(classifyTrackingState("Votre colis ne peut plus être localisé."), "lost");
});

test("lets the newest delivered or lost event override older return history", () => {
  assert.equal(classifyTrackingState(
    "Votre colis a été livré.",
    "Votre colis est en retour à l'expéditeur."
  ), "delivered");
  assert.equal(classifyTrackingState(
    "Votre colis ne peut plus être localisé.",
    "Votre colis est en retour à l'expéditeur."
  ), "lost");
});

test("normalizes a Suivi v2 event history", () => {
  const result = normalizeCarrierPayload({ shipment: { event: [
    { date: "2026-08-30T08:00:00Z", label: "Votre colis est en retour à l'expéditeur", code: "RETOUR" },
    { date: "2026-09-01T06:30:00Z", label: "Votre envoi retourné est disponible au bureau de poste", code: "DISPO" }
  ] } });
  assert.equal(result.trackingState, "pickup_ready");
  assert.match(result.statusText, /disponible/i);
  assert.match(result.statusSummary, /retour/i);
});

test("normalizes a delivered latest event even when older history records a return", () => {
  const result = normalizeCarrierPayload({ shipment: { event: [
    { date: "2026-08-30T08:00:00Z", label: "Votre colis est en retour à l'expéditeur", code: "RETOUR" },
    { date: "2026-09-01T06:30:00Z", label: "Votre colis a été livré.", code: "LIVRE" }
  ] } });
  assert.equal(result.trackingState, "delivered");
  assert.match(result.statusText, /livr/i);
});

test("turns a carrier abort into a bounded retryable error", async () => {
  await assert.rejects(
    () => fetchOfficialTracking("8N00000000000", { LAPOSTE_OKAPI_KEY: "test" }, async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }, 1000),
    /timed out after 1 second/i
  );
});

test("runs only during the seven o'clock Paris hour", () => {
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T05:15:00Z")), true);
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T06:15:00Z")), false);
  assert.equal(shouldRunMorningMonitor(new Date("2026-12-01T06:15:00Z")), true);
});

test("allows API CORS only for the production dashboard and real extension origins", async () => {
  const dashboard = new Request("https://tracking.cheaply.fr/api/orders", {
    method: "OPTIONS",
    headers: { origin: "https://tracking.cheaply.fr" }
  });
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const extension = new Request("https://tracking.cheaply.fr/api/orders", {
    method: "OPTIONS",
    headers: { origin: extensionOrigin }
  });
  const untrusted = new Request("https://tracking.cheaply.fr/api/orders", {
    method: "OPTIONS",
    headers: { origin: "https://example.test" }
  });

  assert.equal(allowedApiOrigin(dashboard), "https://tracking.cheaply.fr");
  assert.equal(allowedApiOrigin(extension), extensionOrigin);
  assert.equal(allowedApiOrigin(untrusted), "");

  const dashboardResponse = await monitorWorker.fetch(dashboard, {});
  assert.equal(dashboardResponse.status, 204);
  assert.equal(dashboardResponse.headers.get("access-control-allow-origin"), "https://tracking.cheaply.fr");

  const extensionResponse = await monitorWorker.fetch(extension, {});
  assert.equal(extensionResponse.status, 204);
  assert.equal(extensionResponse.headers.get("access-control-allow-origin"), extensionOrigin);

  const untrustedResponse = await monitorWorker.fetch(untrusted, {});
  assert.equal(untrustedResponse.status, 403);
  assert.equal(untrustedResponse.headers.get("access-control-allow-origin"), null);
});

test("health fails closed until every production binding and schema table is ready", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const request = new Request("https://tracking.cheaply.fr/api/health", {
    headers: { origin: "https://tracking.cheaply.fr" }
  });
  const env = {
    DB: db,
    TRACKING_QUEUE: { async send() {} },
    ASSETS: { async fetch() { return new Response(""); } },
    LAPOSTE_OKAPI_KEY: "test-okapi-key",
    SESSION_SECRET: "test-session-secret-with-at-least-thirty-two-characters",
    TRACKING_CLIENT_SECRET: "test-client-secret-with-at-least-thirty-two-characters"
  };

  const ready = await monitorHealth(env, request);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, service: "carrier-return-monitor", ready: true });
  assert.equal(ready.headers.get("access-control-allow-origin"), "https://tracking.cheaply.fr");

  const missingQueue = await monitorHealth({ ...env, TRACKING_QUEUE: undefined }, request);
  assert.equal(missingQueue.status, 503);
  assert.deepEqual(await missingQueue.json(), { ok: false, service: "carrier-return-monitor", ready: false });

  database.exec("DROP TABLE notification_receipts");
  const incompleteSchema = await monitorHealth(env, request);
  assert.equal(incompleteSchema.status, 503);
  assert.deepEqual(await incompleteSchema.json(), { ok: false, service: "carrier-return-monitor", ready: false });
});

test("a deleted fallback-account order stays deleted after its seller account is discovered", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  await db.prepare(`INSERT INTO deleted_orders (account_id, marketplace_id, order_id, record_id, deleted_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind("default", "A13V1IB3VIYZZH", "111-2222222-3333333", "default|A13V1IB3VIYZZH|111-2222222-3333333", new Date().toISOString()).run();

  await assert.rejects(
    upsertOrder(db, {
      orderId: "111-2222222-3333333",
      trackingNumber: "CC000000002FR",
      sellerAccountId: "merchant-discovered",
      marketplaceId: "A13V1IB3VIYZZH"
    }),
    (error) => error.status === 410 && /permanently deleted/i.test(error.message)
  );
});

test("pairs two browsers, tracks two Amazon accounts, repeats per-device pickup alerts, resolves, and revokes access", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const sessionSecret = "test-session-secret-with-at-least-thirty-two-characters";
  const env = { DB: db, SESSION_SECRET: sessionSecret };
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const adminSession = {
    sub: "admin:owner@example.com", email: "owner@example.com", role: "admin", name: "Owner",
    jti: "worker-integration-session", exp: Math.floor(Date.now() / 1000) + 300
  };
  const adminCookie = `__Host-carrier_monitor_session=${await signAuthPayload(adminSession, sessionSecret)}`;
  const adminCsrf = await csrfTokenForSession(adminSession, sessionSecret);
  const jsonRequest = (path, {
    token = "", body = null, origin = extensionOrigin, method = body == null ? "GET" : "POST", cookie = "", csrf = ""
  } = {}) => new Request(`https://tracking.cheaply.fr${path}`, {
    method,
    headers: {
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(body == null ? {} : { "content-type": "application/json" })
    },
    ...(body == null ? {} : { body: JSON.stringify(body) })
  });
  const createPairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing", {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { deviceName: "Packing desk" }
  }), env);
  assert.equal(createPairingResponse.status, 200);
  const createdPairing = await createPairingResponse.json();
  assert.match(createdPairing.code, /^\d{6}$/);
  const storedPairing = await db.prepare("SELECT code FROM pairing_codes WHERE used_at = ''").first();
  assert.match(storedPairing.code, /^[a-f0-9]{64}$/);
  assert.notEqual(storedPairing.code, createdPairing.code);

  const originlessPairing = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    origin: "",
    body: { code: createdPairing.code, deviceName: "Command-line client" }
  }), env);
  assert.equal(originlessPairing.status, 400);
  assert.match((await originlessPairing.json()).error, /Chrome\/Brave extension/i);

  const websitePairing = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    origin: "https://malicious.invalid",
    body: { code: createdPairing.code, deviceName: "Website" }
  }), env);
  assert.equal(websitePairing.status, 400);
  assert.match((await websitePairing.json()).error, /Chrome\/Brave extension/i);

  const pairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    body: { code: createdPairing.code, deviceName: "Work Brave" }
  }), env);
  assert.equal(pairingResponse.status, 200);
  const pairing = await pairingResponse.json();
  assert.match(pairing.token, /^[A-Za-z0-9]{64}$/);
  assert.equal(pairing.deviceName, "Work Brave");

  const createSecondPairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing", {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { deviceName: "Packing desk two" }
  }), env);
  assert.equal(createSecondPairingResponse.status, 200);
  const createdSecondPairing = await createSecondPairingResponse.json();
  const secondPairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    body: { code: createdSecondPairing.code, deviceName: "Warehouse Chrome" }
  }), env);
  assert.equal(secondPairingResponse.status, 200);
  const secondPairing = await secondPairingResponse.json();
  assert.match(secondPairing.token, /^[A-Za-z0-9]{64}$/);
  assert.notEqual(secondPairing.deviceId, pairing.deviceId);

  const common = {
    marketplaceId: "A13V1IB3VIYZZH",
    carrierId: "laposte",
    carrierLabel: "Colissimo",
    trackingState: "returning",
    checkedAt: "2026-09-01T07:00:00.000Z"
  };
  const firstOrder = {
    ...common,
    orderId: "402-2797047-3010738",
    trackingNumber: "8U02230078613",
    sellerAccountId: "merchant-fr-one",
    sellerAccountName: "Cheaply France"
  };
  const secondOrder = {
    ...common,
    orderId: "408-9133278-8011502",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-fr-two",
    sellerAccountName: "Cheaply Outlet"
  };
  for (const order of [firstOrder, secondOrder]) {
    const response = await monitorWorker.fetch(jsonRequest("/api/orders", { token: pairing.token, body: order }), env);
    assert.equal(response.status, 200);
  }

  const listResponse = await monitorWorker.fetch(jsonRequest("/api/orders?limit=20", { token: pairing.token }), env);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.orders.length, 2);
  assert.deepEqual(new Set(listed.orders.map((order) => order.accountId)), new Set(["merchant-fr-one", "merchant-fr-two"]));

  const pickup = await upsertOrder(db, {
    ...firstOrder,
    trackingState: "pickup_ready",
    statusText: "Votre envoi retourné est disponible au bureau de poste.",
    checkedAt: "2026-09-02T07:00:00.000Z",
    recipientName: "Camille Martin",
    recipientAddress1: "12 rue Exemple",
    recipientPostalCode: "75001",
    recipientCity: "Paris",
    recipientCountry: "France",
    claimPayload: {
      recipientTitle: "Monsieur",
      details: "Initial returned parcel message",
      sender: {
        companyName: "Demo SARL",
        email: "claims@example.com",
        phone: "+33102030405",
        address1: "1 avenue Démo",
        postalCode: "75002",
        city: "Paris",
        country: "France"
      },
      order: { productName: "Synthetic replacement part", asin: "B000DEMO", sku: "DEMO-1", quantity: "1", itemValue: "49,90 €" }
    }
  });
  const alertsResponse = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: pairing.token }), env);
  assert.equal(alertsResponse.status, 200);
  const alerts = await alertsResponse.json();
  assert.equal(alerts.orders.length, 1);
  assert.equal(alerts.orders[0].trackingState, "pickup_ready");

  const acknowledgement = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/ack-pickup`, {
    token: pairing.token,
    body: {}
  }), env);
  assert.equal(acknowledgement.status, 200);
  const acknowledgedAlerts = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: pairing.token }), env);
  assert.deepEqual((await acknowledgedAlerts.json()).orders, []);

  const secondDeviceAlerts = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: secondPairing.token }), env);
  assert.equal((await secondDeviceAlerts.json()).orders.length, 1);

  await db.prepare("UPDATE notification_receipts SET last_notified_at = ? WHERE record_id = ? AND device_id = ?")
    .bind(new Date(Date.now() - 21 * 3600000).toISOString(), pickup.recordId, pairing.deviceId).run();
  const nextDayAlerts = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: pairing.token }), env);
  assert.equal((await nextDayAlerts.json()).orders.length, 1);

  const launchResponse = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/launch-claim`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { reason: "returned", details: "Edited dashboard claim message", recipientTitle: "Madame" }
  }), env);
  assert.equal(launchResponse.status, 200);
  const launch = await launchResponse.json();
  assert.equal(launch.carrier, "laposte");
  assert.match(launch.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  const launchToken = new URL(launch.url).hash.replace("#carrier-claim-launch=", "");
  assert.match(launchToken, /^[A-Za-z0-9]{64}$/);

  const redeemResponse = await monitorWorker.fetch(jsonRequest("/api/claim-launch/redeem", {
    token: pairing.token,
    body: { token: launchToken }
  }), env);
  assert.equal(redeemResponse.status, 200);
  const redeemed = await redeemResponse.json();
  assert.equal(redeemed.claim.reason, "returned");
  assert.equal(redeemed.claim.details, "Edited dashboard claim message");
  assert.equal(redeemed.claim.recipientTitle, "Madame");
  assert.equal(redeemed.claim.sender.email, "claims@example.com");
  assert.equal(redeemed.claim.sender.address1, "1 avenue Démo");
  assert.equal(redeemed.claim.order.recipientName, "Camille Martin");
  assert.equal(redeemed.claim.order.recipientAddress1, "12 rue Exemple");
  assert.equal(redeemed.claim.order.sku, "DEMO-1");

  const repeatedRedemption = await monitorWorker.fetch(jsonRequest("/api/claim-launch/redeem", {
    token: pairing.token,
    body: { token: launchToken }
  }), env);
  assert.equal(repeatedRedemption.status, 400);
  assert.match((await repeatedRedemption.json()).error, /invalid, expired, or already used/i);

  const resolvedResponse = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/resolve`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { note: "Returned parcel physically received" }
  }), env);
  assert.equal(resolvedResponse.status, 200);
  assert.equal((await resolvedResponse.json()).order.trackingState, "resolved");
  const resolvedList = await monitorWorker.fetch(jsonRequest("/api/orders?view=resolved&limit=20", {
    cookie: adminCookie,
    origin: "https://tracking.cheaply.fr"
  }), env);
  assert.equal((await resolvedList.json()).orders.length, 1);

  const exportResponse = await monitorWorker.fetch(jsonRequest("/api/export?resource=orders&limit=500&offset=0", {
    cookie: adminCookie,
    origin: "https://tracking.cheaply.fr"
  }), env);
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json();
  assert.equal(exported.resource, "orders");
  assert.equal(exported.rows.length, 2);
  const exportedPickup = exported.rows.find((order) => order.recordId === pickup.recordId);
  assert.equal(exportedPickup.claimPayload.sender.email, "claims@example.com");
  assert.equal(exportedPickup.claimPayload.order.sku, "DEMO-1");
  assert.equal("devices" in exported, false);

  const deviceExport = await monitorWorker.fetch(jsonRequest("/api/export?resource=devices", {
    cookie: adminCookie,
    origin: "https://tracking.cheaply.fr"
  }), env);
  assert.equal(deviceExport.status, 400);

  const activeRecordId = `${secondOrder.sellerAccountId}|${secondOrder.marketplaceId}|${secondOrder.orderId}`;
  const activeDeletion = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(activeRecordId)}/delete`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: {}
  }), env);
  assert.equal(activeDeletion.status, 400);
  assert.match((await activeDeletion.json()).error, /only a resolved order/i);

  const extensionDeletion = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/delete`, {
    token: secondPairing.token,
    body: {}
  }), env);
  assert.equal(extensionDeletion.status, 403);

  const deletion = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/delete`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: {}
  }), env);
  assert.equal(deletion.status, 200);
  assert.equal((await deletion.json()).recordId, pickup.recordId);
  assert.equal(await db.prepare("SELECT record_id FROM orders WHERE record_id = ?").bind(pickup.recordId).first(), null);
  const tombstone = await db.prepare("SELECT * FROM deleted_orders WHERE record_id = ?").bind(pickup.recordId).first();
  assert.deepEqual(Object.keys(tombstone).sort(), ["account_id", "deleted_at", "marketplace_id", "order_id", "record_id"]);
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import monitorWorker, {
  allowedApiOrigin,
  classifyTrackingState,
  enqueueDailyMonitor,
  fetchOfficialTracking,
  monitorHealth,
  normalizeCarrierPayload,
  processTrackingMessage,
  shouldRunMorningMonitor,
  upsertOrder
} from "../src/worker.mjs";
import { csrfTokenForSession, signAuthPayload } from "../src/auth.mjs";

class D1SqliteAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    let parameters = [];
    const bound = {
      bind: (...values) => {
        parameters = values;
        return bound;
      },
      first: async () => statement.get(...parameters) || null,
      all: async () => ({ results: statement.all(...parameters) }),
      run: async () => ({ success: true, meta: statement.run(...parameters) })
    };
    return bound;
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

async function monitorDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  database.exec(await readFile(new URL("../migrations/0002_resolved_deletion_indexes.sql", import.meta.url), "utf8"));
  database.exec(await readFile(new URL("../migrations/0003_deleted_order_tombstones.sql", import.meta.url), "utf8"));
  return { database, db: new D1SqliteAdapter(database) };
}

test("classifies a returned parcel waiting for sender pickup as urgent", () => {
  assert.equal(classifyTrackingState(
    "Votre envoi retourné est disponible au bureau de poste.",
    "Retour à l'expéditeur. Le colis est à retirer au point de retrait."
  ), "pickup_ready");
});

test("does not treat a future return warning as sender pickup", () => {
  assert.equal(classifyTrackingState(
    "Votre colis est disponible au bureau de poste pour le destinataire.",
    "À défaut de retrait avant le 8 septembre, il sera retourné à l'expéditeur."
  ), "unknown");
});

test("keeps return-in-transit and lost parcels in separate queues", () => {
  assert.equal(classifyTrackingState("Votre colis est en retour à l'expéditeur."), "returning");
  assert.equal(classifyTrackingState("Votre colis ne peut plus être localisé."), "lost");
});

test("lets the newest delivered or lost event override older return history", () => {
  assert.equal(classifyTrackingState(
    "Votre colis a été livré.",
    "Votre colis est en retour à l'expéditeur."
  ), "delivered");
  assert.equal(classifyTrackingState(
    "Votre colis ne peut plus être localisé.",
    "Votre colis est en retour à l'expéditeur."
  ), "lost");
});

test("normalizes a Suivi v2 event history", () => {
  const result = normalizeCarrierPayload({ shipment: { event: [
    { date: "2026-08-30T08:00:00Z", label: "Votre colis est en retour à l'expéditeur", code: "RETOUR" },
    { date: "2026-09-01T06:30:00Z", label: "Votre envoi retourné est disponible au bureau de poste", code: "DISPO" }
  ] } });
  assert.equal(result.trackingState, "pickup_ready");
  assert.match(result.statusText, /disponible/i);
  assert.match(result.statusSummary, /retour/i);
});

test("normalizes a delivered latest event even when older history records a return", () => {
  const result = normalizeCarrierPayload({ shipment: { event: [
    { date: "2026-08-30T08:00:00Z", label: "Votre colis est en retour à l'expéditeur", code: "RETOUR" },
    { date: "2026-09-01T06:30:00Z", label: "Votre colis a été livré.", code: "LIVRE" }
  ] } });
  assert.equal(result.trackingState, "delivered");
  assert.match(result.statusText, /livr/i);
});

test("turns a carrier abort into a bounded retryable error", async () => {
  await assert.rejects(
    () => fetchOfficialTracking("8N00000000000", { LAPOSTE_OKAPI_KEY: "test" }, async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }, 1000),
    /timed out after 1 second/i
  );
});

test("runs only during the seven o'clock Paris hour", () => {
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T05:15:00Z")), true);
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T06:15:00Z")), false);
  assert.equal(shouldRunMorningMonitor(new Date("2026-12-01T06:15:00Z")), true);
});

test("allows API CORS only for the production dashboard and real extension origins", async () => {
  const dashboard = new Request("https://tracking.cheaply.fr/api/orders", {
    method: "OPTIONS",
    headers: { origin: "https://tracking.cheaply.fr" }
  });
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const extension = new Request("https://tracking.cheaply.fr/api/orders", {
    method: "OPTIONS",
    headers: { origin: extensionOrigin }
  });
  const untrusted = new Request("https://tracking.cheaply.fr/api/orders", {
    method: "OPTIONS",
    headers: { origin: "https://example.test" }
  });

  assert.equal(allowedApiOrigin(dashboard), "https://tracking.cheaply.fr");
  assert.equal(allowedApiOrigin(extension), extensionOrigin);
  assert.equal(allowedApiOrigin(untrusted), "");

  const dashboardResponse = await monitorWorker.fetch(dashboard, {});
  assert.equal(dashboardResponse.status, 204);
  assert.equal(dashboardResponse.headers.get("access-control-allow-origin"), "https://tracking.cheaply.fr");

  const extensionResponse = await monitorWorker.fetch(extension, {});
  assert.equal(extensionResponse.status, 204);
  assert.equal(extensionResponse.headers.get("access-control-allow-origin"), extensionOrigin);

  const untrustedResponse = await monitorWorker.fetch(untrusted, {});
  assert.equal(untrustedResponse.status, 403);
  assert.equal(untrustedResponse.headers.get("access-control-allow-origin"), null);
});

test("health fails closed until every production binding and schema table is ready", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const request = new Request("https://tracking.cheaply.fr/api/health", {
    headers: { origin: "https://tracking.cheaply.fr" }
  });
  const env = {
    DB: db,
    TRACKING_QUEUE: { async send() {} },
    ASSETS: { async fetch() { return new Response(""); } },
    LAPOSTE_OKAPI_KEY: "test-okapi-key",
    SESSION_SECRET: "test-session-secret-with-at-least-thirty-two-characters",
    TRACKING_CLIENT_SECRET: "test-client-secret-with-at-least-thirty-two-characters"
  };

  const ready = await monitorHealth(env, request);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, service: "carrier-return-monitor", ready: true });
  assert.equal(ready.headers.get("access-control-allow-origin"), "https://tracking.cheaply.fr");

  const missingQueue = await monitorHealth({ ...env, TRACKING_QUEUE: undefined }, request);
  assert.equal(missingQueue.status, 503);
  assert.deepEqual(await missingQueue.json(), { ok: false, service: "carrier-return-monitor", ready: false });

  database.exec("DROP TABLE notification_receipts");
  const incompleteSchema = await monitorHealth(env, request);
  assert.equal(incompleteSchema.status, 503);
  assert.deepEqual(await incompleteSchema.json(), { ok: false, service: "carrier-return-monitor", ready: false });
});

test("a deleted fallback-account order stays deleted after its seller account is discovered", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  await db.prepare(`INSERT INTO deleted_orders (account_id, marketplace_id, order_id, record_id, deleted_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind("default", "A13V1IB3VIYZZH", "111-2222222-3333333", "default|A13V1IB3VIYZZH|111-2222222-3333333", new Date().toISOString()).run();

  await assert.rejects(
    upsertOrder(db, {
      orderId: "111-2222222-3333333",
      trackingNumber: "CC000000002FR",
      sellerAccountId: "merchant-discovered",
      marketplaceId: "A13V1IB3VIYZZH"
    }),
    (error) => error.status === 410 && /permanently deleted/i.test(error.message)
  );
});

test("pairs two browsers, tracks two Amazon accounts, repeats per-device pickup alerts, resolves, and revokes access", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const sessionSecret = "test-session-secret-with-at-least-thirty-two-characters";
  const env = { DB: db, SESSION_SECRET: sessionSecret };
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const adminSession = {
    sub: "admin:owner@example.com", email: "owner@example.com", role: "admin", name: "Owner",
    jti: "worker-integration-session", exp: Math.floor(Date.now() / 1000) + 300
  };
  const adminCookie = `__Host-carrier_monitor_session=${await signAuthPayload(adminSession, sessionSecret)}`;
  const adminCsrf = await csrfTokenForSession(adminSession, sessionSecret);
  const jsonRequest = (path, {
    token = "", body = null, origin = extensionOrigin, method = body == null ? "GET" : "POST", cookie = "", csrf = ""
  } = {}) => new Request(`https://tracking.cheaply.fr${path}`, {
    method,
    headers: {
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(body == null ? {} : { "content-type": "application/json" })
    },
    ...(body == null ? {} : { body: JSON.stringify(body) })
  });
  const createPairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing", {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { deviceName: "Packing desk" }
  }), env);
  assert.equal(createPairingResponse.status, 200);
  const createdPairing = await createPairingResponse.json();
  assert.match(createdPairing.code, /^\d{6}$/);
  const storedPairing = await db.prepare("SELECT code FROM pairing_codes WHERE used_at = ''").first();
  assert.match(storedPairing.code, /^[a-f0-9]{64}$/);
  assert.notEqual(storedPairing.code, createdPairing.code);

  const originlessPairing = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    origin: "",
    body: { code: createdPairing.code, deviceName: "Command-line client" }
  }), env);
  assert.equal(originlessPairing.status, 400);
  assert.match((await originlessPairing.json()).error, /Chrome\/Brave extension/i);

  const websitePairing = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    origin: "https://malicious.invalid",
    body: { code: createdPairing.code, deviceName: "Website" }
  }), env);
  assert.equal(websitePairing.status, 400);
  assert.match((await websitePairing.json()).error, /Chrome\/Brave extension/i);

  const pairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    body: { code: createdPairing.code, deviceName: "Work Brave" }
  }), env);
  assert.equal(pairingResponse.status, 200);
  const pairing = await pairingResponse.json();
  assert.match(pairing.token, /^[A-Za-z0-9]{64}$/);
  assert.equal(pairing.deviceName, "Work Brave");

  const createSecondPairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing", {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { deviceName: "Packing desk two" }
  }), env);
  assert.equal(createSecondPairingResponse.status, 200);
  const createdSecondPairing = await createSecondPairingResponse.json();
  const secondPairingResponse = await monitorWorker.fetch(jsonRequest("/api/pairing/claim", {
    body: { code: createdSecondPairing.code, deviceName: "Warehouse Chrome" }
  }), env);
  assert.equal(secondPairingResponse.status, 200);
  const secondPairing = await secondPairingResponse.json();
  assert.match(secondPairing.token, /^[A-Za-z0-9]{64}$/);
  assert.notEqual(secondPairing.deviceId, pairing.deviceId);

  const common = {
    marketplaceId: "A13V1IB3VIYZZH",
    carrierId: "laposte",
    carrierLabel: "Colissimo",
    trackingState: "returning",
    checkedAt: "2026-09-01T07:00:00.000Z"
  };
  const firstOrder = {
    ...common,
    orderId: "402-2797047-3010738",
    trackingNumber: "8U02230078613",
    sellerAccountId: "merchant-fr-one",
    sellerAccountName: "Cheaply France"
  };
  const secondOrder = {
    ...common,
    orderId: "408-9133278-8011502",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-fr-two",
    sellerAccountName: "Cheaply Outlet"
  };
  for (const order of [firstOrder, secondOrder]) {
    const response = await monitorWorker.fetch(jsonRequest("/api/orders", { token: pairing.token, body: order }), env);
    assert.equal(response.status, 200);
  }

  const listResponse = await monitorWorker.fetch(jsonRequest("/api/orders?limit=20", { token: pairing.token }), env);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.orders.length, 2);
  assert.deepEqual(new Set(listed.orders.map((order) => order.accountId)), new Set(["merchant-fr-one", "merchant-fr-two"]));

  const pickup = await upsertOrder(db, {
    ...firstOrder,
    trackingState: "pickup_ready",
    statusText: "Votre envoi retourné est disponible au bureau de poste.",
    checkedAt: "2026-09-02T07:00:00.000Z",
    recipientName: "Camille Martin",
    recipientAddress1: "12 rue Exemple",
    recipientPostalCode: "75001",
    recipientCity: "Paris",
    recipientCountry: "France",
    claimPayload: {
      recipientTitle: "Monsieur",
      details: "Initial returned parcel message",
      sender: {
        companyName: "Demo SARL",
        email: "claims@example.com",
        phone: "+33102030405",
        address1: "1 avenue Démo",
        postalCode: "75002",
        city: "Paris",
        country: "France"
      },
      order: { productName: "Synthetic replacement part", asin: "B000DEMO", sku: "DEMO-1", quantity: "1", itemValue: "49,90 €" }
    }
  });
  const alertsResponse = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: pairing.token }), env);
  assert.equal(alertsResponse.status, 200);
  const alerts = await alertsResponse.json();
  assert.equal(alerts.orders.length, 1);
  assert.equal(alerts.orders[0].trackingState, "pickup_ready");

  const acknowledgement = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/ack-pickup`, {
    token: pairing.token,
    body: {}
  }), env);
  assert.equal(acknowledgement.status, 200);
  const acknowledgedAlerts = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: pairing.token }), env);
  assert.deepEqual((await acknowledgedAlerts.json()).orders, []);

  const secondDeviceAlerts = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: secondPairing.token }), env);
  assert.equal((await secondDeviceAlerts.json()).orders.length, 1);

  await db.prepare("UPDATE notification_receipts SET last_notified_at = ? WHERE record_id = ? AND device_id = ?")
    .bind(new Date(Date.now() - 21 * 3600000).toISOString(), pickup.recordId, pairing.deviceId).run();
  const nextDayAlerts = await monitorWorker.fetch(jsonRequest("/api/orders?alerts=1&limit=20", { token: pairing.token }), env);
  assert.equal((await nextDayAlerts.json()).orders.length, 1);

  const launchResponse = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/launch-claim`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { reason: "returned", details: "Edited dashboard claim message", recipientTitle: "Madame" }
  }), env);
  assert.equal(launchResponse.status, 200);
  const launch = await launchResponse.json();
  assert.equal(launch.carrier, "laposte");
  assert.match(launch.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  const launchToken = new URL(launch.url).hash.replace("#carrier-claim-launch=", "");
  assert.match(launchToken, /^[A-Za-z0-9]{64}$/);

  const redeemResponse = await monitorWorker.fetch(jsonRequest("/api/claim-launch/redeem", {
    token: pairing.token,
    body: { token: launchToken }
  }), env);
  assert.equal(redeemResponse.status, 200);
  const redeemed = await redeemResponse.json();
  assert.equal(redeemed.claim.reason, "returned");
  assert.equal(redeemed.claim.details, "Edited dashboard claim message");
  assert.equal(redeemed.claim.recipientTitle, "Madame");
  assert.equal(redeemed.claim.sender.email, "claims@example.com");
  assert.equal(redeemed.claim.sender.address1, "1 avenue Démo");
  assert.equal(redeemed.claim.order.recipientName, "Camille Martin");
  assert.equal(redeemed.claim.order.recipientAddress1, "12 rue Exemple");
  assert.equal(redeemed.claim.order.sku, "DEMO-1");

  const repeatedRedemption = await monitorWorker.fetch(jsonRequest("/api/claim-launch/redeem", {
    token: pairing.token,
    body: { token: launchToken }
  }), env);
  assert.equal(repeatedRedemption.status, 400);
  assert.match((await repeatedRedemption.json()).error, /invalid, expired, or already used/i);

  const resolvedResponse = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/resolve`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: { note: "Returned parcel physically received" }
  }), env);
  assert.equal(resolvedResponse.status, 200);
  assert.equal((await resolvedResponse.json()).order.trackingState, "resolved");
  const resolvedList = await monitorWorker.fetch(jsonRequest("/api/orders?view=resolved&limit=20", {
    cookie: adminCookie,
    origin: "https://tracking.cheaply.fr"
  }), env);
  assert.equal((await resolvedList.json()).orders.length, 1);

  const exportResponse = await monitorWorker.fetch(jsonRequest("/api/export?resource=orders&limit=500&offset=0", {
    cookie: adminCookie,
    origin: "https://tracking.cheaply.fr"
  }), env);
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json();
  assert.equal(exported.resource, "orders");
  assert.equal(exported.rows.length, 2);
  const exportedPickup = exported.rows.find((order) => order.recordId === pickup.recordId);
  assert.equal(exportedPickup.claimPayload.sender.email, "claims@example.com");
  assert.equal(exportedPickup.claimPayload.order.sku, "DEMO-1");
  assert.equal("devices" in exported, false);

  const deviceExport = await monitorWorker.fetch(jsonRequest("/api/export?resource=devices", {
    cookie: adminCookie,
    origin: "https://tracking.cheaply.fr"
  }), env);
  assert.equal(deviceExport.status, 400);

  const activeRecordId = `${secondOrder.sellerAccountId}|${secondOrder.marketplaceId}|${secondOrder.orderId}`;
  const activeDeletion = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(activeRecordId)}/delete`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: {}
  }), env);
  assert.equal(activeDeletion.status, 400);
  assert.match((await activeDeletion.json()).error, /only a resolved order/i);

  const extensionDeletion = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/delete`, {
    token: secondPairing.token,
    body: {}
  }), env);
  assert.equal(extensionDeletion.status, 403);

  const deletion = await monitorWorker.fetch(jsonRequest(`/api/orders/${encodeURIComponent(pickup.recordId)}/delete`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: {}
  }), env);
  assert.equal(deletion.status, 200);
  assert.equal((await deletion.json()).recordId, pickup.recordId);
  assert.equal(await db.prepare("SELECT record_id FROM orders WHERE record_id = ?").bind(pickup.recordId).first(), null);
  const tombstone = await db.prepare("SELECT * FROM deleted_orders WHERE record_id = ?").bind(pickup.recordId).first();
  assert.deepEqual(Object.keys(tombstone).sort(), ["account_id", "deleted_at", "marketplace_id", "order_id", "record_id"]);
  assert.equal(tombstone.account_id, firstOrder.sellerAccountId);
  assert.equal(tombstone.marketplace_id, firstOrder.marketplaceId);
  assert.equal(tombstone.order_id, firstOrder.orderId);
  assert.equal("tracking_number" in tombstone, false);

  const staleBrowserUpload = await monitorWorker.fetch(jsonRequest("/api/orders", {
    token: pairing.token,
    body: { ...firstOrder, trackingState: "returning" }
  }), env);
  assert.equal(staleBrowserUpload.status, 410);
  assert.equal((await staleBrowserUpload.json()).deleted, true);
  assert.equal(await db.prepare("SELECT record_id FROM orders WHERE record_id = ?").bind(pickup.recordId).first(), null);

  const ambiguousCachedUpload = await monitorWorker.fetch(jsonRequest("/api/orders", {
    token: pairing.token,
    body: { ...firstOrder, sellerAccountId: "default", trackingState: "returning" }
  }), env);
  assert.equal(ambiguousCachedUpload.status, 410);
  assert.equal((await ambiguousCachedUpload.json()).deleted, true);

  const otherAccountSameOrder = await monitorWorker.fetch(jsonRequest("/api/orders", {
    token: secondPairing.token,
    body: { ...firstOrder, sellerAccountId: "merchant-fr-three", trackingNumber: "8U02230079999" }
  }), env);
  assert.equal(otherAccountSameOrder.status, 200);
  assert.equal((await otherAccountSameOrder.json()).order.accountId, "merchant-fr-three");

  const revokeResponse = await monitorWorker.fetch(jsonRequest(`/api/devices/${encodeURIComponent(pairing.deviceId)}/revoke`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: {}
  }), env);
  assert.equal(revokeResponse.status, 200);
  const revokedResponse = await monitorWorker.fetch(jsonRequest("/api/orders?limit=20", { token: pairing.token }), env);
  assert.equal(revokedResponse.status, 401);
});

test("runs one idempotent morning queue through Suivi v2 and stores pickup and delivered history", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const queued = [];
  const env = {
    DB: db,
    LAPOSTE_OKAPI_KEY: "okapi-test-key",
    TRACKING_QUEUE: {
      async sendBatch(messages) {
        queued.push(...messages);
      }
    }
  };
  await upsertOrder(db, {
    orderId: "402-2797047-3010738",
    trackingNumber: "8U02230078613",
    sellerAccountId: "merchant-one",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "returning"
  });
  await upsertOrder(db, {
    orderId: "408-9133278-8011502",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-two",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "in_transit"
  });

  const runDate = new Date("2026-09-01T05:05:00.000Z");
  const run = await enqueueDailyMonitor(env, runDate);
  assert.equal(run.runDate, "2026-09-01");
  assert.equal(run.queuedCount, 2);
  assert.equal(queued.length, 2);

  const fetchImpl = async (url, options) => {
    assert.match(url, /^https:\/\/api\.laposte\.fr\/suivi\/v2\/idships\//);
    assert.equal(options.headers["X-Okapi-Key"], "okapi-test-key");
    const trackingNumber = decodeURIComponent(new URL(url).pathname.split("/").pop());
    const event = trackingNumber === "8U02230078613"
      ? { date: "2026-09-01T05:15:00.000Z", label: "Votre envoi retourné est disponible au bureau de poste.", code: "DISPO_RETOUR" }
      : { date: "2026-09-01T05:16:00.000Z", label: "Votre colis a été livré.", code: "LIVRE" };
    return Response.json({ returnCode: 200, shipment: { event: [event] } });
  };
  for (const queuedMessage of queued) {
    let acknowledged = false;
    let retried = false;
    await processTrackingMessage({
      body: queuedMessage.body,
      ack() { acknowledged = true; },
      retry() { retried = true; }
    }, env, { fetchImpl });
    assert.equal(acknowledged, true);
    assert.equal(retried, false);
  }

  const states = database.prepare("SELECT tracking_number, tracking_state FROM orders ORDER BY tracking_number").all()
    .map((row) => ({ ...row }));
  assert.deepEqual(states, [
    { tracking_number: "8U02230078613", tracking_state: "pickup_ready" },
    { tracking_number: "CC105961572FR", tracking_state: "delivered" }
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tracking_events").get().count, 2);
  const completedRun = database.prepare("SELECT processed_count, checked_count, error_count, completed_at FROM monitor_runs").get();
  assert.equal(completedRun.processed_count, 2);
  assert.equal(completedRun.checked_count, 2);
  assert.equal(completedRun.error_count, 0);
  assert.notEqual(completedRun.completed_at, "");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs WHERE status = 'completed'").get().count, 2);

  const repeated = await enqueueDailyMonitor(env, new Date("2026-09-01T05:45:00.000Z"));
  assert.deepEqual(repeated, { skipped: true, reason: "already-run", runDate: "2026-09-01" });
  assert.equal(queued.length, 2);
});

test("resumes only undispatched morning jobs after a queue interruption", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  let dispatchAttempts = 0;
  const queued = [];
  const env = {
    DB: db,
    LAPOSTE_OKAPI_KEY: "okapi-test-key",
    TRACKING_QUEUE: {
      async sendBatch(messages) {
        dispatchAttempts += 1;
        if (dispatchAttempts === 1) throw new Error("Temporary queue outage");
        queued.push(...messages);
      }
    }
  };
  for (const [orderId, trackingNumber] of [
    ["111-1111111-1111111", "CC000000001FR"],
    ["222-2222222-2222222", "CC000000002FR"]
  ]) {
    await upsertOrder(db, {
      orderId,
      trackingNumber,
      sellerAccountId: "merchant-resume",
      marketplaceId: "A13V1IB3VIYZZH",
      trackingState: "in_transit"
    });
  }

  const runDate = new Date("2026-09-04T05:05:00.000Z");
  await assert.rejects(() => enqueueDailyMonitor(env, runDate), /Temporary queue outage/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs WHERE status = 'queued'").get().count, 2);

  const resumed = await enqueueDailyMonitor(env, new Date("2026-09-04T05:20:00.000Z"));
  assert.deepEqual(resumed, { skipped: false, resumed: true, runDate: "2026-09-04", queuedCount: 2 });
  assert.equal(queued.length, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs WHERE status = 'dispatched'").get().count, 2);

  let retries = 0;
  await processTrackingMessage({
    body: queued[0].body,
    ack() { throw new Error("A temporary carrier failure must not be acknowledged."); },
    retry() { retries += 1; }
  }, env, { fetchImpl: async () => { throw new Error("Temporary Okapi outage"); } });
  assert.equal(retries, 1);
  assert.equal(database.prepare("SELECT status FROM monitor_jobs WHERE record_id = ?").get(queued[0].body.recordId).status, "retrying");

  const dispatchedBeforeSafetyTrigger = queued.length;
  const safetyTrigger = await enqueueDailyMonitor(env, new Date("2026-09-04T05:35:00.000Z"));
  assert.deepEqual(safetyTrigger, { skipped: false, resumed: true, runDate: "2026-09-04", queuedCount: 0 });
  assert.equal(queued.length, dispatchedBeforeSafetyTrigger);
});

test("keeps a known pickup state through ambiguous tracking and preserves carrier evidence on API failure", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const queued = [];
  const env = {
    DB: db,
    LAPOSTE_OKAPI_KEY: "okapi-test-key",
    TRACKING_QUEUE: { async sendBatch(messages) { queued.push(...messages); } }
  };
  await upsertOrder(db, {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY123456789FR",
    sellerAccountId: "merchant-resilient",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "pickup_ready",
    statusText: "Votre envoi retourné est disponible au bureau de poste.",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });

  await enqueueDailyMonitor(env, new Date("2026-09-02T05:05:00.000Z"));
  const morningMessage = queued.shift();
  let morningAcknowledged = false;
  await processTrackingMessage({
    body: morningMessage.body,
    ack() { morningAcknowledged = true; },
    retry() { throw new Error("Ambiguous successful responses must not retry."); }
  }, env, {
    fetchImpl: async () => Response.json({
      returnCode: 200,
      shipment: { event: [{ date: "2026-09-02T05:10:00.000Z", label: "Information prochainement disponible.", code: "INFO" }] }
    })
  });
  assert.equal(morningAcknowledged, true);
  let stored = database.prepare("SELECT tracking_state, status_text FROM orders").get();
  assert.equal(stored.tracking_state, "pickup_ready");
  assert.match(stored.status_text, /prochainement disponible/i);

  await enqueueDailyMonitor(env, new Date("2026-09-03T05:05:00.000Z"));
  const failedMessage = queued.shift();
  let retries = 0;
  let acknowledged = false;
  const queueMessage = {
    body: failedMessage.body,
    ack() { acknowledged = true; },
    retry() { retries += 1; }
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await processTrackingMessage(queueMessage, env, { fetchImpl: async () => { throw new Error("Temporary Okapi outage"); } });
  }
  assert.equal(retries, 3);
  assert.equal(acknowledged, true);
  stored = database.prepare("SELECT tracking_state, status_text FROM orders").get();
  assert.equal(stored.tracking_state, "pickup_ready");
  assert.match(stored.status_text, /prochainement disponible/i);
  const failedJob = database.prepare("SELECT status, attempts, last_error FROM monitor_jobs WHERE run_date = '2026-09-03'").get();
  assert.equal(failedJob.status, "failed");
  assert.equal(failedJob.attempts, 4);
  assert.match(failedJob.last_error, /Temporary Okapi outage/);
});

test("does not let an older browser upload hide a newer pickup-required result", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "402-2797047-3010738",
    trackingNumber: "8U02230078613",
    sellerAccountId: "merchant-one",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    trackingState: "pickup_ready",
    statusText: "Votre envoi retourné est disponible au bureau de poste.",
    statusSummary: "Retour à l'expéditeur · disponible au bureau de poste",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });
  await upsertOrder(db, {
    ...identity,
    trackingState: "in_transit",
    statusText: "Votre colis est en cours d'acheminement.",
    statusSummary: "Pris en charge · en transit",
    checkedAt: "2026-08-31T18:00:00.000Z"
  });

  const row = database.prepare("SELECT tracking_state, status_text, status_summary, checked_at FROM orders").get();
  assert.equal(row.tracking_state, "pickup_ready");
  assert.match(row.status_text, /disponible/i);
  assert.match(row.status_summary, /retour/i);
  assert.equal(row.checked_at, "2026-09-01T07:00:00.000Z");
});

test("accepts a newer carrier snapshot but keeps delivered terminal forever", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "403-7918938-7771545",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-two",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    trackingState: "returning",
    statusText: "Retour à l'expéditeur.",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });
  await upsertOrder(db, {
    ...identity,
    trackingState: "delivered",
    statusText: "Votre colis a été livré.",
    checkedAt: "2026-09-01T08:00:00.000Z"
  });
  await upsertOrder(db, {
    ...identity,
    trackingState: "in_transit",
    statusText: "Ancienne information en transit.",
    checkedAt: "2026-09-02T09:00:00.000Z"
  });

  const row = database.prepare("SELECT tracking_state, status_text, checked_at FROM orders").get();
  assert.equal(row.tracking_state, "delivered");
  assert.match(row.status_text, /livr/i);
  assert.equal(row.checked_at, "2026-09-01T08:00:00.000Z");
});

test("moves an early fallback record into the discovered Amazon seller account without duplicating it", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const orderId = "408-9133278-8011502";
  const marketplaceId = "A13V1IB3VIYZZH";
  const initial = await upsertOrder(db, {
    orderId,
    trackingNumber: "XY123456789FR",
    sellerAccountId: "sellercentral.amazon.fr",
    marketplaceId,
    trackingState: "returning",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });
  const enriched = await upsertOrder(db, {
    orderId,
    trackingNumber: "XY123456789FR",
    sellerAccountId: "amzn1.merchant.o.A19A98AEOKAGHS",
    sellerAccountName: "Cheaply France",
    marketplaceId,
    trackingState: "pickup_ready",
    checkedAt: "2026-09-02T07:00:00.000Z"
  });
  const repeated = await upsertOrder(db, {
    orderId,
    trackingNumber: "XY123456789FR",
    sellerAccountId: "amzn1.merchant.o.A19A98AEOKAGHS",
    sellerAccountName: "Cheaply France",
    marketplaceId,
    trackingState: "pickup_ready",
    checkedAt: "2026-09-03T07:00:00.000Z"
  });

  const rows = database.prepare("SELECT record_id, account_id, account_name, tracking_state FROM orders").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, initial.recordId);
  assert.equal(enriched.recordId, initial.recordId);
  assert.equal(repeated.recordId, initial.recordId);
  assert.equal(rows[0].account_id, "amzn1.merchant.o.A19A98AEOKAGHS");
  assert.equal(rows[0].account_name, "Cheaply France");
  assert.equal(rows[0].tracking_state, "pickup_ready");
  assert.deepEqual(
    database.prepare("SELECT account_id FROM seller_accounts ORDER BY account_id").all().map((row) => row.account_id),
    ["amzn1.merchant.o.A19A98AEOKAGHS"]
  );
});

test("keeps a complete claim package when another browser uploads blank sender fields", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY123456789FR",
    sellerAccountId: "merchant-claim-package",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    claimPayload: {
      details: "Initial claim message",
      sender: { email: "claims@example.com", phone: "+33102030405", address1: "1 rue de Paris", city: "Paris" },
      order: { sku: "SKU-1", quantity: "1" }
    }
  });
  await upsertOrder(db, {
    ...identity,
    claimPayload: {
      details: "Updated claim message",
      sender: { email: "", phone: "", address1: "", city: "" },
      order: { sku: "", quantity: "2" }
    }
  });

  const payload = JSON.parse(database.prepare("SELECT claim_payload FROM orders").get().claim_payload);
  assert.equal(payload.details, "Updated claim message");
  assert.equal(payload.sender.email, "claims@example.com");
  assert.equal(payload.sender.address1, "1 rue de Paris");
  assert.equal(payload.order.sku, "SKU-1");
  assert.equal(payload.order.quantity, "2");
});

test("validates uploaded workflow states and preserves the contents-missing claim reason", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "404-6709725-6157921",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-enums",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    trackingState: "invented-state",
    claimReason: "invented-reason",
    claimStatus: "invented-status"
  });
  let row = database.prepare("SELECT tracking_state, claim_reason, claim_status FROM orders").get();
  assert.equal(row.tracking_state, "unknown");
  assert.equal(row.claim_reason, "other");
  assert.equal(row.claim_status, "none");

  await upsertOrder(db, { ...identity, claimReason: "contents_missing", claimStatus: "requested" });
  row = database.prepare("SELECT claim_reason, claim_status FROM orders").get();
  assert.equal(row.claim_reason, "contents_missing");
  assert.equal(row.claim_status, "requested");
});

test("stores only a matching Amazon Seller Central order URL", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY123456789FR",
    sellerAccountId: "merchant-safe-url",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, { ...identity, sourceUrl: "javascript:alert(document.domain)" });
  assert.equal(database.prepare("SELECT amazon_url FROM orders").get().amazon_url, "");

  const valid = "https://sellercentral.amazon.fr/orders-v3/order/405-4311026-6542766?mons_sel_mcid=merchant-safe-url#temporary-marker";
  await upsertOrder(db, { ...identity, sourceUrl: valid });
  const stored = database.prepare("SELECT amazon_url FROM orders").get().amazon_url;
  assert.equal(stored, "https://sellercentral.amazon.fr/orders-v3/order/405-4311026-6542766?mons_sel_mcid=merchant-safe-url");

  await upsertOrder(db, {
    ...identity,
    sourceUrl: "https://sellercentral.amazon.fr/orders-v3/order/111-2222222-3333333"
  });
  assert.equal(database.prepare("SELECT amazon_url FROM orders").get().amazon_url, stored);
});

test("browser uploads cannot resolve or re-resolve an administrator-reopened order", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const order = {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY000000003FR",
    sellerAccountId: "merchant-resolution",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "pickup_ready",
    checkedAt: "2026-09-01T07:00:00.000Z"
  };
  await upsertOrder(db, order);

  await upsertOrder(db, {
    ...order,
    trackingState: "resolved",
    resolvedAt: "2026-09-02T08:00:00.000Z",
    resolutionNote: "Stale browser resolution",
    checkedAt: "2026-09-02T08:00:00.000Z"
  });

  const row = await db.prepare("SELECT tracking_state, resolved_at, resolution_note FROM orders WHERE order_id = ?")
    .bind(order.orderId).first();
  assert.equal(row.tracking_state, "pickup_ready");
  assert.equal(row.resolved_at, "");
  assert.equal(row.resolution_note, "");
});
  assert.equal(tombstone.account_id, firstOrder.sellerAccountId);
  assert.equal(tombstone.marketplace_id, firstOrder.marketplaceId);
  assert.equal(tombstone.order_id, firstOrder.orderId);
  assert.equal("tracking_number" in tombstone, false);

  const staleBrowserUpload = await monitorWorker.fetch(jsonRequest("/api/orders", {
    token: pairing.token,
    body: { ...firstOrder, trackingState: "returning" }
  }), env);
  assert.equal(staleBrowserUpload.status, 410);
  assert.equal((await staleBrowserUpload.json()).deleted, true);
  assert.equal(await db.prepare("SELECT record_id FROM orders WHERE record_id = ?").bind(pickup.recordId).first(), null);

  const ambiguousCachedUpload = await monitorWorker.fetch(jsonRequest("/api/orders", {
    token: pairing.token,
    body: { ...firstOrder, sellerAccountId: "default", trackingState: "returning" }
  }), env);
  assert.equal(ambiguousCachedUpload.status, 410);
  assert.equal((await ambiguousCachedUpload.json()).deleted, true);

  const otherAccountSameOrder = await monitorWorker.fetch(jsonRequest("/api/orders", {
    token: secondPairing.token,
    body: { ...firstOrder, sellerAccountId: "merchant-fr-three", trackingNumber: "8U02230079999" }
  }), env);
  assert.equal(otherAccountSameOrder.status, 200);
  assert.equal((await otherAccountSameOrder.json()).order.accountId, "merchant-fr-three");

  const revokeResponse = await monitorWorker.fetch(jsonRequest(`/api/devices/${encodeURIComponent(pairing.deviceId)}/revoke`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://tracking.cheaply.fr",
    body: {}
  }), env);
  assert.equal(revokeResponse.status, 200);
  const revokedResponse = await monitorWorker.fetch(jsonRequest("/api/orders?limit=20", { token: pairing.token }), env);
  assert.equal(revokedResponse.status, 401);
});

test("runs one idempotent morning queue through Suivi v2 and stores pickup and delivered history", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const queued = [];
  const env = {
    DB: db,
    LAPOSTE_OKAPI_KEY: "okapi-test-key",
    TRACKING_QUEUE: {
      async sendBatch(messages) {
        queued.push(...messages);
      }
    }
  };
  await upsertOrder(db, {
    orderId: "402-2797047-3010738",
    trackingNumber: "8U02230078613",
    sellerAccountId: "merchant-one",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "returning"
  });
  await upsertOrder(db, {
    orderId: "408-9133278-8011502",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-two",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "in_transit"
  });

  const runDate = new Date("2026-09-01T05:05:00.000Z");
  const run = await enqueueDailyMonitor(env, runDate);
  assert.equal(run.runDate, "2026-09-01");
  assert.equal(run.queuedCount, 2);
  assert.equal(queued.length, 2);

  const fetchImpl = async (url, options) => {
    assert.match(url, /^https:\/\/api\.laposte\.fr\/suivi\/v2\/idships\//);
    assert.equal(options.headers["X-Okapi-Key"], "okapi-test-key");
    const trackingNumber = decodeURIComponent(new URL(url).pathname.split("/").pop());
    const event = trackingNumber === "8U02230078613"
      ? { date: "2026-09-01T05:15:00.000Z", label: "Votre envoi retourné est disponible au bureau de poste.", code: "DISPO_RETOUR" }
      : { date: "2026-09-01T05:16:00.000Z", label: "Votre colis a été livré.", code: "LIVRE" };
    return Response.json({ returnCode: 200, shipment: { event: [event] } });
  };
  for (const queuedMessage of queued) {
    let acknowledged = false;
    let retried = false;
    await processTrackingMessage({
      body: queuedMessage.body,
      ack() { acknowledged = true; },
      retry() { retried = true; }
    }, env, { fetchImpl });
    assert.equal(acknowledged, true);
    assert.equal(retried, false);
  }

  const states = database.prepare("SELECT tracking_number, tracking_state FROM orders ORDER BY tracking_number").all()
    .map((row) => ({ ...row }));
  assert.deepEqual(states, [
    { tracking_number: "8U02230078613", tracking_state: "pickup_ready" },
    { tracking_number: "CC105961572FR", tracking_state: "delivered" }
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tracking_events").get().count, 2);
  const completedRun = database.prepare("SELECT processed_count, checked_count, error_count, completed_at FROM monitor_runs").get();
  assert.equal(completedRun.processed_count, 2);
  assert.equal(completedRun.checked_count, 2);
  assert.equal(completedRun.error_count, 0);
  assert.notEqual(completedRun.completed_at, "");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs WHERE status = 'completed'").get().count, 2);

  const repeated = await enqueueDailyMonitor(env, new Date("2026-09-01T05:45:00.000Z"));
  assert.deepEqual(repeated, { skipped: true, reason: "already-run", runDate: "2026-09-01" });
  assert.equal(queued.length, 2);
});

test("resumes only undispatched morning jobs after a queue interruption", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  let dispatchAttempts = 0;
  const queued = [];
  const env = {
    DB: db,
    LAPOSTE_OKAPI_KEY: "okapi-test-key",
    TRACKING_QUEUE: {
      async sendBatch(messages) {
        dispatchAttempts += 1;
        if (dispatchAttempts === 1) throw new Error("Temporary queue outage");
        queued.push(...messages);
      }
    }
  };
  for (const [orderId, trackingNumber] of [
    ["111-1111111-1111111", "CC000000001FR"],
    ["222-2222222-2222222", "CC000000002FR"]
  ]) {
    await upsertOrder(db, {
      orderId,
      trackingNumber,
      sellerAccountId: "merchant-resume",
      marketplaceId: "A13V1IB3VIYZZH",
      trackingState: "in_transit"
    });
  }

  const runDate = new Date("2026-09-04T05:05:00.000Z");
  await assert.rejects(() => enqueueDailyMonitor(env, runDate), /Temporary queue outage/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs WHERE status = 'queued'").get().count, 2);

  const resumed = await enqueueDailyMonitor(env, new Date("2026-09-04T05:20:00.000Z"));
  assert.deepEqual(resumed, { skipped: false, resumed: true, runDate: "2026-09-04", queuedCount: 2 });
  assert.equal(queued.length, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs WHERE status = 'dispatched'").get().count, 2);

  let retries = 0;
  await processTrackingMessage({
    body: queued[0].body,
    ack() { throw new Error("A temporary carrier failure must not be acknowledged."); },
    retry() { retries += 1; }
  }, env, { fetchImpl: async () => { throw new Error("Temporary Okapi outage"); } });
  assert.equal(retries, 1);
  assert.equal(database.prepare("SELECT status FROM monitor_jobs WHERE record_id = ?").get(queued[0].body.recordId).status, "retrying");

  const dispatchedBeforeSafetyTrigger = queued.length;
  const safetyTrigger = await enqueueDailyMonitor(env, new Date("2026-09-04T05:35:00.000Z"));
  assert.deepEqual(safetyTrigger, { skipped: false, resumed: true, runDate: "2026-09-04", queuedCount: 0 });
  assert.equal(queued.length, dispatchedBeforeSafetyTrigger);
});

test("keeps a known pickup state through ambiguous tracking and preserves carrier evidence on API failure", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const queued = [];
  const env = {
    DB: db,
    LAPOSTE_OKAPI_KEY: "okapi-test-key",
    TRACKING_QUEUE: { async sendBatch(messages) { queued.push(...messages); } }
  };
  await upsertOrder(db, {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY123456789FR",
    sellerAccountId: "merchant-resilient",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "pickup_ready",
    statusText: "Votre envoi retourné est disponible au bureau de poste.",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });

  await enqueueDailyMonitor(env, new Date("2026-09-02T05:05:00.000Z"));
  const morningMessage = queued.shift();
  let morningAcknowledged = false;
  await processTrackingMessage({
    body: morningMessage.body,
    ack() { morningAcknowledged = true; },
    retry() { throw new Error("Ambiguous successful responses must not retry."); }
  }, env, {
    fetchImpl: async () => Response.json({
      returnCode: 200,
      shipment: { event: [{ date: "2026-09-02T05:10:00.000Z", label: "Information prochainement disponible.", code: "INFO" }] }
    })
  });
  assert.equal(morningAcknowledged, true);
  let stored = database.prepare("SELECT tracking_state, status_text FROM orders").get();
  assert.equal(stored.tracking_state, "pickup_ready");
  assert.match(stored.status_text, /prochainement disponible/i);

  await enqueueDailyMonitor(env, new Date("2026-09-03T05:05:00.000Z"));
  const failedMessage = queued.shift();
  let retries = 0;
  let acknowledged = false;
  const queueMessage = {
    body: failedMessage.body,
    ack() { acknowledged = true; },
    retry() { retries += 1; }
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await processTrackingMessage(queueMessage, env, { fetchImpl: async () => { throw new Error("Temporary Okapi outage"); } });
  }
  assert.equal(retries, 3);
  assert.equal(acknowledged, true);
  stored = database.prepare("SELECT tracking_state, status_text FROM orders").get();
  assert.equal(stored.tracking_state, "pickup_ready");
  assert.match(stored.status_text, /prochainement disponible/i);
  const failedJob = database.prepare("SELECT status, attempts, last_error FROM monitor_jobs WHERE run_date = '2026-09-03'").get();
  assert.equal(failedJob.status, "failed");
  assert.equal(failedJob.attempts, 4);
  assert.match(failedJob.last_error, /Temporary Okapi outage/);
});

test("does not let an older browser upload hide a newer pickup-required result", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "402-2797047-3010738",
    trackingNumber: "8U02230078613",
    sellerAccountId: "merchant-one",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    trackingState: "pickup_ready",
    statusText: "Votre envoi retourné est disponible au bureau de poste.",
    statusSummary: "Retour à l'expéditeur · disponible au bureau de poste",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });
  await upsertOrder(db, {
    ...identity,
    trackingState: "in_transit",
    statusText: "Votre colis est en cours d'acheminement.",
    statusSummary: "Pris en charge · en transit",
    checkedAt: "2026-08-31T18:00:00.000Z"
  });

  const row = database.prepare("SELECT tracking_state, status_text, status_summary, checked_at FROM orders").get();
  assert.equal(row.tracking_state, "pickup_ready");
  assert.match(row.status_text, /disponible/i);
  assert.match(row.status_summary, /retour/i);
  assert.equal(row.checked_at, "2026-09-01T07:00:00.000Z");
});

test("accepts a newer carrier snapshot but keeps delivered terminal forever", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "403-7918938-7771545",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-two",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    trackingState: "returning",
    statusText: "Retour à l'expéditeur.",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });
  await upsertOrder(db, {
    ...identity,
    trackingState: "delivered",
    statusText: "Votre colis a été livré.",
    checkedAt: "2026-09-01T08:00:00.000Z"
  });
  await upsertOrder(db, {
    ...identity,
    trackingState: "in_transit",
    statusText: "Ancienne information en transit.",
    checkedAt: "2026-09-02T09:00:00.000Z"
  });

  const row = database.prepare("SELECT tracking_state, status_text, checked_at FROM orders").get();
  assert.equal(row.tracking_state, "delivered");
  assert.match(row.status_text, /livr/i);
  assert.equal(row.checked_at, "2026-09-01T08:00:00.000Z");
});

test("moves an early fallback record into the discovered Amazon seller account without duplicating it", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const orderId = "408-9133278-8011502";
  const marketplaceId = "A13V1IB3VIYZZH";
  const initial = await upsertOrder(db, {
    orderId,
    trackingNumber: "XY123456789FR",
    sellerAccountId: "sellercentral.amazon.fr",
    marketplaceId,
    trackingState: "returning",
    checkedAt: "2026-09-01T07:00:00.000Z"
  });
  const enriched = await upsertOrder(db, {
    orderId,
    trackingNumber: "XY123456789FR",
    sellerAccountId: "amzn1.merchant.o.A19A98AEOKAGHS",
    sellerAccountName: "Cheaply France",
    marketplaceId,
    trackingState: "pickup_ready",
    checkedAt: "2026-09-02T07:00:00.000Z"
  });
  const repeated = await upsertOrder(db, {
    orderId,
    trackingNumber: "XY123456789FR",
    sellerAccountId: "amzn1.merchant.o.A19A98AEOKAGHS",
    sellerAccountName: "Cheaply France",
    marketplaceId,
    trackingState: "pickup_ready",
    checkedAt: "2026-09-03T07:00:00.000Z"
  });

  const rows = database.prepare("SELECT record_id, account_id, account_name, tracking_state FROM orders").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, initial.recordId);
  assert.equal(enriched.recordId, initial.recordId);
  assert.equal(repeated.recordId, initial.recordId);
  assert.equal(rows[0].account_id, "amzn1.merchant.o.A19A98AEOKAGHS");
  assert.equal(rows[0].account_name, "Cheaply France");
  assert.equal(rows[0].tracking_state, "pickup_ready");
  assert.deepEqual(
    database.prepare("SELECT account_id FROM seller_accounts ORDER BY account_id").all().map((row) => row.account_id),
    ["amzn1.merchant.o.A19A98AEOKAGHS"]
  );
});

test("keeps a complete claim package when another browser uploads blank sender fields", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY123456789FR",
    sellerAccountId: "merchant-claim-package",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    claimPayload: {
      details: "Initial claim message",
      sender: { email: "claims@example.com", phone: "+33102030405", address1: "1 rue de Paris", city: "Paris" },
      order: { sku: "SKU-1", quantity: "1" }
    }
  });
  await upsertOrder(db, {
    ...identity,
    claimPayload: {
      details: "Updated claim message",
      sender: { email: "", phone: "", address1: "", city: "" },
      order: { sku: "", quantity: "2" }
    }
  });

  const payload = JSON.parse(database.prepare("SELECT claim_payload FROM orders").get().claim_payload);
  assert.equal(payload.details, "Updated claim message");
  assert.equal(payload.sender.email, "claims@example.com");
  assert.equal(payload.sender.address1, "1 rue de Paris");
  assert.equal(payload.order.sku, "SKU-1");
  assert.equal(payload.order.quantity, "2");
});

test("validates uploaded workflow states and preserves the contents-missing claim reason", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "404-6709725-6157921",
    trackingNumber: "CC105961572FR",
    sellerAccountId: "merchant-enums",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, {
    ...identity,
    trackingState: "invented-state",
    claimReason: "invented-reason",
    claimStatus: "invented-status"
  });
  let row = database.prepare("SELECT tracking_state, claim_reason, claim_status FROM orders").get();
  assert.equal(row.tracking_state, "unknown");
  assert.equal(row.claim_reason, "other");
  assert.equal(row.claim_status, "none");

  await upsertOrder(db, { ...identity, claimReason: "contents_missing", claimStatus: "requested" });
  row = database.prepare("SELECT claim_reason, claim_status FROM orders").get();
  assert.equal(row.claim_reason, "contents_missing");
  assert.equal(row.claim_status, "requested");
});

test("stores only a matching Amazon Seller Central order URL", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const identity = {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY123456789FR",
    sellerAccountId: "merchant-safe-url",
    marketplaceId: "A13V1IB3VIYZZH"
  };
  await upsertOrder(db, { ...identity, sourceUrl: "javascript:alert(document.domain)" });
  assert.equal(database.prepare("SELECT amazon_url FROM orders").get().amazon_url, "");

  const valid = "https://sellercentral.amazon.fr/orders-v3/order/405-4311026-6542766?mons_sel_mcid=merchant-safe-url#temporary-marker";
  await upsertOrder(db, { ...identity, sourceUrl: valid });
  const stored = database.prepare("SELECT amazon_url FROM orders").get().amazon_url;
  assert.equal(stored, "https://sellercentral.amazon.fr/orders-v3/order/405-4311026-6542766?mons_sel_mcid=merchant-safe-url");

  await upsertOrder(db, {
    ...identity,
    sourceUrl: "https://sellercentral.amazon.fr/orders-v3/order/111-2222222-3333333"
  });
  assert.equal(database.prepare("SELECT amazon_url FROM orders").get().amazon_url, stored);
});

test("browser uploads cannot resolve or re-resolve an administrator-reopened order", async (context) => {
  const { database, db } = await monitorDatabase();
  context.after(() => database.close());
  const order = {
    orderId: "405-4311026-6542766",
    trackingNumber: "XY000000003FR",
    sellerAccountId: "merchant-resolution",
    marketplaceId: "A13V1IB3VIYZZH",
    trackingState: "pickup_ready",
    checkedAt: "2026-09-01T07:00:00.000Z"
  };
  await upsertOrder(db, order);

  await upsertOrder(db, {
    ...order,
    trackingState: "resolved",
    resolvedAt: "2026-09-02T08:00:00.000Z",
    resolutionNote: "Stale browser resolution",
    checkedAt: "2026-09-02T08:00:00.000Z"
  });

  const row = await db.prepare("SELECT tracking_state, resolved_at, resolution_note FROM orders WHERE order_id = ?")
    .bind(order.orderId).first();
  assert.equal(row.tracking_state, "pickup_ready");
  assert.equal(row.resolved_at, "");
  assert.equal(row.resolution_note, "");
});
