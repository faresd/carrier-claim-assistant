import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://tracking.cheaply.fr";

async function verifyOnce(origin, fetchImpl) {
  const allowPending = process.env.MONITOR_ALLOW_PENDING === "true";
  const health = await fetchImpl(`${origin}/api/health`, { redirect: "manual", headers: { accept: "application/json" } });
  const healthPayload = await health.json().catch(() => ({}));
  const pendingHealth = allowPending && health.status === 503 && healthPayload.ok === false && healthPayload.ready === false;
  if ((!pendingHealth && (health.status !== 200 || healthPayload.ok !== true || healthPayload.ready !== true)) || healthPayload.service !== "carrier-return-monitor") {
    throw new Error(`Health endpoint returned HTTP ${health.status}.`);
  }

  const dashboard = await fetchImpl(`${origin}/`, { redirect: "manual", headers: { accept: "text/html" } });
  const dashboardLocation = new URL(dashboard.headers.get("location") || "", origin);
  const dashboardCookie = dashboard.headers.get("set-cookie") || "";
  if (dashboard.status !== 302 || dashboardLocation.origin !== "https://auth.cheaply.fr" || dashboardLocation.pathname !== "/authorize" ||
    dashboardLocation.searchParams.get("client_id") !== "tracking-web" || dashboardLocation.searchParams.get("code_challenge_method") !== "S256" ||
    !dashboardCookie.includes("__Host-carrier_monitor_oauth=")) {
    throw new Error(`Unauthenticated dashboard access is not redirecting through Cheaply SSO (HTTP ${dashboard.status}).`);
  }

  const asset = await fetchImpl(`${origin}/app.js`, { redirect: "manual", headers: { accept: "text/javascript" } });
  const assetLocation = new URL(asset.headers.get("location") || "", origin);
  if (asset.status !== 302 || assetLocation.origin !== "https://auth.cheaply.fr" || assetLocation.pathname !== "/authorize") {
    throw new Error(`Unauthenticated dashboard assets are not failing closed (HTTP ${asset.status}).`);
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
