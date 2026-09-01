const AUTH_ORIGIN = "https://auth.cheaply.fr";
const APP_ORIGIN = "https://tracking.cheaply.fr";
const CLIENT_ID = "tracking-web";
const CALLBACK_URI = `${APP_ORIGIN}/api/auth/callback`;
const SESSION_COOKIE = "__Host-carrier_monitor_session";
const REQUEST_COOKIE = "__Host-carrier_monitor_oauth";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const REQUEST_TTL_SECONDS = 10 * 60;
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
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return "/";
  try {
    const parsed = new URL(candidate, APP_ORIGIN);
    return parsed.origin === APP_ORIGIN ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
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
  const url = new URL(request.url);
  const state = randomToken(32);
  const verifier = randomToken(64);
  const pending = await signAuthPayload({
    state,
    verifier,
    returnTo: safeReturnTo(url.searchParams.get("return_to")),
    iat: now,
    exp: now + REQUEST_TTL_SECONDS
  }, env.SESSION_SECRET);
  const authorization = new URL(`${AUTH_ORIGIN}/authorize`);
  authorization.searchParams.set("client_id", CLIENT_ID);
  authorization.searchParams.set("redirect_uri", CALLBACK_URI);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  return redirect(authorization.toString(), [cookie(REQUEST_COOKIE, pending, REQUEST_TTL_SECONDS)]);
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
  expectedAudience = CLIENT_ID
} = {}) {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = String(token || "").split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) throw new Error("Invalid SSO token format.");
  const header = decodeJsonPart(encodedHeader);
  const claims = decodeJsonPart(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported SSO signing key.");
  const jwksResponse = await fetchImpl(`${AUTH_ORIGIN}/.well-known/jwks.json`, {
    headers: { accept: "application/json" }
  });
  if (!jwksResponse.ok) throw new Error("Unable to load the Cheaply SSO signing keys.");
  const jwks = await jwksResponse.json();
  const jwk = Array.isArray(jwks?.keys) ? jwks.keys.find((candidate) => candidate?.kid === header.kid && candidate?.kty === "RSA") : null;
  if (!jwk) throw new Error("The Cheaply SSO signing key is unknown.");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!validSignature) throw new Error("The Cheaply SSO signature is invalid.");
  if (claims.iss !== AUTH_ORIGIN || !audienceIncludes(claims.aud, expectedAudience)) throw new Error("The Cheaply SSO token was issued for another application.");
  if (!Number.isFinite(claims.exp) || claims.exp <= now || (Number.isFinite(claims.iat) && claims.iat > now + 60)) throw new Error("The Cheaply SSO token is expired or not active.");
  if (!claims.sub || !/^[^\s@]+@[^\s@]+$/.test(String(claims.email || "")) || !["admin", "employee"].includes(claims.role)) {
    throw new Error("The Cheaply SSO identity is incomplete.");
  }
  return claims;
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
  if (!pending || pending.state !== url.searchParams.get("state") || !url.searchParams.get("code")) throw new Error("The SSO request is invalid or expired.");
  const tokenResponse = await fetchImpl(`${AUTH_ORIGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: env.TRACKING_CLIENT_SECRET,
      redirect_uri: CALLBACK_URI,
      code: url.searchParams.get("code"),
      code_verifier: pending.verifier
    })
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.id_token) throw new Error("Cheaply SSO did not accept the authorization code.");
  const claims = await verifyCentralIdToken(tokenPayload.id_token, { now, fetchImpl });
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
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (env.ADMIN_TOKEN && bearer && constantTimeEqual(bearer, env.ADMIN_TOKEN)) {
    return { authorized: true, method: "token", principal: { sub: "emergency-admin", email: "", role: "admin", name: "Emergency admin" } };
  }
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
      return redirect("/?auth_error=sso", [cookie(REQUEST_COOKIE, "", 0), cookie(SESSION_COOKIE, "", 0)]);
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
    return Response.json({ ok: true }, {
      headers: { "cache-control": "no-store", "set-cookie": cookie(SESSION_COOKIE, "", 0) }
    });
  }
  return null;
}

export const dashboardAuthConfig = Object.freeze({
  authOrigin: AUTH_ORIGIN,
  appOrigin: APP_ORIGIN,
  clientId: CLIENT_ID,
  callbackUri: CALLBACK_URI,
  sessionCookie: SESSION_COOKIE,
  requestCookie: REQUEST_COOKIE
});
