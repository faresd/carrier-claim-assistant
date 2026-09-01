import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://tracking.cheaply.fr";

async function verifyOnce(origin, fetchImpl) {
  const health = await fetchImpl(`${origin}/api/health`, { redirect: "manual", headers: { accept: "application/json" } });
  const healthPayload = await health.json().catch(() => ({}));
  if (health.status !== 200 || healthPayload.ok !== true || healthPayload.ready !== true || healthPayload.service !== "carrier-return-monitor") {
    throw new Error(`Health endpoint returned HTTP ${health.status}.`);
  }

  const dashboard = await fetchImpl(`${origin}/`, { redirect: "manual", headers: { accept: "text/html" } });
  const policy = dashboard.headers.get("content-security-policy") || "";
  if (dashboard.status !== 200 || !policy.includes("default-src 'self'") || !policy.includes("frame-ancestors 'none'")) {
    throw new Error("Dashboard or its security policy is unavailable.");
  }

  const orders = await fetchImpl(`${origin}/api/orders`, {
    redirect: "manual",
    headers: { accept: "application/json", origin: "https://malicious.invalid" }
  });
  if (orders.status !== 401 || orders.headers.get("access-control-allow-origin")) {
    throw new Error("Unauthenticated order access is not failing closed.");
  }

  const login = await fetchImpl(`${origin}/api/auth/login?return_to=%2F`, { redirect: "manual" });
  const location = new URL(login.headers.get("location") || "", origin);
  if (login.status !== 302 || location.origin !== "https://auth.cheaply.fr" || location.pathname !== "/authorize") {
    throw new Error("Cheaply SSO authorization redirect is unavailable.");
  }
  if (location.searchParams.get("client_id") !== "tracking-web" || location.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("Cheaply SSO authorization parameters are incomplete.");
  }
  return true;
}

export async function verifyProductionMonitor({
  baseUrl = DEFAULT_ORIGIN,
  fetchImpl = fetch,
  attempts = 15,
  retryDelayMs = 4000,
  waitImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("MONITOR_BASE_URL must be an HTTPS origin.");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyOnce(origin.origin, fetchImpl);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await waitImpl(retryDelayMs);
    }
  }
  throw new Error(`Production smoke test failed after ${attempts} attempts: ${lastError?.message || "unknown error"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyProductionMonitor({ baseUrl: process.env.MONITOR_BASE_URL || DEFAULT_ORIGIN });
  console.log("Production monitor smoke test passed.");
}
