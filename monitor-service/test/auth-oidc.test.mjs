import test from "node:test";
import assert from "node:assert/strict";
import {
  beginDashboardLogin, dashboardAuthConfig, finishDashboardLogin, handleDashboardAuth,
  readDashboardSession, safeReturnTo, signAuthPayload, verifyAuthPayload, verifyCentralIdToken
} from "../src/auth.mjs";

const env = {
  SESSION_SECRET: "fixture-session-secret-with-at-least-thirty-two-characters",
  TRACKING_CLIENT_SECRET: "fixture-client-secret-with-at-least-thirty-two-characters",
  CHEAPLY_AUTH_CLIENT_ID: "ca_tracking_web_client_0001"
};
const origin = "https://auth.cheaply.fr";
const encoder = new TextEncoder();
const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const cookieValue = (response, name) => response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))?.split(";")[0];

async function keyFixture() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "fixture-key", alg: "ES256", use: "sig" };
  return {
    jwk,
    async sign(claims, header = {}) {
      const input = `${encode({ alg: "ES256", kid: jwk.kid, ...header })}.${encode(claims)}`;
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(input));
      return `${input}.${Buffer.from(signature).toString("base64url")}`;
    }
  };
}

async function flow({ legacy = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const start = await beginDashboardLogin(new Request("https://tracking.cheaply.fr/api/auth/login?return_to=%2F%3Fview%3Dlost%26auth_error%3Dsso"), env, now);
  const destination = new URL(start.headers.get("location"));
  let transaction = cookieValue(start, dashboardAuthConfig.requestCookie);
  let pending = await verifyAuthPayload(transaction.split("=")[1], env.SESSION_SECRET, now);
  if (legacy) {
    const { version, clientId, nonce, ...old } = pending;
    pending = old;
    transaction = `${dashboardAuthConfig.requestCookie}=${await signAuthPayload(old, env.SESSION_SECRET)}`;
  }
  const callback = new URL(dashboardAuthConfig.callbackUri);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", pending.state);
  const request = new Request(callback, { headers: { cookie: transaction } });
  const keys = await keyFixture();
  const baseClaims = { iss: origin, aud: env.CHEAPLY_AUTH_CLIENT_ID, sub: "fixture-subject", iat: now, exp: now + 300,
    ...(legacy ? {} : { nonce: pending.nonce }) };
  const calls = [];
  return {
    now, pending, request, start, destination, keys, baseClaims, calls,
    async complete(options = {}) {
      const idToken = await keys.sign({ ...baseClaims, ...options.claims }, options.header);
      const accessToken = options.accessToken ?? "fixture-access-token";
      const tokens = { id_token: idToken, token_type: options.tokenType ?? "Bearer",
        ...(options.omitAccessToken ? {} : { access_token: accessToken }) };
      return finishDashboardLogin(options.request || request, options.env || env, {
        now,
        fetchImpl: async (url, init = {}) => {
          const path = new URL(url).pathname;
          calls.push(path);
          assert.equal(new URL(url).origin, origin);
          assert.equal(init.redirect, "manual");
          assert.ok(init.signal instanceof AbortSignal);
          if (options.responses?.[path]) return options.responses[path];
          if (path === "/token") {
            const form = new URLSearchParams(init.body);
            assert.equal(form.get("code_verifier"), pending.verifier);
            assert.equal(form.get("redirect_uri"), dashboardAuthConfig.callbackUri);
            assert.equal(form.get("client_id"), env.CHEAPLY_AUTH_CLIENT_ID);
            assert.equal(form.get("client_secret"), env.TRACKING_CLIENT_SECRET);
            return Response.json(tokens);
          }
          if (path === "/jwks.json") return Response.json({ keys: [options.jwk || keys.jwk] }, {
            headers: { "content-type": "application/jwk-set+json; charset=utf-8" }
          });
          assert.equal(path, "/userinfo");
          assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${accessToken}`);
          return Response.json({ sub: "fixture-subject", email: "Owner@example.com", email_verified: true, role: "admin", name: "Owner", ...options.profile });
        }
      });
    }
  };
}

test("new transactions bind nonce and client ID, with only explicit account prompts forwarded", async () => {
  for (const prompt of ["", "select_account", "login", "none", "consent", "login select_account"]) {
    const url = new URL("https://tracking.cheaply.fr/api/auth/login");
    if (prompt) url.searchParams.set("prompt", prompt);
    const response = await beginDashboardLogin(new Request(url), env);
    const destination = new URL(response.headers.get("location"));
    const pending = await verifyAuthPayload(cookieValue(response, dashboardAuthConfig.requestCookie).split("=")[1], env.SESSION_SECRET);
    assert.equal(pending.version, 2);
    assert.equal(pending.clientId, env.CHEAPLY_AUTH_CLIENT_ID);
    assert.match(pending.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(destination.searchParams.get("nonce"), pending.nonce);
    assert.equal(destination.searchParams.get("prompt"), ["select_account", "login"].includes(prompt) ? prompt : null);
    assert.equal(pending.exp - pending.iat, 600);
    assert.equal(destination.searchParams.get("scope"), "openid email profile roles");
    assert.equal(cookieValue(response, dashboardAuthConfig.sessionCookie), undefined);
  }
});

test("full sparse-token login binds UserInfo, preserves client snapshot and creates the existing session contract", async () => {
  const f = await flow();
  const response = await f.complete({ env: { ...env, CHEAPLY_AUTH_CLIENT_ID: "changed-after-login-start" } });
  assert.equal(response.headers.get("location"), "/?view=lost");
  assert.deepEqual(f.calls, ["/token", "/jwks.json", "/userinfo"]);
  const cookie = cookieValue(response, dashboardAuthConfig.sessionCookie);
  const principal = await readDashboardSession(new Request("https://tracking.cheaply.fr/", { headers: { cookie } }), env, f.now);
  assert.equal(principal.sub, "fixture-subject");
  assert.equal(principal.email, "owner@example.com");
  assert.equal(principal.role, "admin");
  assert.equal(principal.exp - principal.iat, 7 * 24 * 3600);
  assert.ok(principal.jti);
  assert.match(response.headers.getSetCookie().find((value) => value.startsWith(dashboardAuthConfig.sessionCookie)), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(response.headers.getSetCookie().find((value) => value.startsWith(dashboardAuthConfig.requestCookie)), /Max-Age=0/);
});

test("signed pre-upgrade transactions remain completable with sparse UserInfo and with the old rich JWT", async () => {
  const sparse = await flow({ legacy: true });
  assert.equal((await sparse.complete()).status, 302);
  const rich = await flow({ legacy: true });
  assert.equal((await rich.complete({ omitAccessToken: true, claims: { email: "owner@example.com", role: "admin" } })).status, 302);
  assert.deepEqual(rich.calls, ["/token", "/jwks.json"]);
  const missingIdentity = await flow({ legacy: true });
  await assert.rejects(missingIdentity.complete({ omitAccessToken: true }), /incomplete/);
  const rejectedUserInfo = await flow({ legacy: true });
  await assert.rejects(rejectedUserInfo.complete({ claims: { email: "owner@example.com", role: "admin" },
    responses: { "/userinfo": Response.json({ error: "invalid_token" }, { status: 401 }) } }), /provider request failed/);
});

test("new transactions never downgrade missing nonce or access token to the old rich identity flow", async () => {
  for (const options of [
    { claims: { nonce: undefined } },
    { claims: { nonce: "incorrect" } },
    { omitAccessToken: true, claims: { email: "owner@example.com", role: "admin" } },
    { tokenType: "unknown" },
    { accessToken: "contains whitespace" }
  ]) {
    const f = await flow();
    await assert.rejects(f.complete(options), /nonce|access token/);
    assert.equal(f.calls.includes("/userinfo"), false);
  }
});

test("token signatures, issuer, audience, authorized party, timing and signing-key usage fail closed", async () => {
  for (const options of [
    { claims: { iss: "https://attacker.example" } },
    { claims: { aud: "other-client" } },
    { claims: { aud: [env.CHEAPLY_AUTH_CLIENT_ID, "other"] } },
    { claims: { azp: "other-client" } },
    { claims: { exp: 0 } },
    { claims: { iat: 9_999_999_999 } },
    { claims: { iat: undefined } },
    { claims: { nbf: 9_999_999_999 } },
    { claims: { sub: "" } },
    { header: { alg: "HS256" } }
  ]) {
    const f = await flow();
    await assert.rejects(f.complete(options));
    assert.equal(f.calls.includes("/userinfo"), false);
  }
  const f = await flow();
  for (const patch of [{ use: "enc" }, { alg: "RS256" }, { key_ops: ["encrypt"] }]) {
    await assert.rejects(f.complete({ jwk: { ...f.keys.jwk, ...patch } }), /signing key/);
  }
  const other = await keyFixture();
  await assert.rejects(f.complete({ jwk: other.jwk }), /signature/);
});

test("optional access-token hash is validated before any UserInfo request", async () => {
  const f = await flow();
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode("fixture-access-token")));
  const at_hash = Buffer.from(hash.subarray(0, 16)).toString("base64url");
  assert.equal((await f.complete({ claims: { at_hash } })).status, 302);
  const other = await flow();
  await assert.rejects(other.complete({ claims: { at_hash: "incorrect" } }), /token pair/);
  assert.equal(other.calls.includes("/userinfo"), false);
});

test("subject, verified email, issuer, audience and role mismatches cannot create a privileged session", async () => {
  for (const options of [
    { profile: { sub: "another-user" } },
    { profile: { email_verified: false } },
    { profile: { email_verified: undefined } },
    { profile: { email: "invalid" } },
    { profile: { role: undefined, roles: ["admin"] } },
    { profile: { iss: "https://attacker.example" } },
    { profile: { aud: "other-client" } },
    { claims: { role: "member" }, profile: { role: "admin" } },
    { claims: { email: "different@example.com" } },
    { claims: { email_verified: false } }
  ]) {
    const f = await flow();
    await assert.rejects(f.complete(options), /identity|UserInfo/);
  }
  const f = await flow();
  await assert.rejects(f.complete({ profile: { role: "member" } }), /administrator access/);
  const allowed = await f.complete({ profile: { role: "member" }, env: { ...env, TRACKING_ADMIN_EMAILS: "owner@example.com" } });
  const principal = await readDashboardSession(new Request("https://tracking.cheaply.fr/", {
    headers: { cookie: cookieValue(allowed, dashboardAuthConfig.sessionCookie) }
  }), { ...env, TRACKING_ADMIN_EMAILS: "owner@example.com" }, f.now);
  assert.equal(principal.role, "employee", "explicit admin allow-list must not rewrite upstream role");
});

test("provider redirects, errors and oversized responses cannot leak secrets or trigger a fallback", async () => {
  for (const response of [
    new Response("provider-secret-fixture", { status: 302, headers: { location: "https://attacker.example/steal" } }),
    new Response("provider-secret-fixture", { status: 500 }),
    new Response("not json", { headers: { "content-type": "text/html" } }),
    Response.json({ sub: "fixture-subject" }, { headers: { "content-type": "application/jwk-set+json" } }),
    new Response(JSON.stringify({ huge: "a".repeat(70_000) }), { headers: { "content-type": "application/json" } })
  ]) {
    const f = await flow();
    await assert.rejects(f.complete({ responses: { "/userinfo": response } }), (error) => {
      assert.match(error.message, /provider request failed/);
      assert.doesNotMatch(error.message, /provider-secret-fixture|attacker/);
      return true;
    });
    assert.deepEqual(f.calls, ["/token", "/jwks.json", "/userinfo"]);
  }
});

test("invalid state cannot perform a token exchange or erase an existing signed session", async () => {
  const f = await flow();
  const previous = { sub: "previous-user", email: "previous@example.com", role: "admin", name: "Previous", jti: "unchanged-csrf", iat: f.now - 300, exp: f.now + 300 };
  const previousCookie = `${dashboardAuthConfig.sessionCookie}=${await signAuthPayload(previous, env.SESSION_SECRET)}`;
  const badUrl = new URL(f.request.url);
  badUrl.searchParams.set("state", "invalid");
  const request = new Request(badUrl, { headers: { cookie: `${f.request.headers.get("cookie")}; ${previousCookie}` } });
  await assert.rejects(f.complete({ request }), /invalid or expired/);
  assert.deepEqual(f.calls, []);
  const response = await handleDashboardAuth(request, env, badUrl);
  assert.equal(response.headers.get("location"), "/?auth_error=sso");
  assert.equal(response.headers.getSetCookie().length, 1);
  assert.match(response.headers.getSetCookie()[0], /^__Host-carrier_monitor_oauth=;/);
  assert.deepEqual(await readDashboardSession(new Request("https://tracking.cheaply.fr/", { headers: { cookie: previousCookie } }), env, f.now), previous);
  const me = await handleDashboardAuth(new Request("https://tracking.cheaply.fr/api/auth/me", { headers: { cookie: previousCookie } }), env, new URL("https://tracking.cheaply.fr/api/auth/me"));
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.sub, "previous-user");
});

test("current nonce enforcement cannot be disabled by callback query or a modified signed cookie", async () => {
  const f = await flow();
  const url = new URL(f.request.url);
  url.searchParams.set("nonce", "ignored");
  url.searchParams.set("version", "1");
  url.searchParams.set("method", "mail");
  await assert.rejects(f.complete({ claims: { nonce: undefined }, request: new Request(url, { headers: f.request.headers }) }), /nonce/);
  const incomplete = { ...f.pending, nonce: undefined };
  const request = new Request(f.request.url, { headers: { cookie: `${dashboardAuthConfig.requestCookie}=${await signAuthPayload(incomplete, env.SESSION_SECRET)}` } });
  await assert.rejects(f.complete({ request }), /invalid or expired/);
});

test("safe return paths remove authentication artifacts and never return into OAuth endpoints", () => {
  assert.equal(safeReturnTo("/?view=lost&auth_error=sso&signed_out=1&code=secret&state=state&error=denied&error_description=private&nonce=n#orders"), "/?view=lost#orders");
  for (const path of ["/api/auth/login", "/api/auth/callback?code=secret", "/api/%61uth/login", "/\\attacker", "/\n/attacker"]) {
    assert.equal(safeReturnTo(path), "/");
  }
});
