import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../admin/app.js", import.meta.url), "utf8");
const apiStart = source.indexOf("  async function api(path, options = {}) {");
const apiEnd = source.indexOf("\n  function startLogin()", apiStart);
const logoutStart = source.indexOf('  document.getElementById("logout").addEventListener("click", async (event) => {');
const logoutEnd = source.indexOf("\n\n  async function start()", logoutStart);
assert.ok(apiStart >= 0 && apiEnd > apiStart && logoutStart >= 0 && logoutEnd > logoutStart,
  "Exercise the real API helper and registered logout handler, not a test-only implementation");

function browser(fetchResponse) {
  const button = { disabled: false };
  const state = { csrfToken: "fixture-current-csrf", authenticated: true, user: { email: "fixture@example.com" }, orders: [{ id: "existing-order" }] };
  const before = structuredClone(state);
  const requests = [], navigations = [], notices = [];
  let click;
  const context = {
    state, AbortSignal,
    document: { getElementById(id) {
      assert.equal(id, "logout");
      return { addEventListener(event, callback) { assert.equal(event, "click"); click = callback; } };
    } },
    async fetch(url, options) {
      assert.equal(this, undefined, "Native fetch must not receive an options object as its receiver");
      requests.push({ url, options });
      return fetchResponse(url, options);
    },
    location: { replace: value => navigations.push(value) },
    notify: message => notices.push(message),
    localStorage: { clear() { assert.fail("Logout must not clear browser storage"); }, removeItem() { assert.fail("Logout must not clear browser storage"); } },
  };
  vm.runInNewContext('"use strict";\n' + source.slice(apiStart, apiEnd) + "\n" + source.slice(logoutStart, logoutEnd), context);
  function press() {
    const event = { currentTarget: button };
    const pending = click(event);
    // A real browser resets Event.currentTarget after synchronous dispatch.
    event.currentTarget = null;
    return pending;
  }
  return { button, state, before, requests, navigations, notices, press };
}

function assertUnchanged(b) {
  assert.deepEqual(b.state, b.before, "Unconfirmed logout must not discard dashboard state or CSRF");
  assert.deepEqual(b.navigations, []);
  assert.equal(b.button.disabled, false, "A failed attempt must be retryable");
  assert.equal(b.notices.length, 1);
  assert.match(b.notices[0], /could not be confirmed/);
  assert.doesNotMatch(b.notices[0], /signed out|private-diagnostic/i);
}

test("logout waits for confirmed JSON success, preserves CSRF and uses receiver-safe native fetch", async () => {
  let finish;
  const b = browser(() => new Promise(resolve => { finish = resolve; }));
  const pending = b.press();
  assert.equal(b.button.disabled, true);
  assert.deepEqual(b.navigations, []);
  const { url, options } = b.requests[0];
  assert.equal(url, "/api/auth/logout");
  assert.equal(options.method, "POST");
  assert.equal(options.body, "{}");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.redirect, "manual");
  assert.equal(options.headers["content-type"], "application/json");
  assert.equal(options.headers["x-csrf-token"], b.before.csrfToken);
  assert.ok(options.signal instanceof AbortSignal);
  await b.press();
  assert.equal(b.requests.length, 1, "Pending logout must not submit twice");
  finish(Response.json({ ok: true }));
  await pending;
  assert.deepEqual(b.navigations, ["/?signed_out=1"]);
  assert.deepEqual(b.notices, []);
  assert.equal(b.button.disabled, true);
  assert.deepEqual(b.state, b.before);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`HTTP ${status} never counts as successful logout, even with an ok:true body`, async () => {
    const b = browser(() => Response.json({ ok: true, error: "private-diagnostic" }, { status }));
    await b.press();
    assertUnchanged(b);
  });
}

for (const [name, response] of [
  ["ok:false", () => Response.json({ ok: false })],
  ["missing confirmation", () => Response.json({})],
  ["non-boolean confirmation", () => Response.json({ ok: "true" })],
  ["JSON null", () => Response.json(null)],
  ["malformed JSON", () => new Response("<html>Sign in</html>", { status: 200 })],
  ["empty 204", () => new Response(null, { status: 204 })],
  ["manual redirect", () => Response.redirect("https://auth.cheaply.fr/authorize", 302)],
  ["browser opaque redirect", () => ({ ok: false, status: 0, json: async () => { throw new Error("Opaque response"); } })],
]) {
  test(`${name} does not navigate or claim signed out`, async () => {
    const b = browser(response);
    await b.press();
    assertUnchanged(b);
  });
}

for (const name of ["network failure", "timeout"]) {
  test(`${name} leaves the current page available and permits a successful retry`, async () => {
    let attempts = 0;
    const b = browser(() => {
      if (++attempts === 1) throw name === "timeout" ? new DOMException("private-diagnostic", "TimeoutError") : new TypeError("private-diagnostic");
      return Response.json({ ok: true });
    });
    await b.press();
    assertUnchanged(b);
    await b.press();
    assert.equal(b.requests.length, 2);
    assert.deepEqual(b.navigations, ["/?signed_out=1"]);
    assert.equal(b.notices.length, 1);
  });
}
