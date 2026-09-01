import test from "node:test";
import assert from "node:assert/strict";
import { verifyProductionMonitor } from "../scripts/smoke-production.mjs";

function successfulResponse(url) {
  const path = new URL(url).pathname;
  if (path === "/api/health") return Response.json({ ok: true, service: "carrier-return-monitor" });
  if (path === "/") {
    return new Response("dashboard", {
      status: 200,
      headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }
    });
  }
  if (path === "/api/orders") return Response.json({ error: "Sign in required." }, { status: 401 });
  if (path === "/api/auth/login") {
    return new Response(null, {
      status: 302,
      headers: { location: "https://auth.cheaply.fr/authorize?client_id=tracking-web&code_challenge_method=S256" }
    });
  }
  return new Response("missing", { status: 404 });
}

test("verifies the live health, dashboard policy, API boundary, and SSO redirect", async () => {
  const visited = [];
  const result = await verifyProductionMonitor({
    fetchImpl: async (url) => {
      visited.push(new URL(url).pathname);
      return successfulResponse(url);
    },
    attempts: 1
  });
  assert.equal(result, true);
  assert.deepEqual(visited, ["/api/health", "/", "/api/orders", "/api/auth/login"]);
});

test("retries a temporary custom-domain failure before succeeding", async () => {
  let healthAttempts = 0;
  let waits = 0;
  await verifyProductionMonitor({
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/health" && healthAttempts++ === 0) throw new Error("TLS is provisioning");
      return successfulResponse(url);
    },
    attempts: 2,
    retryDelayMs: 1,
    waitImpl: async () => { waits += 1; }
  });
  assert.equal(healthAttempts, 2);
  assert.equal(waits, 1);
});

test("rejects an unsafe or path-qualified monitor origin", async () => {
  await assert.rejects(() => verifyProductionMonitor({ baseUrl: "http://tracking.cheaply.fr", attempts: 1 }), /HTTPS origin/);
  await assert.rejects(() => verifyProductionMonitor({ baseUrl: "https://tracking.cheaply.fr/other", attempts: 1 }), /HTTPS origin/);
});
