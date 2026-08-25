import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REQUIRED_ENVIRONMENT = [
  "CWS_CLIENT_ID",
  "CWS_CLIENT_SECRET",
  "CWS_REFRESH_TOKEN",
  "CWS_PUBLISHER_ID",
  "CWS_EXTENSION_ID"
];
const API_BASE = "https://chromewebstore.googleapis.com";

export async function jsonRequest(fetchImplementation, url, options) {
  const response = await fetchImplementation(url, options);
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw.slice(0, 500) };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || response.statusText;
    throw new Error(`Chrome Web Store API ${response.status}: ${message}`);
  }
  return data;
}

export async function publishChromeWebStore({
  archivePath,
  environment = process.env,
  fetchImplementation = globalThis.fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  log = console.log
}) {
  if (!archivePath) throw new Error("Pass the extension ZIP path to publish.");
  const missing = REQUIRED_ENVIRONMENT.filter((name) => !environment[name]);
  if (missing.length) throw new Error(`Missing Chrome Web Store secrets: ${missing.join(", ")}.`);
  if (typeof fetchImplementation !== "function") throw new Error("A Fetch-compatible implementation is required.");

  const publishType = environment.CWS_PUBLISH_TYPE || "DEFAULT_PUBLISH";
  if (!["DEFAULT_PUBLISH", "STAGED_PUBLISH"].includes(publishType)) {
    throw new Error(`Unsupported CWS_PUBLISH_TYPE: ${publishType}.`);
  }

  const publisherId = encodeURIComponent(environment.CWS_PUBLISHER_ID);
  const extensionId = encodeURIComponent(environment.CWS_EXTENSION_ID);
  const itemName = `publishers/${publisherId}/items/${extensionId}`;
  const tokenBody = new URLSearchParams({
    client_id: environment.CWS_CLIENT_ID,
    client_secret: environment.CWS_CLIENT_SECRET,
    refresh_token: environment.CWS_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const token = await jsonRequest(fetchImplementation, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody
  });
  if (!token.access_token) throw new Error("Google OAuth did not return an access token.");

  const authorization = { Authorization: `Bearer ${token.access_token}` };
  let upload = await jsonRequest(fetchImplementation, `${API_BASE}/upload/v2/${itemName}:upload`, {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "application/zip"
    },
    body: readFileSync(path.resolve(archivePath))
  });

  for (let attempt = 0; upload.uploadState === "UPLOAD_IN_PROGRESS" && attempt < 30; attempt += 1) {
    await wait(5000);
    upload = await jsonRequest(fetchImplementation, `${API_BASE}/v2/${itemName}:fetchStatus`, {
      method: "GET",
      headers: authorization
    });
  }
  if (upload.uploadState !== "UPLOAD_SUCCESS") {
    throw new Error(`Package upload did not succeed (state: ${upload.uploadState || "unknown"}).`);
  }
  log(`Uploaded extension version ${upload.crxVersion || "unknown"}.`);

  const published = await jsonRequest(fetchImplementation, `${API_BASE}/v2/${itemName}:publish`, {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      publishType,
      skipReview: false,
      blockOnWarnings: true
    })
  });
  log(`Chrome Web Store submission state: ${published.state || "submitted"}.`);
  return { upload, published };
}

const mainModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (mainModule) {
  await publishChromeWebStore({ archivePath: process.argv[2] });
}

