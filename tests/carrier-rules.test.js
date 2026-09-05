"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  carrierFromTrackingNumber,
  detectCarrier,
  recommendClaim,
  classifyTrackingState,
  repairAudit,
  isTerminalDeliveredRecommendation,
  buildClaimMessage,
  carrierReasonContract,
  detectRecipientTitle,
  laPosteCountryLabel,
  firstLaPosteSubjectAnswerIndex
} = require("../src/shared/carrier-rules.js");

test("classifies sender-return completion separately from buyer delivery using current evidence", () => {
  const cases = [
    ["Votre Colissimo a été livré à son expéditeur.", "", "", "returned_delivered"],
    ["Votre colis est livré.", "Retour à l’expéditeur", "Votre Colissimo a été livré à son expéditeur.", "returned_delivered"],
    ["Retour à l’expéditeur", "Votre Colissimo a été livré à son expéditeur. Votre colis est livré.", "", "returned_delivered"],
    ["Votre colis est livré.", "Retour à l’expéditeur", "", "delivered"],
    ["Votre colis est livré.", "Votre Colissimo a été livré à son expéditeur.", "", "delivered"],
    ["Votre colis ne peut plus être localisé.", "Votre Colissimo a été livré à son expéditeur.", "", "lost"],
    ["Votre colis n’a pas été livré à son expéditeur.", "", "", "unknown"],
    ["Votre colis sera livré à son expéditeur.", "", "", "unknown"]
  ];
  for (const [current, history, currentSummary, expected] of cases) {
    assert.equal(classifyTrackingState(current, history, currentSummary), expected, current);
  }
});

test("recognizes completed mailbox distribution without mistaking future or failed distribution", () => {
  assert.equal(classifyTrackingState("Votre envoi a été distribué dans votre boîte aux lettres."), "delivered");
  assert.equal(classifyTrackingState("Votre envoi a bien été distribué dans votre boîte aux lettres."), "delivered");
  assert.notEqual(classifyTrackingState("Votre envoi sera distribué dans votre boîte aux lettres."), "delivered");
  assert.notEqual(classifyTrackingState("Votre envoi n’a pas été distribué dans votre boîte aux lettres."), "delivered");
  assert.notEqual(classifyTrackingState("Votre envoi est non distribué."), "delivered");
});

test("only sender collection creates an urgent returned-parcel pickup state", () => {
  const cases = [
    ["Votre colis est mis à disposition de son expéditeur.", "", "pickup_ready"],
    ["Votre colis est en attente de retrait par l’expéditeur.", "", "pickup_ready"],
    ["Votre colis est disponible pour l’expéditeur.", "", "pickup_ready"],
    ["Votre colis est disponible au bureau de poste.", "Retour à l’expéditeur", "pickup_ready"],
    ["Votre colis est disponible au point relais pour le destinataire.", "Retour à l’expéditeur", "unknown"],
    ["Votre colis est disponible au point relais.", "À défaut de retrait, il sera retourné à l’expéditeur.", "unknown"],
    ["Votre envoi retourné est disponible au bureau de poste.", "", "pickup_ready"],
    ["Votre colis est en retour à son expéditeur.", "", "returning"]
  ];
  for (const [current, history, expected] of cases) assert.equal(classifyTrackingState(current, history), expected, current);
  for (const current of ["Votre colis sera disponible pour l’expéditeur.", "Votre colis n’est pas disponible pour l’expéditeur.", "Votre colis sera disponible au bureau de poste."]) {
    assert.notEqual(classifyTrackingState(current, "Retour à l’expéditeur"), "pickup_ready", current);
  }
});

test("server and extension prioritize an explicit current sender pickup card over generic delivery", async () => {
  const { classifyTrackingState: serverClassify } = await import("../monitor-service/src/worker.mjs");
  const history = "Retour à l’expéditeur. Disponible pour l’expéditeur.";
  const pickupCard = "Disponible pour l’expéditeur.";
  const cases = [
    ["Votre colis est livré.", history, pickupCard, "pickup_ready"],
    ["Votre colis est livré.", history, "", "delivered"],
    ["Votre colis ne peut plus être localisé.", history, pickupCard, "lost"],
    ["Votre colis est endommagé.", history, pickupCard, "damaged"],
    ["Votre colis est disponible au point relais pour le destinataire.", history, pickupCard, "unknown"],
    ["Votre colis est livré au destinataire.", history, pickupCard, "delivered"],
    ["Votre colis est livré.", history, "Sera disponible pour l’expéditeur.", "delivered"]
  ];
  for (const classify of [classifyTrackingState, serverClassify]) {
    for (const [current, summary, card, expected] of cases) {
      assert.equal(classify(current, summary, card), expected, `${current} / ${card}`);
    }
  }
});

test("repairing a poisoned delivered audit keeps claim reason and genuine delivered caches intact", () => {
  const old = {
    order: { carrier: "Colissimo", trackingNumber: "CC113610754FR" },
    result: { statusText: "Votre Colissimo a été livré à son expéditeur." },
    recommendation: { recommended: false, reason: "delivered_missing", title: "Marked delivered" }
  };
  const repaired = repairAudit(old);
  assert.equal(repaired.recommendation.trackingState, "returned_delivered");
  assert.equal(repaired.recommendation.reason, "returned");
  assert.equal(repaired.recommendation.title, "Returned · confirm receipt");
  assert.equal(repaired.recommendation.recommended, false);
  const ordinary = { ...old, result: { statusText: "Votre colis est livré.", summaryText: "Retour à l’expéditeur" } };
  assert.equal(repairAudit(ordinary), ordinary);
});

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
