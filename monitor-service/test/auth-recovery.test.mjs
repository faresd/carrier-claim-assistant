import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.mjs";

const origin = "https://tracking.cheaply.fr";
const env = {
  SESSION_SECRET: "recovery-regression-secret-at-least-thirty-two-characters",
  CHEAPLY_AUTH_CLIENT_ID: "ca_tracking_web_client_0001",
  ASSETS: { fetch() { throw new Error("Recovery must not expose private dashboard assets"); } },
};

test("callback failure lands on stable public recovery without another authorization redirect", async () => {
  const callback = await worker.fetch(new Request(`${origin}/api/auth/callback?error=access_denied`), env);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/?auth_error=sso");
  const recovery = await worker.fetch(new Request(new URL(callback.headers.get("location"), origin)), env);
  assert.equal(recovery.status, 200);
  assert.equal(recovery.headers.get("location"), null);
  assert.equal(recovery.headers.get("set-cookie"), null);
  assert.equal(recovery.headers.get("cache-control"), "no-store");
  const body = await recovery.text();
  assert.match(body, /Sign-in needs attention/);
  assert.match(body, /prompt=select_account/);
  assert.doesNotMatch(body, /<script|http-equiv|orders-body|access_denied/);
});

test("logout recovery and HEAD stay signed out without restarting OAuth", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request(`${origin}/?signed_out=1`, { method }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    const body = await response.text();
    if (method === "HEAD") assert.equal(body, "");
    else assert.match(body, /You are signed out/);
  }
});

test("error query values are never reflected into recovery HTML", async () => {
  const response = await worker.fetch(new Request(`${origin}/?auth_error=%3Cscript%3Esecret%3C%2Fscript%3E`), env);
  assert.doesNotMatch(await response.text(), /<script>|secret/);
});

test("recovery exception never exposes private APIs, assets, or unauthenticated mutations", async () => {
  const orders = await worker.fetch(new Request(`${origin}/api/orders?auth_error=sso`), env);
  assert.equal(orders.status, 401);
  const asset = await worker.fetch(new Request(`${origin}/app.js?auth_error=sso`), env);
  assert.equal(asset.status, 302);
  assert.equal(new URL(asset.headers.get("location")).origin, "https://auth.cheaply.fr");
  const mutation = await worker.fetch(new Request(`${origin}/?signed_out=1`, { method: "POST" }), env);
  assert.equal(mutation.status, 401);
});
