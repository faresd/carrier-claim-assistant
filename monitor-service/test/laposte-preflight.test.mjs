import test from "node:test";
import assert from "node:assert/strict";
import { verifyLaPosteAccess } from "../scripts/verify-laposte-access.mjs";

test("verifies the configured key against the official Suivi v2 endpoint", async () => {
  let request = null;
  const result = await verifyLaPosteAccess({
    apiKey: "secret-okapi-key",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return Response.json({ returnCode: 400, returnMessage: "Identifiant inconnu" }, { status: 200 });
    }
  });

  assert.equal(result, true);
  assert.equal(request.url, "https://api.laposte.fr/suivi/v2/idships/CCAUDIT000000FR?lang=fr_FR");
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.headers.accept, "application/json");
  assert.equal(request.options.headers["X-Okapi-Key"], "secret-okapi-key");
});

test("fails before deployment when La Poste rejects the configured key", async () => {
  await assert.rejects(
    verifyLaPosteAccess({
      apiKey: "rejected-key",
      fetchImpl: async () => Response.json({ code: "UNAUTHORIZED" }, { status: 401 })
    }),
    /did not authorize the configured application key \(HTTP 401\)/
  );
});

test("fails safely when Suivi v2 is unavailable or returns a non-JSON page", async () => {
  await assert.rejects(
    verifyLaPosteAccess({
      apiKey: "valid-key",
      fetchImpl: async () => Response.json({ error: "unavailable" }, { status: 503 })
    }),
    /not ready for a production deployment check \(HTTP 503\)/
  );
  await assert.rejects(
    verifyLaPosteAccess({
      apiKey: "valid-key",
      fetchImpl: async () => new Response("maintenance", { status: 200, headers: { "content-type": "text/html" } })
    }),
    /did not return its JSON API response/
  );
});
