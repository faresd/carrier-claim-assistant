import test from "node:test";
import assert from "node:assert/strict";
import { verifyTrackingSsoRegistration } from "../scripts/verify-sso-registration.mjs";

test("accepts the registered tracking-web SSO redirect without following it", async () => {
  let requestedUrl = null;
  const result = await verifyTrackingSsoRegistration({
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 303,
        headers: {
          location: "https://mail.cheaply.fr/auth/sso/bridge?state=central-state",
          "set-cookie": "__Host-cheaply_sso_request=signed; Path=/; HttpOnly; Secure; SameSite=Lax"
        }
      });
    }
  });

  assert.equal(result, true);
  assert.equal(requestedUrl.origin, "https://auth.cheaply.fr");
  assert.equal(requestedUrl.pathname, "/authorize");
  assert.equal(requestedUrl.searchParams.get("client_id"), "tracking-web");
  assert.equal(requestedUrl.searchParams.get("redirect_uri"), "https://tracking.cheaply.fr/api/auth/callback");
  assert.equal(requestedUrl.searchParams.get("response_type"), "code");
  assert.equal(requestedUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(requestedUrl.searchParams.get("state"), /^[A-Za-z0-9_-]{32,}$/);
  assert.match(requestedUrl.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
});

test("fails before deployment when tracking-web is not registered", async () => {
  await assert.rejects(
    verifyTrackingSsoRegistration({
      fetchImpl: async () => Response.json({
        error: "invalid_client",
        error_description: "Invalid authorization request."
      }, { status: 400 })
    }),
    /has not accepted the tracking-web production client registration \(HTTP 400\)/
  );
});

test("rejects an accepted client redirect to an untrusted login origin", async () => {
  await assert.rejects(
    verifyTrackingSsoRegistration({
      fetchImpl: async () => new Response(null, {
        status: 303,
        headers: {
          location: "https://malicious.invalid/login",
          "set-cookie": "__Host-cheaply_sso_request=signed"
        }
      })
    }),
    /has not accepted the tracking-web production client registration/
  );
});
