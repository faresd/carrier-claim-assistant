"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  carrierFromTrackingNumber,
  detectCarrier,
  recommendClaim,
  isTerminalDeliveredRecommendation,
  buildClaimMessage,
  carrierReasonContract,
  detectRecipientTitle,
  laPosteCountryLabel,
  firstLaPosteSubjectAnswerIndex
} = require("../src/shared/carrier-rules.js");

test("maps Colissimo spelling variants to La Poste", () => {
  assert.equal(detectCarrier({ carrier: "COLISSIMOS", shippingService: "Colissimo international Europe" }).id, "laposte");
  assert.equal(detectCarrier({ carrier: "La Poste" }).id, "laposte");
});

test("detects Chronopost", () => {
  assert.equal(detectCarrier({ carrier: "Chronopost", shippingService: "Chrono 13" }).id, "chronopost");
});

test("uses an unambiguous tracking-number format to correct the carrier label", () => {
  assert.deepEqual(carrierFromTrackingNumber("XN000000003JB"), {
    id: "chronopost",
    label: "Chronopost",
    supported: true,
    source: "tracking_number"
  });
  const corrected = detectCarrier({ carrier: "Colissimo", trackingNumber: "XN000000003JB" });
  assert.equal(corrected.id, "chronopost");
  assert.equal(corrected.labelMismatch, true);

  assert.equal(detectCarrier({ carrier: "Chronopost", trackingNumber: "6A12345678901" }).id, "laposte");
  const laPoste8U = detectCarrier({ carrier: "Chronopost", trackingNumber: "8U02230078613" });
  assert.equal(laPoste8U.id, "laposte");
  assert.equal(laPoste8U.source, "tracking_number");
  assert.equal(laPoste8U.labelMismatch, true);
  assert.equal(carrierFromTrackingNumber("CC000000002FR"), null);
  assert.equal(detectCarrier({ carrier: "Colissimo", trackingNumber: "CC000000002FR" }).id, "laposte");
});

test("recommends a loss claim when the carrier cannot locate the parcel", () => {
  const order = {
    carrier: "COLISSIMOS",
    trackingNumber: "CC000000001FR",
    shipDate: "Mon, 10 Aug 2026",
    deliverBy: "Wed, 19 Aug 2026",
    recipientName: "Mary Example",
    recipientCountry: "Ireland",
    itemValue: "€162.98"
  };
  const recommendation = recommendClaim(order, { statusText: "Le colis est introuvable dans notre réseau." });
  assert.equal(recommendation.recommended, true);
  assert.equal(recommendation.reason, "lost");
  assert.match(buildClaimMessage(order, recommendation), /CC000000001FR/);
});

test("does not propose a claim for a delivered parcel", () => {
  const recommendation = recommendClaim(
    { carrier: "Chronopost", shipDate: "Mon, 24 Aug 2026" },
    { statusText: "Votre colis a été livré au destinataire." }
  );
  assert.equal(recommendation.recommended, false);
  assert.equal(recommendation.title, "Marked delivered");
  assert.equal(recommendation.reason, "delivered_missing");
  assert.equal(isTerminalDeliveredRecommendation(recommendation), true);
  assert.match(buildClaimMessage({
    trackingNumber: "CC000000001FR",
    recipientName: "Mary Example",
    recipientCountry: "Ireland"
  }, recommendation), /preuve de remise/);
});

test("does not classify a recommended non-delivery claim as terminal", () => {
  assert.equal(isTerminalDeliveredRecommendation({
    recommended: true,
    reason: "delivered_missing",
    title: "Marked delivered"
  }), false);
});

test("does not mistake future delivery wording for a completed delivery", () => {
  const recommendation = recommendClaim(
    {
      carrier: "Colissimo",
      shipDate: "Fri, 17 Jul 2026",
      deliverBy: "Sat, 25 Jul 2026"
    },
    {
      statusText: "Votre Colissimo sera livré à votre adresse. Il sera livré avec signature.",
      summaryText: "Votre Colissimo n'a pas pu vous être remis. Il vous attendra bientôt dans votre point de retrait."
    }
  );
  assert.equal(recommendation.recommended, true);
  assert.equal(recommendation.reason, "lost");
  assert.notEqual(recommendation.title, "Marked delivered");
});

test("maps editable La Poste reasons to the official complaint taxonomy", () => {
  assert.deepEqual(carrierReasonContract("laposte", "delivered_missing"), {
    motif: "MOT093",
    sousmotif: "SMO298",
    label: "Marked delivered but not received"
  });
  assert.equal(carrierReasonContract("chronopost", "lost"), null);
});

test("detects recipient civilité locally and normalizes carrier country labels", () => {
  assert.equal(detectRecipientTitle("Mary Example"), "Madame");
  assert.equal(detectRecipientTitle("Mr. John Smith"), "Monsieur");
  assert.equal(detectRecipientTitle("Arne Beispiel"), "Monsieur");
  assert.equal(detectRecipientTitle("Herr Klaus Weber"), "Monsieur");
  assert.equal(detectRecipientTitle("Frau Sabine Weber"), "Madame");
  assert.equal(detectRecipientTitle("Alex Morgan"), "");
  assert.equal(laPosteCountryLabel("Ireland"), "Irlande");
  assert.equal(laPosteCountryLabel("United Kingdom"), "Royaume-Uni");
});

test("chooses the first real answer for the La Poste subject question", () => {
  assert.equal(firstLaPosteSubjectAnswerIndex([
    "Mon courrier/colis est indiqué comme livré mais il n'est pas arrivé",
    "Je ne suis pas satisfait de la livraison",
    "Retour"
  ]), 0);
  assert.equal(firstLaPosteSubjectAnswerIndex([
    "Trigger Stonly Widget",
    "Mon courrier/colis est indiqué comme livré mais il n'est pas arrivé",
    "Retour"
  ]), 1);
});
