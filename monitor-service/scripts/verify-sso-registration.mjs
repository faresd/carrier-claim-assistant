import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const AUTH_ORIGIN = "https://auth.cheaply.fr";
const CLIENT_ID = "tracking-web";
const CALLBACK_URI = "https://tracking.cheaply.fr/api/auth/callback";
const TRUSTED_LOGIN_ORIGINS = new Set([AUTH_ORIGIN, "https://mail.cheaply.fr"]);

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export async function verifyTrackingSsoRegistration({ fetchImpl = fetch } = {}) {
  const verifier = base64Url(randomBytes(48));
  const authorization = new URL("/authorize", AUTH_ORIGIN);
  authorization.searchParams.set("client_id", CLIENT_ID);
  authorization.searchParams.set("redirect_uri", CALLBACK_URI);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("state", base64Url(randomBytes(32)));
  authorization.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorization.searchParams.set("code_challenge_method", "S256");

  const response = await fetchImpl(authorization, {
    redirect: "manual",
    headers: { accept: "text/html,application/json" }
  });
  const locationValue = response.headers.get("location") || "";
  const loginLocation = locationValue ? new URL(locationValue, AUTH_ORIGIN) : null;
  const requestCookie = response.headers.get("set-cookie") || "";
  if (![302, 303].includes(response.status)
    || !loginLocation
    || !TRUSTED_LOGIN_ORIGINS.has(loginLocation.origin)
    || !requestCookie.includes("__Host-cheaply_sso_request=")) {
    throw new Error(`Cheaply SSO has not accepted the ${CLIENT_ID} production client registration (HTTP ${response.status}).`);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyTrackingSsoRegistration();
    console.log("Cheaply SSO tracking-web registration is ready.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
