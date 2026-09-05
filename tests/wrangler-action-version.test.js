"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "deploy-monitor.yml"), "utf8");

test("deploys static-asset authentication with Wrangler 4", () => {
  assert.equal((workflow.match(/cloudflare\/wrangler-action@v4/g) || []).length, 2);
  assert.equal((workflow.match(/wranglerVersion: "4"/g) || []).length, 2);
  assert.doesNotMatch(workflow, /cloudflare\/wrangler-action@v3/);
});
