import test from "node:test";
import assert from "node:assert/strict";
import { validateDeploymentEnvironment } from "../scripts/validate-deployment-env.mjs";

const valid = {
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CF_D1_DATABASE_ID: "3f2f6bbd-2d96-40b4-9f82-ed09a40a61a8",
  CF_API_TOKEN: "cloudflare-token-with-sufficient-length",
  LAPOSTE_OKAPI_KEY: "okapi-key",
  MONITOR_SESSION_SECRET: "session-secret-that-is-longer-than-thirty-two-characters",
  MONITOR_TRACKING_CLIENT_SECRET: "tracking-client-secret-that-is-also-longer-than-thirty-two"
};

test("accepts a complete production deployment configuration", () => {
  assert.deepEqual(validateDeploymentEnvironment(valid), []);
});

test("reports every missing deployment setting without printing secret values", () => {
  const errors = validateDeploymentEnvironment({});
  for (const name of Object.keys(valid)) assert.ok(errors.some((error) => error.startsWith(name)));
  assert.equal(errors.join("\n").includes(valid.CF_API_TOKEN), false);
});

test("rejects malformed identifiers, short secrets, and secret reuse", () => {
  const shared = "same-secret-value-that-is-at-least-thirty-two-characters";
  const errors = validateDeploymentEnvironment({
    ...valid,
    CF_ACCOUNT_ID: "wrong",
    CF_D1_DATABASE_ID: "wrong",
    CF_API_TOKEN: "short",
    LAPOSTE_OKAPI_KEY: "short",
    MONITOR_SESSION_SECRET: shared,
    MONITOR_TRACKING_CLIENT_SECRET: shared
  });
  assert.ok(errors.some((error) => error.includes("32-character Cloudflare")));
  assert.ok(errors.some((error) => error.includes("D1 database UUID")));
  assert.ok(errors.some((error) => error.includes("CF_API_TOKEN appears incomplete")));
  assert.ok(errors.some((error) => error.includes("LAPOSTE_OKAPI_KEY appears incomplete")));
  assert.ok(errors.some((error) => error.includes("Use different values")));
});
