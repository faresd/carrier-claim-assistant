const AUTH_ORIGIN = "https://auth.cheaply.fr";
const APP_ORIGIN = "https://tracking.cheaply.fr";
const DEFAULT_CLIENT_ID = "tracking-web";
const CALLBACK_URI = `${APP_ORIGIN}/api/auth/callback`;
const SESSION_COOKIE = "__Host-carrier_monitor_session";
const REQUEST_COOKIE = "__Host-carrier_monitor_oauth";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const REQUEST_TTL_SECONDS = 10 * 60;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_BYTES = 65_536;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(bytes = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function isStrongSecret(value) {
  return typeof value === "string" && value.length >= 32;
}

function cheaplyAuthClientId(env = {}) {
  return String(env.CHEAPLY_AUTH_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left || ""));
  const b = encoder.encode(String(right || ""));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function signAuthPayload(payload, secret) {
  if (!isStrongSecret(secret)) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${await hmac(encoded, secret)}`;
}

export async function verifyAuthPayload(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (!isStrongSecret(secret)) return null;
  const [payload, supplied, extra] = String(token || "").split(".");
  if (!payload || !supplied || extra || !constantTimeEqual(supplied, await hmac(payload, secret))) return null;
  try {
    const value = JSON.parse(decoder.decode(base64UrlDecode(payload)));
    return Number.isFinite(value?.exp) && value.exp > now ? value : null;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const prefix = `${name}=`;
  return String(request.headers.get("cookie") || "").split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length) || "";
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, "cache-control": "private, no-store" });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 302, headers });
}

export function safeReturnTo(value) {
  const candidate = String(value || "/").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\x00-\x1f\x7f]/.test(candidate)) return "/";
  try {
    const parsed = new URL(candidate, APP_ORIGIN);
    if (parsed.origin !== APP_ORIGIN || /^\/api\/auth(?:\/|$)/i.test(decodeURIComponent(parsed.pathname))) return "/";
    for (const name of ["auth_error", "signed_out", "code", "state", "error", "error_description", "error_uri", "session_state", "iss", "nonce"]) {
      parsed.searchParams.delete(name);
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(verifier || "")));
  return base64UrlEncode(digest);
}

export async function beginDashboardLogin(request, env, now = Math.floor(Date.now() / 1000)) {
  if (!isStrongSecret(env.SESSION_SECRET)) {
    return Response.json({ error: "Dashboard SSO is not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const clientId = cheaplyAuthClientId(env);
  const url = new URL(request.url);
  const state = randomToken(32);
  const verifier = randomToken(64);
  const nonce = randomToken(32);
  const pending = await signAuthPayload({
    version: 2,
    clientId,
    state,
    verifier,
    nonce,
    returnTo: safeReturnTo(url.searchParams.get("return_to")),
    iat: now,
    exp: now + REQUEST_TTL_SECONDS
  }, env.SESSION_SECRET);
  const authorization = new URL(`${AUTH_ORIGIN}/authorize`);
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", CALLBACK_URI);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "openid email profile roles");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  const prompt = url.searchParams.get("prompt");
  if (["select_account", "login"].includes(prompt)) authorization.searchParams.set("prompt", prompt);
  return redirect(authorization.toString(), [cookie(REQUEST_COOKIE, pending, REQUEST_TTL_SECONDS)]);
}

// Never follow credential-bearing provider redirects, and bound both time and
// response bytes. Provider error bodies must not be exposed to the browser.
async function providerJson(url, options, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...options, redirect: "manual", signal: controller.signal });
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const jsonType = contentType === "application/json"
      || (url === `${AUTH_ORIGIN}/jwks.json` && contentType === "application/jwk-set+json");
    if (!response.ok || response.status >= 300 || !jsonType) {
      throw new Error("Cheaply SSO provider request failed.");
    }
    if (Number(response.headers.get("content-length")) > MAX_PROVIDER_BYTES) throw new Error("Cheaply SSO response is too large.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Cheaply SSO response is empty.");
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_BYTES) {
        await reader.cancel();
        throw new Error("Cheaply SSO response is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(decoder.decode(bytes));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid provider response.");
    return payload;
  } catch {
    throw new Error("Cheaply SSO provider request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

function decodeJsonPart(part) {
  return JSON.parse(decoder.decode(base64UrlDecode(part)));
}

function audienceIncludes(audience, expected) {
  return Array.isArray(audience) ? audience.includes(expected) : audience === expected;
}

export async function verifyCentralIdToken(token, {
  now = Math.floor(Date.now() / 1000),
  fetchImpl = fetch,
  expectedAudience = DEFAULT_CLIENT_ID,
  expectedNonce,
  accessToken
} = {}) {
  if (typeof token !== "string" || token.length > 16_384) throw new Error("Invalid SSO token format.");
  const [encodedHeader, encodedPayload, encodedSignature, extra] = String(token || "").split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) throw new Error("Invalid SSO token format.");
  const header = decodeJsonPart(encodedHeader);
  const claims = decodeJsonPart(encodedPayload);
  if (!header || !claims || header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid || header.crit) throw new Error("Unsupported Cheaply Auth signing key.");
  const jwks = await providerJson(`${AUTH_ORIGIN}/jwks.json`, {
    headers: { accept: "application/json" }
  }, fetchImpl);
  const keys = Array.isArray(jwks.keys) ? jwks.keys.filter((candidate) => candidate?.kid === header.kid && candidate?.kty === "EC" && candidate?.crv === "P-256"
    && (!candidate.alg || candidate.alg === "ES256") && (!candidate.use || candidate.use === "sig")
    && (!candidate.key_ops || (Array.isArray(candidate.key_ops) && candidate.key_ops.includes("verify")))) : [];
  const jwk = keys.length === 1 ? keys[0] : null;
  if (!jwk) throw new Error("The Cheaply Auth signing key is unknown.");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const validSignature = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlDecode(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!validSignature) throw new Error("The Cheaply SSO signature is invalid.");
  if (claims.iss !== AUTH_ORIGIN || !audienceIncludes(claims.aud, expectedAudience)) throw new Error("The Cheaply SSO token was issued for another application.");
  if ((claims.azp !== undefined && claims.azp !== expectedAudience) || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== expectedAudience)) {
    throw new Error("The Cheaply SSO token has another authorized party.");
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.exp <= claims.iat
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60))) throw new Error("The Cheaply SSO token is expired or not active.");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new Error("The Cheaply SSO identity is incomplete.");
  if (expectedNonce !== undefined && (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, expectedNonce))) {
    throw new Error("The Cheaply SSO nonce does not match this request.");
  }
  if (claims.at_hash !== undefined) {
    if (typeof accessToken !== "string" || !accessToken) throw new Error("The Cheaply SSO token pair is incomplete.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(accessToken)));
    if (typeof claims.at_hash !== "string" || !constantTimeEqual(claims.at_hash, base64UrlEncode(digest.subarray(0, 16)))) {
      throw new Error("The Cheaply SSO token pair does not match.");
    }
  }
  // Identity may be intentionally sparse. Authorization is performed only
  // after subject-bound UserInfo has supplied a verified email and role.
  if (claims.role === "member") claims.role = "employee";
  return claims;
}

function completeIdentity(claims, profile, clientId, { legacy = false } = {}) {
  const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
  const role = profile.role === "member" ? "employee" : profile.role;
  if (profile.sub !== claims.sub || (profile.iss !== undefined && profile.iss !== AUTH_ORIGIN)
    || (profile.aud !== undefined && !audienceIncludes(profile.aud, clientId))) throw new Error("The Cheaply SSO UserInfo belongs to another identity.");
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || !["admin", "employee"].includes(role)
    || (legacy ? profile.email_verified === false : profile.email_verified !== true)) throw new Error("The Cheaply SSO identity is incomplete or unverified.");
  if ((claims.email !== undefined && (typeof claims.email !== "string" || claims.email.trim().toLowerCase() !== email))
    || (claims.role !== undefined && claims.role !== role)
    || claims.email_verified === false) throw new Error("The Cheaply SSO identity claims do not match UserInfo.");
  return { sub: claims.sub, email, role, name: typeof profile.name === "string" ? profile.name.slice(0, 160) : "" };
}

function configuredAdminEmails(env) {
  return new Set(String(env.TRACKING_ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function identityMayAdmin(claims, env = {}) {
  const email = String(claims?.email || "").trim().toLowerCase();
  return claims?.role === "admin" || configuredAdminEmails(env).has(email);
}

export async function finishDashboardLogin(request, env, {
  now = Math.floor(Date.now() / 1000),
  fetchImpl = fetch
} = {}) {
  if (!isStrongSecret(env.SESSION_SECRET) || !isStrongSecret(env.TRACKING_CLIENT_SECRET)) {
    throw new Error("Dashboard SSO secrets are not configured.");
  }
  const url = new URL(request.url);
  const pending = await verifyAuthPayload(getCookie(request, REQUEST_COOKIE), env.SESSION_SECRET, now);
  const legacyPending = pending && pending.version === undefined && pending.nonce === undefined && pending.clientId === undefined;
  if (!pending || typeof pending.state !== "string" || !pending.state || !constantTimeEqual(pending.state, url.searchParams.get("state"))
    || typeof pending.verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(pending.verifier)
    || !url.searchParams.get("code") || url.searchParams.get("error")
    || (!legacyPending && (pending.version !== 2 || typeof pending.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(pending.nonce)
      || typeof pending.clientId !== "string" || !pending.clientId))
    || (pending.iat !== undefined && (!Number.isFinite(pending.iat) || pending.iat > now + 60 || pending.exp - pending.iat > REQUEST_TTL_SECONDS))) {
    throw new Error("The SSO request is invalid or expired.");
  }
  const clientId = legacyPending ? cheaplyAuthClientId(env) : pending.clientId;
  const tokenPayload = await providerJson(`${AUTH_ORIGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: env.TRACKING_CLIENT_SECRET,
      redirect_uri: CALLBACK_URI,
      code: url.searchParams.get("code"),
      code_verifier: pending.verifier
    })
  }, fetchImpl);
  if (!tokenPayload.id_token) throw new Error("Cheaply SSO did not accept the authorization code.");
  const accessToken = tokenPayload.access_token;
  const idClaims = await verifyCentralIdToken(tokenPayload.id_token, { now, fetchImpl, expectedAudience: clientId,
    expectedNonce: legacyPending ? undefined : pending.nonce, accessToken });
  let claims;
  if (typeof accessToken === "string" && accessToken && accessToken.length <= 16_384 && !/[\s\x00-\x1f\x7f]/.test(accessToken)
    && String(tokenPayload.token_type || "").toLowerCase() === "bearer") {
    const profile = await providerJson(`${AUTH_ORIGIN}/userinfo`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, fetchImpl);
    claims = completeIdentity(idClaims, profile, clientId);
  } else if (legacyPending && accessToken === undefined) {
    // Only an already-started, signed pre-upgrade PKCE transaction may use
    // the old rich JWT contract. A failed UserInfo request never downgrades.
    claims = completeIdentity(idClaims, idClaims, clientId, { legacy: true });
  } else {
    throw new Error("The Cheaply SSO access token is missing or invalid.");
  }
  if (!identityMayAdmin(claims, env)) throw new Error("This Cheaply account does not have tracking administrator access.");
  const session = await signAuthPayload({
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    role: String(claims.role),
    name: String(claims.name || ""),
    jti: randomToken(18),
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  }, env.SESSION_SECRET);
  return redirect(safeReturnTo(pending.returnTo), [
    cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS),
    cookie(REQUEST_COOKIE, "", 0)
  ]);
}

export async function readDashboardSession(request, env, now = Math.floor(Date.now() / 1000)) {
  const session = await verifyAuthPayload(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET, now);
  return session && identityMayAdmin(session, env) ? session : null;
}

export async function csrfTokenForSession(session, secret) {
  if (!session?.jti || !isStrongSecret(secret)) return "";
  return hmac(`csrf.${session.jti}`, secret);
}

export async function dashboardAdminAuth(request, env) {
  const session = await readDashboardSession(request, env);
  return session
    ? { authorized: true, method: "session", principal: session }
    : { authorized: false, method: "none", principal: null };
}

export async function validDashboardCsrf(request, adminAuth, env) {
  if (!adminAuth?.authorized || adminAuth.method !== "session") return Boolean(adminAuth?.authorized);
  const supplied = request.headers.get("x-csrf-token") || "";
  const expected = await csrfTokenForSession(adminAuth.principal, env.SESSION_SECRET);
  return Boolean(supplied && constantTimeEqual(supplied, expected));
}

export async function handleDashboardAuth(request, env, url) {
  if (url.pathname === "/api/auth/login" && request.method === "GET") return beginDashboardLogin(request, env);
  if (url.pathname === "/api/auth/callback" && request.method === "GET") {
    try {
      return await finishDashboardLogin(request, env);
    } catch {
      return redirect("/?auth_error=sso", [cookie(REQUEST_COOKIE, "", 0)]);
    }
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const session = await readDashboardSession(request, env);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
    return Response.json({
      ok: true,
      user: { sub: session.sub, email: session.email, role: "admin", name: session.name || session.email },
      csrfToken: await csrfTokenForSession(session, env.SESSION_SECRET)
    }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const session = await readDashboardSession(request, env);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
    const supplied = request.headers.get("x-csrf-token") || "";
    const expected = await csrfTokenForSession(session, env.SESSION_SECRET);
    if (!supplied || !constantTimeEqual(supplied, expected)) {
      return Response.json({ error: "Invalid or missing CSRF token" }, { status: 403, headers: { "cache-control": "no-store" } });
    }
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", cookie(SESSION_COOKIE, "", 0));
    headers.append("set-cookie", cookie(REQUEST_COOKIE, "", 0));
    return Response.json({ ok: true }, { headers });
  }
  return null;
}

export const dashboardAuthConfig = Object.freeze({
  authOrigin: AUTH_ORIGIN,
  appOrigin: APP_ORIGIN,
  clientId: DEFAULT_CLIENT_ID,
  callbackUri: CALLBACK_URI,
  sessionCookie: SESSION_COOKIE,
  requestCookie: REQUEST_COOKIE
});
