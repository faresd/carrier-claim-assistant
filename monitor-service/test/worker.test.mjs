import test from "node:test";
import assert from "node:assert/strict";
import { classifyTrackingState, normalizeCarrierPayload, shouldRunMorningMonitor } from "../src/worker.mjs";

test("classifies a returned parcel waiting for sender pickup as urgent", () => {
  assert.equal(classifyTrackingState(
    "Votre envoi retourné est disponible au bureau de poste.",
    "Retour à l'expéditeur. Le colis est à retirer au point de retrait."
  ), "pickup_ready");
});

test("keeps return-in-transit and lost parcels in separate queues", () => {
  assert.equal(classifyTrackingState("Votre colis est en retour à l'expéditeur."), "returning");
  assert.equal(classifyTrackingState("Votre colis ne peut plus être localisé."), "lost");
});

test("normalizes a Suivi v2 event history", () => {
  const result = normalizeCarrierPayload({ shipment: { event: [
    { date: "2026-08-30T08:00:00Z", label: "Votre colis est en retour à l'expéditeur", code: "RETOUR" },
    { date: "2026-09-01T06:30:00Z", label: "Votre envoi retourné est disponible au bureau de poste", code: "DISPO" }
  ] } });
  assert.equal(result.trackingState, "pickup_ready");
  assert.match(result.statusText, /disponible/i);
  assert.match(result.statusSummary, /retour/i);
});

test("runs only during the seven o'clock Paris hour", () => {
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T05:15:00Z")), true);
  assert.equal(shouldRunMorningMonitor(new Date("2026-09-01T06:15:00Z")), false);
  assert.equal(shouldRunMorningMonitor(new Date("2026-12-01T06:15:00Z")), true);
});
