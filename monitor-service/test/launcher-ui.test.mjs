import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../admin/app.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
const headers = readFileSync(new URL("../admin/_headers", import.meta.url), "utf8");
const styles = readFileSync(new URL("../admin/styles.css", import.meta.url), "utf8");

test("Carrier launcher binds to the current central Auth subject and keeps legacy sign-in available", () => {
  assert.match(page, /data-cheaply-launcher[^>]+data-current-app="carrier-claim-assistant"[^>]+data-require-subject/);
  assert.match(page, /data-sign-in-url="\/api\/auth\/login\?provider=cheaply-auth/);
  assert.match(page, /https:\/\/auth\.cheaply\.fr\/assets\/cheaply-launcher\.(?:js|css)/);
  assert.match(script, /auth\.user\.provider === "cheaply-auth"/);
  assert.match(script, /launcher\.hidden = !centralIdentity/);
  assert.match(script, /launcher\.dataset\.expectedSubject = centralIdentity \? auth\.user\.sub : ""/);
  assert.match(script, /CheaplyLauncherSetIdentity\?\.\(centralIdentity/);
  assert.match(page, /id="sso-sign-in"/, "existing sign-in stays available");
});

test("only central Auth identities get the shared photo editor entry", () => {
  assert.match(page, /id="edit-photo" href="https:\/\/auth\.cheaply\.fr\/account\/security" hidden/);
  assert.match(script, /getElementById\("edit-photo"\)\.hidden = !centralIdentity/);
  assert.match(page, /data-avatar-selector="#profile-avatar" data-initials-selector="#profile-initials"/);
});

test("both asset paths permit only the trusted Auth origin needed by the launcher", () => {
  for (const policy of [worker, headers]) {
    for (const directive of ["connect-src", "img-src", "script-src", "style-src"]) {
      assert.match(policy, new RegExp(`${directive} '[^']+' https://auth\\.cheaply\\.fr`));
    }
    assert.match(policy, /frame-ancestors 'none'/);
  }
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(styles, /min-width: 980px/);
});
