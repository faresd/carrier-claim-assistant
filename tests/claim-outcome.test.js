"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractClaimReference,
  detectClaimSuccess,
  buildSellerNote,
  appendSellerNote
} = require("../src/shared/claim-outcome.js");

test("detects a successful La Poste confirmation and its reference", () => {
  const result = detectClaimSuccess("laposte", `
    Votre réclamation a bien été prise en compte.
    Référence de votre demande : LP-8472619
  `);
  assert.equal(result.reference, "LP-8472619");
  assert.match(result.confirmationText, /prise en compte/i);
});

test("detects La Poste's live Message envoyé confirmation without inventing an emailed reference", () => {
  const result = detectClaimSuccess("laposte", `
    Message envoyé !
    Merci de votre confiance. Votre message a été transmis à nos équipes.
    Le numéro de référence associé à votre demande vous a été transmis par e-mail.
  `);
  assert.equal(result.reference, "");
  assert.match(result.confirmationText, /Message envoyé/i);
});

test("detects a successful Chronopost ticket without inventing a reference", () => {
  const result = detectClaimSuccess("chronopost", "Votre ticket a été créé et transmis à notre service client.");
  assert.equal(result.reference, "");
  assert.match(result.confirmationText, /ticket/i);
});

test("does not treat pre-submission future wording as success", () => {
  assert.equal(detectClaimSuccess("laposte", "Votre demande sera enregistrée après avoir sélectionné Envoyer."), null);
});

test("builds and appends a deduplicated Seller Notes entry", () => {
  const note = buildSellerNote({
    carrier: "laposte",
    submittedAt: "2026-08-24T14:30:00.000Z",
    trackingNumber: "CC000000002FR",
    reason: "lost",
    reference: "LP-8472619"
  });
  assert.match(note, /La Poste\/Colissimo/);
  assert.match(note, /CC000000002FR/);
  assert.match(note, /LP-8472619/);
  assert.equal(appendSellerNote("Existing seller note", note), `Existing seller note\n${note}`);
  assert.equal(appendSellerNote(`Existing seller note\n${note}`, note), `Existing seller note\n${note}`);
});

test("extracts common carrier reference labels", () => {
  assert.equal(extractClaimReference("Numéro de dossier : CHR/918273"), "CHR/918273");
  assert.equal(extractClaimReference("Votre référence est LP-123456"), "LP-123456");
  assert.equal(extractClaimReference("Le numéro de référence associé à votre demande vous a été transmis par e-mail."), "");
  assert.equal(extractClaimReference("No carrier reference is shown."), "");
});
