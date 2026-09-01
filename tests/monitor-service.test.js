"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const worker = read("monitor-service", "src", "worker.mjs");
const auth = read("monitor-service", "src", "auth.mjs");
const migration = read("monitor-service", "migrations", "0001_initial.sql");
const wrangler = read("monitor-service", "wrangler.toml");
const dashboard = read("monitor-service", "admin", "index.html");
const dashboardScript = read("monitor-service", "admin", "app.js");
const deployment = read(".github", "workflows", "deploy-monitor.yml");

test("monitor deployment schedules a DST-safe morning queue with bounded carrier concurrency", () => {
  assert.match(wrangler, /crons\s*=\s*\["\*\/15 \* \* \* \*"\]/);
  assert.match(wrangler, /binding\s*=\s*"TRACKING_QUEUE"/);
  assert.match(wrangler, /max_batch_size\s*=\s*8/);
  assert.match(wrangler, /max_concurrency\s*=\s*1/);
  assert.match(worker, /timeZone:\s*"Europe\/Paris"/);
  assert.match(worker, /return parisDateParts\(date\)\.hour === "07"/);
  assert.match(worker, /async queue\(batch, env\)/);
  assert.match(worker, /delaySeconds:\s*600/);
});

test("monitor schema keeps multi-account history, idempotent jobs, devices, claim launches, and notification receipts", () => {
  for (const table of ["orders", "seller_accounts", "tracking_events", "monitor_runs", "monitor_jobs", "devices", "pairing_codes", "pairing_attempts", "claim_launches", "notification_receipts"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(migration, /PRIMARY KEY\(run_date, record_id\)/);
  assert.match(migration, /PRIMARY KEY\(record_id, device_id\)/);
  assert.match(worker, /`\$\{accountId\}\|\$\{marketplaceId\}\|\$\{orderId\}`/);
  assert.match(migration, /claim_payload TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(worker, /\/api\/claim-launch\/redeem/);
  assert.match(worker, /launch-claim/);
  assert.doesNotMatch(worker, /input\.recordId\s*\|\|/);
});

test("browser pairing is short-lived, rate-limited, and revocable from the dashboard", () => {
  assert.match(worker, /now\.getTime\(\) \+ 10 \* 60000/);
  assert.match(worker, /attempt_count/);
  assert.match(worker, /> 10/);
  assert.match(worker, /chrome-extension:\/\//);
  assert.match(worker, /\/api\/devices/);
  assert.match(worker, /revoked_at = \?/);
  assert.match(dashboard, /id="device-list"/);
  assert.match(dashboardScript, /data-revoke-device/);
});

test("dashboard exposes the required order queues, account filter, claims, resolution, and tracking history", () => {
  for (const view of ["all", "lost", "returned", "resolved"]) {
    assert.match(dashboard, new RegExp(`data-view="${view}"`));
  }
  assert.match(dashboard, /id="account-filter"/);
  assert.match(dashboardScript, /data-launch-claim/);
  assert.match(dashboardScript, /Review or edit the claim message/);
  assert.match(dashboardScript, /data-resolve/);
  assert.match(dashboardScript, /\/events/);
  assert.match(dashboardScript, /Saved tracking history/);
  assert.match(worker, /order_ids/);
});

test("dashboard assets are protected by a restrictive browser security policy", () => {
  assert.match(worker, /content-security-policy/);
  assert.match(worker, /frame-ancestors 'none'/);
  assert.match(worker, /x-content-type-options/);
  assert.match(worker, /permissions-policy/);
});

test("dashboard reuses Cheaply SSO with PKCE, signed sessions, JWKS, and CSRF", () => {
  assert.match(auth, /AUTH_ORIGIN = "https:\/\/auth\.cheaply\.fr"/);
  assert.match(auth, /CLIENT_ID = "tracking-web"/);
  assert.match(auth, /code_challenge_method", "S256"/);
  assert.match(auth, /RSASSA-PKCS1-v1_5/);
  assert.match(auth, /__Host-carrier_monitor_session/);
  assert.match(auth, /x-csrf-token/);
  assert.match(worker, /handleDashboardAuth/);
  assert.match(worker, /validDashboardCsrf/);
  assert.match(dashboardScript, /\/api\/auth\/me/);
  assert.match(dashboardScript, /\/api\/auth\/login/);
  assert.match(dashboardScript, /\/api\/auth\/logout/);
  assert.match(dashboard, /Sign in with Cheaply/);
  assert.doesNotMatch(dashboard, /Admin token/);
  assert.doesNotMatch(dashboardScript, /carrierMonitorAdminToken.*getItem/);
  assert.match(deployment, /MONITOR_SESSION_SECRET/);
  assert.match(deployment, /MONITOR_TRACKING_CLIENT_SECRET/);
});
