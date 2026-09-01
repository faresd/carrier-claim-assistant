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
const deletionIndexes = read("monitor-service", "migrations", "0002_resolved_deletion_indexes.sql");
const deletionTombstones = read("monitor-service", "migrations", "0003_deleted_order_tombstones.sql");
const orderTrackingMetadata = read("monitor-service", "migrations", "0004_order_tracking_metadata.sql");
const wrangler = read("monitor-service", "wrangler.toml");
const dashboard = read("monitor-service", "admin", "index.html");
const dashboardScript = read("monitor-service", "admin", "app.js");
const dashboardStyles = read("monitor-service", "admin", "styles.css");
const dashboardHeaders = read("monitor-service", "admin", "_headers");
const deployment = read(".github", "workflows", "deploy-monitor.yml");
const deploymentValidator = read("monitor-service", "scripts", "validate-deployment-env.mjs");
const ssoPreflight = read("monitor-service", "scripts", "verify-sso-registration.mjs");
const lapostePreflight = read("monitor-service", "scripts", "verify-laposte-access.mjs");
const productionSmoke = read("monitor-service", "scripts", "smoke-production.mjs");

test("monitor deployment schedules a DST-safe morning queue with bounded carrier concurrency", () => {
  assert.match(wrangler, /crons\s*=\s*\["\*\/15 \* \* \* \*"\]/);
  assert.match(wrangler, /binding\s*=\s*"TRACKING_QUEUE"/);
  assert.match(wrangler, /max_batch_size\s*=\s*8/);
  assert.match(wrangler, /max_concurrency\s*=\s*1/);
  assert.match(worker, /timeZone:\s*"Europe\/Paris"/);
  assert.match(worker, /return parisDateParts\(date\)\.hour === "07"/);
  assert.match(worker, /async queue\(batch, env\)/);
  assert.match(worker, /delaySeconds:\s*600/);
  assert.match(worker, /status = 'dispatched'/);
  assert.match(worker, /status = 'retrying'/);
  assert.match(worker, /SELECT record_id FROM orders WHERE tracking_state NOT IN \('delivered', 'resolved'\) ORDER BY checked_at ASC/);
  assert.doesNotMatch(worker, /tracking_state NOT IN \('delivered', 'resolved'\).*LIMIT 1000/);
});

test("monitor schema keeps multi-account history, idempotent jobs, devices, claim launches, and notification receipts", () => {
  for (const table of ["orders", "seller_accounts", "tracking_events", "monitor_runs", "monitor_jobs", "devices", "pairing_codes", "pairing_attempts", "claim_launches", "notification_receipts"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(migration, /PRIMARY KEY\(run_date, record_id\)/);
  assert.match(migration, /PRIMARY KEY\(record_id, device_id\)/);
  assert.match(worker, /`\$\{accountId\}\|\$\{marketplaceId\}\|\$\{orderId\}`/);
  assert.match(migration, /claim_payload TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(deletionIndexes, /monitor_jobs_record_idx[\s\S]*ON monitor_jobs\(record_id\)/);
  assert.match(deletionIndexes, /claim_launches_record_idx[\s\S]*ON claim_launches\(record_id\)/);
  assert.match(deletionIndexes, /PRAGMA optimize/);
  assert.match(deletionTombstones, /CREATE TABLE IF NOT EXISTS deleted_orders/);
  assert.match(deletionTombstones, /PRIMARY KEY\(account_id, marketplace_id, order_id\)/);
  assert.match(deletionTombstones, /deleted_orders_order_idx[\s\S]*ON deleted_orders\(order_id, marketplace_id\)/);
  assert.match(deletionTombstones, /PRAGMA optimize/);
  assert.match(orderTrackingMetadata, /ADD COLUMN order_date/);
  assert.match(orderTrackingMetadata, /ADD COLUMN tracking_source/);
  assert.match(worker, /orderDate:\s*clean\(input\.orderDate/);
  assert.match(worker, /"notification_receipts", "deleted_orders"/);
  assert.match(worker, /\/api\/claim-launch\/redeem/);
  assert.match(worker, /launch-claim/);
  assert.doesNotMatch(worker, /input\.recordId\s*\|\|/);
});

test("browser pairing is short-lived, rate-limited, and revocable from the dashboard", () => {
  assert.match(worker, /now\.getTime\(\) \+ 10 \* 60000/);
  assert.match(worker, /attempt_count/);
  assert.match(worker, /> 10/);
  assert.match(worker, /EXTENSION_ORIGIN\.test\(origin\)/);
  assert.match(worker, /\/api\/devices/);
  assert.match(worker, /revoked_at = \?/);
  assert.doesNotMatch(worker, /SYNC_TOKEN/);
  assert.match(dashboard, /id="device-list"/);
  assert.match(dashboardScript, /data-revoke-device/);
});

test("dashboard exposes the required order queues, account filter, claims, resolution, and tracking history", () => {
  for (const view of ["all", "lost", "returned", "resolved"]) {
    assert.match(dashboard, new RegExp(`data-view="${view}"`));
  }
  assert.match(dashboard, /id="account-filter"/);
  assert.match(dashboard, /<th>Amazon account<\/th>/);
  assert.match(dashboard, /<th>Order date<\/th>/);
  assert.match(dashboardScript, /order\.orderDate/);
  assert.match(dashboardScript, /La Poste Suivi API v2/);
  assert.match(dashboardScript, /La Poste Suivi API v1 fallback/);
  assert.match(dashboardScript, /class="account-name"/);
  assert.match(dashboard, /id="claim-dialog"/);
  assert.match(dashboard, /id="claim-reason"/);
  assert.match(dashboard, /id="claim-recipient-title"/);
  assert.match(dashboard, /id="claim-details"/);
  assert.match(dashboardScript, /data-launch-claim/);
  assert.match(dashboardScript, /openClaimDialog/);
  assert.match(dashboardScript, /Sender address/);
  assert.match(dashboardScript, /Destination/);
  assert.match(dashboardScript, /claim-form/);
  assert.match(dashboardScript, /launch-claim/);
  assert.doesNotMatch(dashboardScript, /\bprompt\(/);
  assert.match(dashboardScript, /\["returning", "pickup_ready"\].*return "returned"/);
  assert.match(dashboardScript, /contents_missing/);
  assert.match(dashboardScript, /data-resolve/);
  assert.match(dashboard, /id="export-history"/);
  assert.match(dashboardScript, /\/api\/export\?resource=/);
  assert.match(dashboardScript, /data-delete/);
  assert.match(dashboardScript, /Permanently delete resolved order/);
  assert.match(worker, /Only a resolved order can be permanently deleted/);
  assert.match(dashboardScript, /\/events/);
  assert.match(dashboardScript, /Saved tracking history/);
  assert.match(worker, /order_ids/);
  assert.match(dashboard, /id="scroll-sentinel"/);
  assert.match(dashboard, /id="scroll-status"/);
  assert.match(dashboardScript, /new IntersectionObserver/);
  assert.match(dashboardScript, /PAGE_SIZE = 100/);
  assert.match(dashboardScript, /rootMargin: "600px 0px"/);
  assert.match(dashboardScript, /params\.set\("summary", "1"\)/);
  assert.doesNotMatch(dashboardScript, /offset < 100000/);
  assert.match(worker, /dashboardOrderSummary/);
  assert.match(worker, /GROUP BY tracking_state/);
  assert.match(dashboardScript, /carrierTrackingUrl/);
  assert.match(dashboardScript, /chronopost\.fr\/tracking-no-cms\/suivi-page/);
  assert.match(dashboardScript, /laposte\.fr\/outils\/suivre-vos-envois\?code=/);
  assert.match(dashboardScript, /Open official carrier tracking/);
  assert.match(dashboardScript, /data-recheck/);
  assert.match(dashboardScript, /Recheck this parcel now/);
  assert.match(dashboardScript, /\/recheck/);
  assert.match(worker, /enqueueOrderRecheck/);
  assert.match(worker, /force:\s*true/);
});

test("dashboard assets are protected by a restrictive browser security policy", () => {
  assert.match(dashboardHeaders, /Content-Security-Policy: default-src 'self'/);
  assert.match(dashboardHeaders, /Cache-Control: no-store/);
  assert.match(wrangler, /run_worker_first\s*=\s*true/);
  assert.match(worker, /content-security-policy/);
  assert.match(worker, /next\.set\("cache-control", "no-store"\)/);
  assert.match(worker, /frame-ancestors 'none'/);
  assert.match(worker, /x-content-type-options/);
  assert.match(worker, /permissions-policy/);
  assert.match(worker, /DASHBOARD_ORIGIN = "https:\/\/tracking\.cheaply\.fr"/);
  assert.match(worker, /EXTENSION_ORIGIN = \/\^chrome-extension:/);
  assert.doesNotMatch(worker, /access-control-allow-origin": request\.headers\.get\("origin"\) \|\| "\*"/);
  assert.match(dashboardStyles, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
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
  assert.doesNotMatch(auth, /ADMIN_TOKEN/);
  assert.match(deployment, /MONITOR_SESSION_SECRET/);
  assert.match(deployment, /MONITOR_TRACKING_CLIENT_SECRET/);
  assert.match(deployment, /vars\.CF_ACCOUNT_ID/);
  assert.match(deployment, /vars\.CF_D1_DATABASE_ID/);
  assert.doesNotMatch(deployment, /MONITOR_ADMIN_TOKEN/);
  assert.doesNotMatch(deployment, /MONITOR_SYNC_TOKEN/);
});

test("monitor deployment fails before mutation when required production configuration is missing", () => {
  const validationIndex = deployment.indexOf("Validate deployment configuration");
  const ssoIndex = deployment.indexOf("Verify shared SSO client registration");
  const laposteIndex = deployment.indexOf("Verify La Poste Suivi v2 access");
  const migrationIndex = deployment.indexOf("Apply database migrations");
  assert.ok(validationIndex > 0 && validationIndex < ssoIndex && ssoIndex < laposteIndex && laposteIndex < migrationIndex);
  for (const name of ["CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN", "LAPOSTE_OKAPI_KEY", "MONITOR_SESSION_SECRET", "MONITOR_TRACKING_CLIENT_SECRET"]) {
    assert.match(deployment, new RegExp(name));
    assert.match(deploymentValidator, new RegExp(name));
  }
  assert.match(deploymentValidator, /Use different values/);
  assert.doesNotMatch(deploymentValidator, /console\.(?:log|error)\([^\n]*(?:apiToken|okapiKey|sessionSecret|trackingSecret)/);
  assert.match(deployment, /node monitor-service\/scripts\/verify-sso-registration\.mjs/);
  assert.match(ssoPreflight, /client_id/);
  assert.match(ssoPreflight, /tracking-web/);
  assert.match(ssoPreflight, /code_challenge_method/);
  assert.match(ssoPreflight, /S256/);
  assert.match(ssoPreflight, /__Host-cheaply_sso_request=/);
  assert.match(deployment, /node monitor-service\/scripts\/verify-laposte-access\.mjs/);
  assert.match(deployment, /allow_pending_laposte/);
  assert.match(lapostePreflight, /LAPOSTE_ALLOW_PENDING/);
  assert.match(lapostePreflight, /api\.laposte\.fr\/suivi\/v2\/idships/);
  assert.match(lapostePreflight, /X-Okapi-Key/);
  assert.match(lapostePreflight, /\[401, 403\]/);
});

test("monitor deployment verifies the live security and authentication boundary", () => {
  const deployIndex = deployment.indexOf("Deploy Worker, dashboard, queue consumer, and scheduler");
  const smokeIndex = deployment.indexOf("Verify the live dashboard and authentication boundary");
  assert.ok(deployIndex > 0 && smokeIndex > deployIndex);
  assert.match(deployment, /node monitor-service\/scripts\/smoke-production\.mjs/);
  assert.match(productionSmoke, /\/api\/health/);
  assert.match(productionSmoke, /healthPayload\.ready !== true/);
  assert.match(worker, /sqlite_master/);
  assert.match(worker, /REQUIRED_SCHEMA_TABLES/);
  assert.match(productionSmoke, /\/api\/orders/);
  assert.match(productionSmoke, /content-security-policy/);
  assert.match(productionSmoke, /https:\/\/auth\.cheaply\.fr/);
  assert.match(productionSmoke, /code_challenge_method/);
  assert.match(deployment, /group: carrier-return-monitor-production/);
  assert.match(deployment, /cancel-in-progress: false/);
});
