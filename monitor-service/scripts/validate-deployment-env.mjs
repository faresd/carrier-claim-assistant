import { pathToFileURL } from "node:url";

const REQUIRED = [
  "CF_ACCOUNT_ID",
  "CF_D1_DATABASE_ID",
  "CF_API_TOKEN",
  "LAPOSTE_OKAPI_KEY",
  "MONITOR_SESSION_SECRET",
  "MONITOR_TRACKING_CLIENT_SECRET",
  "CHEAPLY_AUTH_CLIENT_ID"
];

function configured(environment, name) {
  return String(environment[name] || "").trim();
}

export function validateDeploymentEnvironment(environment = process.env) {
  const errors = [];
  for (const name of REQUIRED) {
    if (!configured(environment, name)) errors.push(`${name} is not configured.`);
  }

  const accountId = configured(environment, "CF_ACCOUNT_ID");
  const databaseId = configured(environment, "CF_D1_DATABASE_ID");
  const apiToken = configured(environment, "CF_API_TOKEN");
  const okapiKey = configured(environment, "LAPOSTE_OKAPI_KEY");
  const sessionSecret = configured(environment, "MONITOR_SESSION_SECRET");
  const trackingSecret = configured(environment, "MONITOR_TRACKING_CLIENT_SECRET");
  const cheaplyAuthClientId = configured(environment, "CHEAPLY_AUTH_CLIENT_ID");

  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) errors.push("CF_ACCOUNT_ID must be a 32-character Cloudflare account ID.");
  if (databaseId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(databaseId)) {
    errors.push("CF_D1_DATABASE_ID must be a valid D1 database UUID.");
  }
  if (apiToken && apiToken.length < 20) errors.push("CF_API_TOKEN appears incomplete.");
  if (okapiKey && okapiKey.length < 8) errors.push("LAPOSTE_OKAPI_KEY appears incomplete.");
  if (sessionSecret && sessionSecret.length < 32) errors.push("MONITOR_SESSION_SECRET must contain at least 32 characters.");
  if (trackingSecret && trackingSecret.length < 32) errors.push("MONITOR_TRACKING_CLIENT_SECRET must contain at least 32 characters.");
  if (cheaplyAuthClientId && !/^(ca_|cm_sso_)[A-Za-z0-9_-]{24}$/.test(cheaplyAuthClientId)) {
    errors.push("CHEAPLY_AUTH_CLIENT_ID must be a central Cheaply Auth client id.");
  }
  if (sessionSecret && trackingSecret && sessionSecret === trackingSecret) {
    errors.push("Use different values for MONITOR_SESSION_SECRET and MONITOR_TRACKING_CLIENT_SECRET.");
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateDeploymentEnvironment();
  if (errors.length) {
    console.error(`Deployment configuration is incomplete:\n- ${errors.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("Deployment configuration is ready.");
  }
}
