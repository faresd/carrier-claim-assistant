import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  beginDashboardLogin,
  dashboardAuthConfig,
  finishDashboardLogin,
  identityMayAdmin,
  safeReturnTo,
  signAuthPayload,
  verifyAuthPayload,
  verifyCentralIdToken
} from "../src/auth.mjs";

const SESSION_SECRET = "session-secret-that-is-longer-than-thirty-two-characters";
const CLIENT_SECRET = "client-secret-that-is-longer-than-thirty-two-characters";
const encoder = new TextEncoder();

const registration = JSON.parse(await readFile(
  new URL("../sso/tracking-web-client.json", import.meta.url),
  "utf8"
));

function base64Url(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function signingFixture() {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const sign = async (claims) => {
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: publicJwk.kid }));
    const payload = base64Url(JSON.stringify(claims));
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(input));
    return `${input}.${base64Url(signature)}`;
  };
  return { publicJwk, sign };
}

test("keeps dashboard return paths on tracking.cheaply.fr", () => {
  assert.equal(safeReturnTo("/orders?view=returned#urgent"), "/orders?view=returned#urgent");
  assert.equal(safeReturnTo("https://evil.example/steal"), "/");
  assert.equal(safeReturnTo("//evil.example/steal"), "/");
  assert.equal(safeReturnTo("/\\evil"), "/");
});

test("keeps the dashboard implementation aligned with the central SSO registration contract", () => {
  assert.equal(registration.client_id, dashboardAuthConfig.clientId);
  assert.equal(registration.application_origin, dashboardAuthConfig.appOrigin);
  assert.deepEqual(registration.redirect_uris, [dashboardAuthConfig.callbackUri]);
  assert.deepEqual(registration.grant_types, ["authorization_code"]);
  assert.deepEqual(registration.response_types, ["code"]);
  assert.equal(registration.pkce_method, "S256");
  assert.equal(registration.id_token_signing_alg, "RS256");
  assert.equal(registration.client_secret_binding, "TRACKING_CLIENT_SECRET");
});

test("signs short-lived auth payloads and rejects tampering or expiry", async () => {
  const token = await signAuthPayload({ sub: "admin:test", exp: 2_000 }, SESSION_SECRET);
  assert.equal((await verifyAuthPayload(token, SESSION_SECRET, 1_999)).sub, "admin:test");
  assert.equal(await verifyAuthPayload(`${token.slice(0, -1)}x`, SESSION_SECRET, 1_999), null);
  assert.equal(await verifyAuthPayload(token, SESSION_SECRET, 2_000), null);
});

test("starts the same PKCE authorization-code flow used by Presence", async () => {
  const response = await beginDashboardLogin(new Request(
    "https://tracking.cheaply.fr/api/auth/login?return_to=%2F%3Fview%3Dreturned"
  ), { SESSION_SECRET }, 10_000);
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get("location"));
  assert.equal(destination.origin, "https://auth.cheaply.fr");
  assert.equal(destination.pathname, "/authorize");
  assert.equal(destination.searchParams.get("client_id"), "tracking-web");
  assert.equal(destination.searchParams.get("redirect_uri"), "https://tracking.cheaply.fr/api/auth/callback");
  assert.equal(destination.searchParams.get("response_type"), "code");
  assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
  assert.match(destination.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-carrier_monitor_oauth=/);
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
  const signed = setCookie.match(/^__Host-carrier_monitor_oauth=([^;]+)/)[1];
  const pending = await verifyAuthPayload(signed, SESSION_SECRET, 10_000);
  assert.equal(pending.returnTo, "/?view=returned");
  assert.equal(pending.state, destination.searchParams.get("state"));
});

test("verifies central RS256/JWKS identity assertions and rejects another audience", async () => {
  const fixture = await signingFixture();
  const now = 50_000;
  const fetchImpl = async (url) => {
    assert.equal(url, "https://auth.cheaply.fr/.well-known/jwks.json");
    return Response.json({ keys: [fixture.publicJwk] });
  };
  const claims = {
    iss: "https://auth.cheaply.fr",
    aud: "tracking-web",
    sub: "admin:owner@example.com",
    email: "owner@example.com",
    role: "admin",
    name: "Owner",
    iat: now,
    exp: now + 300
  };
  const verified = await verifyCentralIdToken(await fixture.sign(claims), { now, fetchImpl });
  assert.equal(verified.email, "owner@example.com");
  await assert.rejects(
    verifyCentralIdToken(await fixture.sign({ ...claims, aud: "presence-web" }), { now, fetchImpl }),
    /another application/
  );
});

test("exchanges the one-time code and creates a secure local dashboard session", async () => {
  const fixture = await signingFixture();
  const now = 80_000;
  const state = "state_value_that_is_long_enough_1234567890";
  const verifier = "verifier_value_that_is_long_enough_for_pkce_1234567890";
  const pending = await signAuthPayload({ state, verifier, returnTo: "/?view=lost", exp: now + 600 }, SESSION_SECRET);
  const idToken = await fixture.sign({
    iss: "https://auth.cheaply.fr",
    aud: "tracking-web",
    sub: "admin:owner@example.com",
    email: "owner@example.com",
    role: "admin",
    name: "Owner",
    iat: now,
    exp: now + 300
  });
  const fetchImpl = async (url, options = {}) => {
    if (url === "https://auth.cheaply.fr/token") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("client_id"), "tracking-web");
      assert.equal(form.get("client_secret"), CLIENT_SECRET);
      assert.equal(form.get("code_verifier"), verifier);
      return Response.json({ id_token: idToken, token_type: "Bearer", expires_in: 300 });
    }
    assert.equal(url, "https://auth.cheaply.fr/.well-known/jwks.json");
    return Response.json({ keys: [fixture.publicJwk] });
  };
  const response = await finishDashboardLogin(new Request(
    `https://tracking.cheaply.fr/api/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `${dashboardAuthConfig.requestCookie}=${pending}` } }
  ), { SESSION_SECRET, TRACKING_CLIENT_SECRET: CLIENT_SECRET }, { now, fetchImpl });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/?view=lost");
  const cookies = response.headers.get("set-cookie");
  assert.match(cookies, /__Host-carrier_monitor_session=/);
  assert.match(cookies, /HttpOnly; Secure; SameSite=Lax/);
});

test("uses central admin role with an optional explicit email allow-list", () => {
  assert.equal(identityMayAdmin({ role: "admin", email: "owner@example.com" }), true);
  assert.equal(identityMayAdmin({ role: "employee", email: "worker@example.com" }), false);
  assert.equal(identityMayAdmin(
    { role: "employee", email: "worker@example.com" },
    { TRACKING_ADMIN_EMAILS: "owner@example.com, worker@example.com" }
  ), true);
});
