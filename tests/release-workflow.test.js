"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

const workflow = readFileSync(path.join(__dirname, "..", ".github/workflows/release.yml"), "utf8");
const lines = workflow.split("\n");
const stepIndex = lines.findIndex((line) => line.trim() === "- name: Publish GitHub release");
const runIndex = lines.findIndex((line, index) => index > stepIndex && line === "        run: |");
assert.ok(stepIndex >= 0 && runIndex > stepIndex, "release publishing must have an executable bash block");
const shellLines = [];
for (let index = runIndex + 1; index < lines.length; index += 1) {
  if (lines[index].trim() && !lines[index].startsWith("          ")) break;
  shellLines.push(lines[index].slice(10));
}
const publishScript = shellLines.join("\n");

// Exercise the workflow's real shell control flow. Only external GitHub I/O is
// replaced; glob expansion, comparison, exit behavior and files are real.
const mockGitHub = `
gh() {
  printf '%s ' "$@" >> "$MOCK_LOG"
  printf '\\n' >> "$MOCK_LOG"
  case "$1 $2" in
    'api --paginate')
      if [ "$MOCK_LOOKUP_EXIT" -ne 0 ]; then echo 'GitHub lookup failed' >&2; return "$MOCK_LOOKUP_EXIT"; fi
      printf '%s\\n' "$MOCK_RELEASE_TAGS"
      ;;
    'release view') printf '%s\\n' "$MOCK_ASSET_NAMES" ;;
    'release download')
      if [ "$MOCK_DOWNLOAD_EXIT" -ne 0 ]; then return "$MOCK_DOWNLOAD_EXIT"; fi
      destination=''
      while [ "$#" -gt 0 ]; do
        if [ "$1" = '--dir' ]; then destination="$2"; break; fi
        shift
      done
      cp "$MOCK_EXISTING_ARCHIVE" "$destination/$MOCK_ASSET_NAME"
      ;;
    'release upload') return "$MOCK_UPLOAD_EXIT" ;;
    'release create') return "$MOCK_CREATE_EXIT" ;;
    *) echo 'Unexpected GitHub command' >&2; return 99 ;;
  esac
}
`;

function runPublish(context, overrides = {}, { archive = true, existingBytes = "verified extension package" } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "carrier-release-workflow-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "dist"));
  const assetName = "carrier-claim-assistant-v2.10.1.zip";
  if (archive) writeFileSync(path.join(directory, "dist", assetName), "verified extension package");
  writeFileSync(path.join(directory, "existing.zip"), existingBytes);
  const logPath = path.join(directory, "commands.log");
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc"], {
    cwd: directory,
    input: `${mockGitHub}\n${publishScript}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_TOKEN: "synthetic-test-token",
      GITHUB_REF_NAME: "v2.10.1",
      GITHUB_REPOSITORY: "faresd/carrier-claim-assistant",
      TMPDIR: directory,
      MOCK_LOG: logPath,
      MOCK_ASSET_NAME: assetName,
      MOCK_EXISTING_ARCHIVE: path.join(directory, "existing.zip"),
      MOCK_RELEASE_TAGS: "",
      MOCK_ASSET_NAMES: "",
      MOCK_LOOKUP_EXIT: "0",
      MOCK_DOWNLOAD_EXIT: "0",
      MOCK_UPLOAD_EXIT: "0",
      MOCK_CREATE_EXIT: "0",
      ...overrides
    }
  });
  if (result.error) throw result.error;
  return { ...result, commands: existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [] };
}

test("creates a missing release with the verified ZIP, existing tag and generated notes", (context) => {
  const result = runPublish(context, { MOCK_RELEASE_TAGS: "v2.10.0\nv2.10.10" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commands.length, 2);
  assert.match(result.commands[0], /^api --paginate repos\/faresd\/carrier-claim-assistant\/releases\?per_page=100/);
  assert.match(result.commands[1], /^release create v2\.10\.1 dist\/carrier-claim-assistant-v2\.10\.1\.zip .*--verify-tag --generate-notes/);
});

test("attaches the verified ZIP when a manually created release already exists without assets", (context) => {
  const result = runPublish(context, { MOCK_RELEASE_TAGS: "v2.10.1\nv2.10.0" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commands.length, 3);
  assert.match(result.commands[2], /^release upload v2\.10\.1 dist\/carrier-claim-assistant-v2\.10\.1\.zip/);
  assert.ok(result.commands.every((command) => !command.startsWith("release create ")));
});

test("a repeat publish verifies identical bytes without deleting or replacing the asset", (context) => {
  const result = runPublish(context, {
    MOCK_RELEASE_TAGS: "v2.10.1",
    MOCK_ASSET_NAMES: "carrier-claim-assistant-v2.10.1.zip"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already attached/);
  assert.ok(result.commands.some((command) => command.startsWith("release download ")));
  assert.ok(result.commands.every((command) => !/release (?:create|upload|delete)/.test(command)));
});

test("different existing bytes fail without overwriting the published artifact", (context) => {
  const result = runPublish(context, {
    MOCK_RELEASE_TAGS: "v2.10.1", MOCK_ASSET_NAMES: "carrier-claim-assistant-v2.10.1.zip"
  }, { existingBytes: "different package" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from the verified build/);
  assert.ok(result.commands.every((command) => !/release (?:create|upload|delete)/.test(command)));
});

test("authentication and network lookup failures never fall through to release creation", (context) => {
  const result = runPublish(context, { MOCK_LOOKUP_EXIT: "4" });
  assert.equal(result.status, 4);
  assert.equal(result.commands.length, 1);
});

test("an upload failure remains a failed workflow rather than reporting success", (context) => {
  const result = runPublish(context, { MOCK_RELEASE_TAGS: "v2.10.1", MOCK_UPLOAD_EXIT: "7" });
  assert.equal(result.status, 7);
});

test("a failed existing-asset download cannot be mistaken for successful verification", (context) => {
  const result = runPublish(context, {
    MOCK_RELEASE_TAGS: "v2.10.1", MOCK_ASSET_NAMES: "carrier-claim-assistant-v2.10.1.zip", MOCK_DOWNLOAD_EXIT: "8"
  });
  assert.equal(result.status, 8);
  assert.doesNotMatch(result.stdout, /already attached/);
});

test("a missing build artifact fails before any GitHub operation", (context) => {
  const result = runPublish(context, {}, { archive: false });
  assert.equal(result.status, 1);
  assert.deepEqual(result.commands, []);
});

test("release publishing consumes the successful build and retains job-scoped write permission", () => {
  const job = workflow.match(/  github-release:\n([\s\S]*?)\n  chrome-web-store:/)?.[1];
  assert.ok(job);
  assert.match(job, /needs: build/);
  assert.match(job, /permissions:\n      contents: write/);
  assert.match(workflow, /\npermissions:\n  contents: read/);
});
