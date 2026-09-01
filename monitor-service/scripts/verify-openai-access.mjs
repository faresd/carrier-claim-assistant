const OPENAI_API_ORIGIN = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5-mini";

function cleanModel(value) {
  const model = String(value || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(model)) {
    throw new Error("OPENAI_MODEL contains unsupported characters.");
  }
  return model;
}

export async function verifyOpenAiAccess({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL || DEFAULT_MODEL,
  fetchImpl = fetch
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    console.log("OPENAI_API_KEY is not configured; skipping optional OpenAI access verification.");
    return { ok: true, skipped: true };
  }

  const selectedModel = cleanModel(model);
  let response;
  try {
    response = await fetchImpl(`${OPENAI_API_ORIGIN}/v1/models/${encodeURIComponent(selectedModel)}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${key}`
      }
    });
  } catch {
    throw new Error("OpenAI API access verification could not reach the official endpoint.");
  }

  if (!response.ok) {
    throw new Error(`OpenAI API did not authorize the configured credential for ${selectedModel} (HTTP ${response.status}).`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload || payload.id !== selectedModel) {
    throw new Error(`OpenAI API returned an unexpected model response for ${selectedModel}.`);
  }

  console.log(`OpenAI API authorized model ${selectedModel}.`);
  return { ok: true, skipped: false, model: selectedModel };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyOpenAiAccess().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
