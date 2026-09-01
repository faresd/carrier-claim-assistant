import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { classifyTrackingState, normalizeCarrierPayload, shouldRunMorningMonitor, upsertOrder } from "../src/worker.mjs";

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
}

async function monitorDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  return { database, db: new D1SqliteAdapter(database) };
}

test("classifies a returned parcel waiting for sender pickup as urgent", () => {
  assert.equal(classifyTrackingState(
    "Votre envoi retourné est disponible au bureau de poste.",
    "Retour à l'expéditeur. Le colis est à retirer au point de retrait."
  ), "pickup_ready");
});

test("keeps return-in-transit and lost parcels in separate queues", () => {
  assert.equal(classifyTrackingState("Votre colis est en retour à l'expéditeur."), "returning");
  assert.equal(classifyTrackingState("Votre colis ne peut plus être localisé."), "lost");
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

test("runs only during the seven o'clock Paris hour", () => {
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T05:15:00Z")), true);
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T06:15:00Z")), false);
  assert.equal(shouldRunMorningMonitor(new Date("2026-12-01T06:15:00Z")), true);
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

  const rows = database.prepare("SELECT record_id, account_id, account_name, tracking_state FROM orders").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, initial.recordId);
  assert.equal(enriched.recordId, initial.recordId);
  assert.equal(rows[0].account_id, "amzn1.merchant.o.A19A98AEOKAGHS");
  assert.equal(rows[0].account_name, "Cheaply France");
  assert.equal(rows[0].tracking_state, "pickup_ready");
  assert.deepEqual(
    database.prepare("SELECT account_id FROM seller_accounts ORDER BY account_id").all().map((row) => row.account_id),
    ["amzn1.merchant.o.A19A98AEOKAGHS"]
  );
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
