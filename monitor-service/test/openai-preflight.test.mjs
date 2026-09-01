import test from "node:test";
import assert from "node:assert/strict";
import { verifyOpenAiAccess } from "../scripts/verify-openai-access.mjs";

test("skips OpenAI access verification when the optional key is absent", async () => {
  let requested = false;
  const result = await verifyOpenAiAccess({
    apiKey: "",
    fetchImpl: async () => {
      requested = true;
      throw new Error("should not run");
    }
  });

  assert.equal(result.skipped, true);
  assert.equal(requested, false);
});

test("verifies a configured OpenAI credential without running an inference", async () => {
  const requests = [];
  const result = await verifyOpenAiAccess({
    apiKey: "test-secret",
    model: "gpt-5-mini",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json({ id: "gpt-5-mini", object: "model" });
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.model, "gpt-5-mini");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.openai.com/v1/models/gpt-5-mini");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-secret");
});

test("fails safely when OpenAI rejects the credential", async () => {
  await assert.rejects(
    () => verifyOpenAiAccess({
      apiKey: "rejected-secret",
      fetchImpl: async () => Response.json({ error: { message: "invalid" } }, { status: 401 })
    }),
    /did not authorize.*HTTP 401/i
  );
});

test("rejects an unsafe model name before network access", async () => {
  let requested = false;
  await assert.rejects(
    () => verifyOpenAiAccess({
      apiKey: "test-secret",
      model: "gpt-5-mini/../../secrets",
      fetchImpl: async () => {
        requested = true;
        return Response.json({});
      }
    }),
    /unsupported characters/i
  );
  assert.equal(requested, false);
});
