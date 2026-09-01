import { pathToFileURL } from "node:url";

const PROBE_TRACKING_ID = "CCAUDIT000000FR";
const ENDPOINT = `https://api.laposte.fr/suivi/v2/idships/${PROBE_TRACKING_ID}?lang=fr_FR`;

export async function verifyLaPosteAccess({
  apiKey = process.env.LAPOSTE_OKAPI_KEY,
  fetchImpl = fetch,
  allowPending = process.env.LAPOSTE_ALLOW_PENDING === "true"
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("LAPOSTE_OKAPI_KEY is not configured.");
  const response = await fetchImpl(ENDPOINT, {
    redirect: "manual",
    headers: { accept: "application/json", "X-Okapi-Key": key }
  });
  if (response.status === 403 && allowPending) {
    console.warn("La Poste Suivi v2 access is pending provider approval; continuing with infrastructure deployment.");
    return { authorized: false, pending: true };
  }
  if ([401, 403].includes(response.status)) {
    throw new Error(`La Poste Suivi v2 did not authorize the configured application key (HTTP ${response.status}).`);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`La Poste Suivi v2 is not ready for a production deployment check (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("La Poste Suivi v2 did not return its JSON API response.");
  }
  await response.json().catch(() => {
    throw new Error("La Poste Suivi v2 returned invalid JSON.");
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyLaPosteAccess();
    if (result?.pending) {
      console.log("La Poste Suivi v2 access is pending provider approval.");
    } else {
      console.log("La Poste Suivi v2 application access is ready.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
