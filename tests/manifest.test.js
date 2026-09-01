"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const assistantCss = fs.readFileSync(path.join(root, "src", "assistant.css"), "utf8");
const amazonScript = fs.readFileSync(path.join(root, "src", "amazon.js"), "utf8");
const laposteScript = fs.readFileSync(path.join(root, "src", "laposte.js"), "utf8");
const chronopostScript = fs.readFileSync(path.join(root, "src", "chronopost.js"), "utf8");
const backgroundScript = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
const optionsHtml = fs.readFileSync(path.join(root, "src", "options.html"), "utf8");

test("manifest wires the Amazon order assistant and supported carrier pages", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, packageJson.version);
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "notifications"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://tracking.cheaply.fr/*"]);

  const amazon = manifest.content_scripts.find((entry) =>
    entry.matches.includes("https://sellercentral.amazon.fr/orders-v3/order/*")
  );
  assert.deepEqual(amazon.js, [
    "src/shared/order-parser.js",
    "src/shared/carrier-rules.js",
    "src/shared/claim-outcome.js",
    "src/shared/tracking-records.js",
    "src/order-auditor.js",
    "src/amazon.js"
  ]);
  assert.ok(amazon.css.includes("src/assistant.css"));

  const ordersList = manifest.content_scripts.find((entry) => entry.js.includes("src/orders-list.js"));
  assert.ok(ordersList.matches.includes("https://sellercentral.amazon.fr/orders-v3/mfn/*"));
  assert.deepEqual(ordersList.js, [
    "src/shared/carrier-rules.js",
    "src/shared/order-list-rules.js",
    "src/shared/tracking-records.js",
    "src/orders-list.js"
  ]);
  assert.ok(ordersList.css.includes("src/assistant.css"));

  const tracking = manifest.content_scripts.find((entry) => entry.js.includes("src/status-checker.js"));
  assert.ok(tracking.matches.includes("https://www.laposte.fr/outils/suivre-vos-envois*"));
  assert.ok(tracking.matches.includes("https://www.chronopost.fr/fr/suivi-colis*"));
  assert.ok(tracking.matches.includes("https://www.chronopost.fr/tracking-no-cms/suivi-page*"));

  const laposteClaim = manifest.content_scripts.find((entry) => entry.js.includes("src/laposte.js"));
  assert.ok(laposteClaim.matches.includes("https://contact.aide.laposte.fr/*"));
  assert.ok(laposteClaim.js.includes("src/shared/carrier-rules.js"));
  assert.ok(laposteClaim.js.includes("src/shared/claim-outcome.js"));
  assert.equal(laposteClaim.matches.some((url) => url.includes("/outils/suivre-vos-envois")), false);

  const chronopostClaim = manifest.content_scripts.find((entry) => entry.js.includes("src/chronopost.js"));
  assert.ok(chronopostClaim.matches.includes("https://www.chronopost.fr/service-client-en-ligne/*"));
  assert.ok(chronopostClaim.js.includes("src/shared/claim-outcome.js"));
  assert.ok(chronopostClaim.js.includes("src/shared/chronopost-rules.js"));
});

test("all manifest script and stylesheet paths exist", () => {
  const paths = new Set([manifest.background.service_worker]);
  for (const entry of manifest.content_scripts) {
    for (const file of [...(entry.js || []), ...(entry.css || [])]) paths.add(file);
  }
  for (const file of paths) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `Missing manifest file: ${file}`);
  }
});

test("ships portable extension icons and no personal sender defaults", () => {
  assert.deepEqual(manifest.icons, {
    16: "icons/icon16.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png"
  });
  for (const icon of Object.values(manifest.icons)) {
    assert.equal(fs.existsSync(path.join(root, icon)), true, `Missing manifest icon: ${icon}`);
  }
  assert.match(backgroundScript, /email:\s*""/);
  assert.match(backgroundScript, /phone:\s*""/);
  assert.match(backgroundScript, /contactFirstName:\s*""/);
  assert.match(backgroundScript, /contactLastName:\s*""/);
  assert.match(backgroundScript, /address1:\s*""/);
  for (const field of ["email", "phone", "contactFirstName", "contactLastName", "companyName", "address1", "postalCode", "city"]) {
    const input = optionsHtml.match(new RegExp(`<input[^>]+name="${field}"[^>]*>`))?.[0] || "";
    assert.doesNotMatch(input, /\svalue="[^"]+"/);
  }
});

test("fixes browser pairing to the production monitor origin", () => {
  const options = fs.readFileSync(path.join(root, "src/options.html"), "utf8");
  assert.match(options, /name="monitorServerUrl"[^>]+value="https:\/\/tracking\.cheaply\.fr"[^>]+readonly/);
});

test("includes privacy-safe Chrome Web Store graphics at the required dimensions", () => {
  const pngDimensions = (file) => {
    const data = fs.readFileSync(path.join(root, file));
    assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  };
  assert.deepEqual(pngDimensions("store-assets/small-promo-tile-440x280.png"), [440, 280]);
  assert.deepEqual(pngDimensions("store-assets/screenshot-order-preview-1280x800.png"), [1280, 800]);
  const assetSources = [
    fs.readFileSync(path.join(root, "store-assets", "promo.html"), "utf8"),
    fs.readFileSync(path.join(root, "store-assets", "preview.html"), "utf8"),
    fs.readFileSync(path.join(root, "scripts", "generate-store-assets.mjs"), "utf8")
  ].join("\n");
  assert.match(assetSources, /SYNTHETIC PREVIEW DATA/i);
  assert.doesNotMatch(assetSources, /sellercentral\.amazon\.fr\/orders-v3\/order\//i);
});

test("centers the Amazon launch button away from extension-reserved corners", () => {
  const launchRule = assistantCss.match(/#lpca-amazon-launch\.lpca-floating-button\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(launchRule, /left:\s*50%\s*!important/);
  assert.match(launchRule, /right:\s*auto\s*!important/);
  assert.match(launchRule, /transform:\s*translateX\(-50%\)\s*!important/);
});

test("renders recipient name and postal address beside the title selector", () => {
  assert.match(amazonScript, /id="lpca-destination-preview"/);
  assert.match(amazonScript, /parser\.destinationLines\(order, detectedRecipientCountry\)/);
  assert.match(amazonScript, /aria-describedby="lpca-destination-preview"/);
});

test("persists successful claims to Seller Notes and a sent button state", () => {
  assert.match(amazonScript, /Claim sent ·/);
  assert.match(amazonScript, /claimOutcomesByOrder/);
  assert.match(amazonScript, /sellerNotesControl/);
  assert.match(amazonScript, /Record existing claim/);
  assert.match(assistantCss, /data-state="sent"/);
});

test("makes both carrier confirmation panels collapsible", () => {
  assert.match(laposteScript, /id="lpca-collapse"/);
  assert.match(chronopostScript, /id="lpca-collapse"/);
  assert.match(assistantCss, /\.lpca-panel--collapsed/);
});

test("hides the La Poste pause control after successful submission", () => {
  assert.match(laposteScript, /pauseButton\.hidden = true/);
  assert.doesNotMatch(laposteScript, />Ⅱ<\/button>/);
  assert.match(laposteScript, /aria-label="Pause automation"/);
  assert.match(laposteScript, /finishSuccessfulSubmission\(\)\) return;\s*if \(state\.paused\) return;/);
});

test("uses the contracted Chronopost shipment lookup without filling both lookup keys", () => {
  assert.match(chronopostScript, /querySelector\("#package-number"\)/);
  assert.match(chronopostScript, /control\.id === "sender" \|\| control\.id === "package-number"/);
  assert.match(chronopostScript, /querySelector\("#object"\)/);
  assert.match(chronopostScript, /querySelector\("#motive"\)/);
  assert.match(chronopostScript, /querySelector\("#product-family"\)/);
  assert.match(chronopostScript, /querySelector\("#has-replied-2"\)/);
  assert.doesNotMatch(chronopostScript, /\[\["reference expediteur"/);
});

test("wires the bounded Manage Orders audit dashboard", () => {
  const ordersListScript = fs.readFileSync(path.join(root, "src", "orders-list.js"), "utf8");
  const auditorScript = fs.readFileSync(path.join(root, "src", "order-auditor.js"), "utf8");
  assert.match(ordersListScript, /MAX_CONCURRENCY = 1/);
  assert.match(ordersListScript, /START_ORDER_AUDIT/);
  assert.match(ordersListScript, /RELEASE_ORDER_AUDIT_WORKER/);
  assert.match(ordersListScript, /Last checked:/);
  assert.match(auditorScript, /ORDER_AUDIT_DETAILS/);
  assert.match(assistantCss, /\.lpca-order-badge/);
  assert.match(assistantCss, /\.lpca-order-status-time/);
});

test("reuses terminal delivered audits until an explicit recheck", () => {
  const ordersListScript = fs.readFileSync(path.join(root, "src", "orders-list.js"), "utf8");
  assert.match(amazonScript, /storedDeliveredAuditForOrder/);
  assert.match(amazonScript, /removeSavedAuditForOrder/);
  assert.match(ordersListScript, /auditIsTerminalDelivered/);
});

test("invalidates cached audits when tracking format corrects the carrier", () => {
  const carrierRulesScript = fs.readFileSync(path.join(root, "src", "shared", "carrier-rules.js"), "utf8");
  const ordersListScript = fs.readFileSync(path.join(root, "src", "orders-list.js"), "utf8");
  assert.match(carrierRulesScript, /carrierFromTrackingNumber/);
  assert.match(carrierRulesScript, /\^X\[A-Z\]/);
  assert.match(ordersListScript, /detectedCarrierId !== auditedCarrierId/);
});
