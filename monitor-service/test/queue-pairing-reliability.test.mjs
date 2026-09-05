import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker, { enqueueDailyMonitor } from "../src/worker.mjs";

// Use actual SQLite statements and D1's transactional batch semantics. Yield
// between requests, but never between statements inside a committed batch.
class TransactionalD1 {
  constructor(database) {
    this.database = database;
    this.beforeBatch = null;
    this.failAfterStatement = null;
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    let values = [];
    const bound = {
      sql,
      bind(...parameters) { values = parameters; return bound; },
      execute: () => ({ success: true, meta: statement.run(...values) }),
      first: async () => { await Promise.resolve(); return statement.get(...values) || null; },
      all: async () => { await Promise.resolve(); return { results: statement.all(...values) }; },
      run: async () => { await Promise.resolve(); return bound.execute(); }
    };
    return bound;
  }

  async batch(statements) {
    if (this.beforeBatch) await this.beforeBatch(statements);
    await Promise.resolve();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement, index) => {
        const result = statement.execute();
        if (this.failAfterStatement?.(statement, index)) throw new Error("Injected transaction failure");
        return result;
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function fixture(context) {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(await readFile(new URL(file, directory), "utf8"));
  }
  return { database, db: new TransactionalD1(database) };
}

function seedOrders(database, count) {
  const insert = database.prepare(`INSERT INTO orders
    (record_id, account_id, account_name, marketplace_id, order_id, tracking_number, tracking_state, first_seen_at, updated_at)
    VALUES (?, 'merchant', 'Cheaply', 'FR', ?, ?, 'in_transit', ?, ?)`);
  for (let index = 0; index < count; index += 1) {
    insert.run(`record-${index}`, `400-${String(index).padStart(7, "0")}-1234567`,
      `CC${String(index).padStart(9, "0")}FR`, "2026-09-05T04:00:00.000Z", "2026-09-05T04:00:00.000Z");
  }
}

test("recovers every parcel after the first dispatch of a 205-order morning run fails", async (context) => {
  const { database, db } = await fixture(context);
  seedOrders(database, 205);
  const queued = [];
  let failDispatch = true;
  const env = { DB: db, TRACKING_QUEUE: { async sendBatch(messages) {
    if (failDispatch) throw new Error("Temporary queue outage");
    queued.push(...messages);
  } } };

  await assert.rejects(enqueueDailyMonitor(env, new Date("2026-09-05T05:00:00.000Z")), /queue outage/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs").get().count, 205);
  failDispatch = false;
  const resumed = await enqueueDailyMonitor(env, new Date("2026-09-05T05:15:00.000Z"));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.queuedCount, 205);
  assert.equal(queued.length, 205);
  assert.equal(new Set(queued.map((message) => message.body.recordId)).size, 205);
  assert.equal(database.prepare("SELECT queued_count FROM monitor_runs").get().queued_count, 205);

  await enqueueDailyMonitor(env, new Date("2026-09-05T05:30:00.000Z"));
  assert.equal(queued.length, 205, "another morning trigger does not resend dispatched jobs");
});

test("repairs a legacy run with only its first 100 jobs without resetting in-flight jobs", async (context) => {
  const { database, db } = await fixture(context);
  seedOrders(database, 205);
  database.exec(`INSERT INTO monitor_runs (run_date, started_at, queued_count)
    VALUES ('2026-09-05', '2026-09-05T05:00:00.000Z', 205);
    INSERT INTO monitor_jobs (run_date, record_id, status, attempts, created_at, updated_at)
    SELECT '2026-09-05', record_id, 'dispatched', 0, '2026-09-05T05:00:00.000Z', '2026-09-05T05:00:00.000Z'
    FROM orders LIMIT 100;
    UPDATE monitor_jobs SET status = 'retrying', attempts = 2 WHERE record_id = 'record-0';`);
  const queued = [];
  const env = { DB: db, TRACKING_QUEUE: { async sendBatch(messages) { queued.push(...messages); } } };
  const resumed = await enqueueDailyMonitor(env, new Date("2026-09-05T05:15:00.000Z"));
  assert.equal(resumed.queuedCount, 105);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs").get().count, 205);
  assert.equal(queued.length, 105);
  assert.equal(database.prepare("SELECT attempts FROM monitor_jobs WHERE record_id = 'record-0'").get().attempts, 2);
  assert.equal(database.prepare("SELECT status FROM monitor_jobs WHERE record_id = 'record-0'").get().status, "retrying");
});

test("a failed job-initialization transaction leaves no partial run and safely retries", async (context) => {
  const { database, db } = await fixture(context);
  seedOrders(database, 205);
  const queued = [];
  const env = { DB: db, TRACKING_QUEUE: { async sendBatch(messages) { queued.push(...messages); } } };
  db.failAfterStatement = (statement) => statement.sql.includes("INSERT OR IGNORE INTO monitor_jobs");
  await assert.rejects(enqueueDailyMonitor(env, new Date("2026-09-05T05:00:00.000Z")), /transaction failure/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_runs").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monitor_jobs").get().count, 0);
  assert.equal(queued.length, 0);
  db.failAfterStatement = null;
  await enqueueDailyMonitor(env, new Date("2026-09-05T05:15:00.000Z"));
  assert.equal(queued.length, 205);
});

test("morning checks include delivered-back returns until receipt is confirmed and exclude terminal orders", async (context) => {
  const { database, db } = await fixture(context);
  seedOrders(database, 4);
  database.exec(`UPDATE orders SET tracking_state = 'delivered' WHERE record_id = 'record-0';
    UPDATE orders SET tracking_state = 'resolved' WHERE record_id = 'record-1';
    UPDATE orders SET tracking_state = 'returned_delivered' WHERE record_id = 'record-2';`);
  const queued = [];
  const env = { DB: db, TRACKING_QUEUE: { async sendBatch(messages) { queued.push(...messages); } } };
  await enqueueDailyMonitor(env, new Date("2026-09-05T05:00:00.000Z"));
  assert.deepEqual(queued.map((message) => message.body.recordId).sort(), ["record-2", "record-3"]);
});

const SESSION_SECRET = "synthetic-test-only-pairing-secret-with-32-characters";

async function seedPairingCode(database, code = "123456", expiresAt = new Date(Date.now() + 600000).toISOString()) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`carrier-pairing:${code}`));
  const storedCode = [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, "0")).join("");
  database.prepare("INSERT INTO pairing_codes (code, device_name, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(storedCode, "Packing desk", new Date().toISOString(), expiresAt);
}

function pairingRequest(code = "123456", deviceName = "") {
  return new Request("https://tracking.cheaply.fr/api/pairing/claim", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    body: JSON.stringify({ code, deviceName })
  });
}

test("two simultaneous redemptions of one pairing code create exactly one usable device", async (context) => {
  const { database, db } = await fixture(context);
  await seedPairingCode(database);
  // Both HTTP requests reach device creation before either transaction runs.
  // A SELECT-then-unconditional-INSERT implementation fails this interleaving.
  let arrived = 0;
  let release;
  const bothReady = new Promise((resolve) => { release = resolve; });
  db.beforeBatch = async (statements) => {
    if (!statements.some((statement) => statement.sql.includes("INSERT INTO devices"))) return;
    arrived += 1;
    if (arrived === 2) release();
    await bothReady;
  };
  const env = { DB: db, SESSION_SECRET };
  const responses = await Promise.all([
    worker.fetch(pairingRequest("123456", "Work Brave"), env),
    worker.fetch(pairingRequest("123456", "Packing Chrome"), env)
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM devices").get().count, 1);
  const accepted = await responses.find((response) => response.status === 200).json();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accepted.token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const saved = database.prepare("SELECT * FROM devices").get();
  assert.equal(saved.id, accepted.deviceId);
  assert.equal(saved.name, accepted.deviceName);
  assert.equal(saved.token_hash, hash);
  assert.notEqual(database.prepare("SELECT used_at FROM pairing_codes").get().used_at, "");
});

test("pairing transaction failure creates no orphan device and preserves the code for retry", async (context) => {
  const { database, db } = await fixture(context);
  await seedPairingCode(database);
  db.failAfterStatement = (statement) => statement.sql.includes("UPDATE pairing_codes SET used_at");
  const env = { DB: db, SESSION_SECRET };
  const failure = await worker.fetch(pairingRequest(), env);
  assert.equal(failure.status, 400);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM devices").get().count, 0);
  assert.equal(database.prepare("SELECT used_at FROM pairing_codes").get().used_at, "");
  db.failAfterStatement = null;
  const retry = await worker.fetch(pairingRequest(), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).deviceName, "Packing desk");
  const reused = await worker.fetch(pairingRequest(), env);
  assert.equal(reused.status, 400);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM devices").get().count, 1);
});

test("an expired pairing code cannot create a device", async (context) => {
  const { database, db } = await fixture(context);
  await seedPairingCode(database, "123456", new Date(Date.now() - 1000).toISOString());
  const response = await worker.fetch(pairingRequest(), { DB: db, SESSION_SECRET });
  assert.equal(response.status, 400);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM devices").get().count, 0);
});
