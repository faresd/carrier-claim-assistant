import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishChromeWebStore } from "../scripts/publish-chrome-web-store.mjs";

const environment = {
  CWS_CLIENT_ID: "client-id",
  CWS_CLIENT_SECRET: "client-secret",
  CWS_REFRESH_TOKEN: "refresh-token",
  CWS_PUBLISHER_ID: "publisher-id",
  CWS_EXTENSION_ID: "extension-id"
};

function response(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return {
    ok,
    status,
    statusText,
    async text() { return JSON.stringify(body); }
  };
}

function fakeArchive() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "carrier-claim-publisher-"));
  const archive = path.join(directory, "extension.zip");
  writeFileSync(archive, Buffer.from("PK synthetic extension archive"));
  return archive;
}

test("exchanges OAuth, polls upload status, and submits the verified package", async () => {
  const requests = [];
  const replies = [
    response({ access_token: "access-token" }),
    response({ uploadState: "UPLOAD_IN_PROGRESS" }),
    response({ uploadState: "UPLOAD_SUCCESS", crxVersion: "2.8.0" }),
    response({ state: "IN_REVIEW" })
  ];
  const logs = [];
  const result = await publishChromeWebStore({
    archivePath: fakeArchive(),
    environment,
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return replies.shift();
    },
    wait: async () => {},
    log: (message) => logs.push(message)
  });

  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.body.get("grant_type"), "refresh_token");
  assert.equal(requests[1].url, "https://chromewebstore.googleapis.com/upload/v2/publishers/publisher-id/items/extension-id:upload");
  assert.equal(requests[1].options.headers.Authorization, "Bearer access-token");
  assert.equal(requests[1].options.headers["content-type"], "application/zip");
  assert.equal(requests[2].url, "https://chromewebstore.googleapis.com/v2/publishers/publisher-id/items/extension-id:fetchStatus");
  assert.equal(requests[2].options.method, "GET");
  assert.equal(requests[3].url, "https://chromewebstore.googleapis.com/v2/publishers/publisher-id/items/extension-id:publish");
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    publishType: "DEFAULT_PUBLISH",
    skipReview: false,
    blockOnWarnings: true
  });
  assert.equal(result.upload.crxVersion, "2.8.0");
  assert.equal(result.published.state, "IN_REVIEW");
  assert.deepEqual(logs, [
    "Uploaded extension version 2.8.0.",
    "Chrome Web Store submission state: IN_REVIEW."
  ]);
  assert.equal(logs.join(" ").includes(environment.CWS_REFRESH_TOKEN), false);
  assert.equal(logs.join(" ").includes(environment.CWS_CLIENT_SECRET), false);
});

test("fails before network access when required store secrets are missing", async () => {
  let fetched = false;
  await assert.rejects(
    publishChromeWebStore({
      archivePath: fakeArchive(),
      environment: {},
      fetchImplementation: async () => {
        fetched = true;
        return response({});
      }
    }),
    /Missing Chrome Web Store secrets: CWS_CLIENT_ID/
  );
  assert.equal(fetched, false);
});

test("surfaces official upload failure without attempting publication", async () => {
  const requests = [];
  await assert.rejects(
    publishChromeWebStore({
      archivePath: fakeArchive(),
      environment: { ...environment, CWS_PUBLISH_TYPE: "STAGED_PUBLISH" },
      fetchImplementation: async (url, options) => {
        requests.push({ url, options });
        return requests.length === 1
          ? response({ access_token: "access-token" })
          : response({ uploadState: "UPLOAD_FAILURE" });
      }
    }),
    /Package upload did not succeed \(state: UPLOAD_FAILURE\)/
  );
  assert.equal(requests.length, 2);
  assert.equal(requests.some(({ url }) => url.endsWith(":publish")), false);
});

