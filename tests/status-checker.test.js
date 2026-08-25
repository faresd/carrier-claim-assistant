"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("reads a La Poste status and French date from an open shadow root", async () => {
  const trackingNumber = "CC000000001FR";
  const trackingDetail = {
    innerText: [
      `N° ${trackingNumber}`,
      "Irlande",
      "Mardi 18 août 2026 à 10:47",
      "Votre Colissimo a été livré.",
      "Votre colis est livré."
    ].join("\n"),
    textContent: ""
  };
  const trackingInput = { value: trackingNumber };
  const shadowRoot = {
    textContent: trackingDetail.innerText,
    querySelectorAll(selector) {
      if (selector.includes("tracking-detail")) return [trackingDetail];
      if (selector === "input") return [trackingInput];
      return [];
    }
  };
  const host = { shadowRoot };
  const body = { innerText: `Suivi ${trackingNumber}`, textContent: `Suivi ${trackingNumber}` };

  global.location = {
    hash: "#carrier-claim-check=request-1",
    pathname: "/outils/suivre-vos-envois",
    search: `?code=${trackingNumber}`
  };
  global.history = { replaceState() {} };
  global.sessionStorage = {
    setItem() {},
    removeItem() {},
    getItem() { return null; }
  };
  global.document = {
    body,
    querySelectorAll(selector) { return selector === "*" ? [host] : []; },
    querySelector() { return null; }
  };

  let sentMessage;
  global.chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type === "GET_CARRIER_STATUS_REQUEST") {
          return {
            ok: true,
            request: {
              requestId: "request-1",
              carrier: "laposte",
              order: { trackingNumber }
            }
          };
        }
        sentMessage = message;
        return { ok: true };
      }
    }
  };

  const checker = require("../src/status-checker.js");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sentMessage.type, "CARRIER_STATUS_SCRAPED");
  assert.equal(sentMessage.result.hasResult, true);
  assert.match(sentMessage.result.statusText, /livré/i);
  assert.equal(sentMessage.result.eventDate, "2026-08-18T08:47:00.000Z");

  const failedTrackingNumber = "CC000000002FR";
  const failedTrackingDetail = {
    innerText: [
      `N° ${failedTrackingNumber}`,
      "Votre Colissimo n'a pas pu vous être remis.",
      "Vendredi 31 juillet 2026",
      "Votre Colissimo sera livré à votre adresse. Il sera livré avec signature.",
      "Progression : 75%",
      "Il vous attendra bientôt dans votre point de retrait."
    ].join("\n"),
    textContent: ""
  };
  const failedTrackingInput = { value: failedTrackingNumber };
  const failedShadowRoot = {
    textContent: failedTrackingDetail.innerText,
    querySelectorAll(selector) {
      if (selector.includes("tracking-detail")) return [failedTrackingDetail];
      if (selector === "input") return [failedTrackingInput];
      return [];
    }
  };
  const failedHost = { shadowRoot: failedShadowRoot };
  global.document = {
    body: { innerText: `Suivi ${failedTrackingNumber}`, textContent: `Suivi ${failedTrackingNumber}` },
    querySelectorAll(selector) { return selector === "*" ? [failedHost] : []; },
    querySelector() { return null; }
  };

  const failedResult = checker.parseStatus("laposte", failedTrackingNumber);
  assert.equal(failedResult.hasResult, true);
  assert.equal(failedResult.statusText, "Votre Colissimo n'a pas pu vous être remis.");

  const chronopostTrackingNumber = "XN000000004JB";
  const chronopostText = [
    `Informations concernant votre envoi ${chronopostTrackingNumber}`,
    "Livraison effectuée",
    "jeudi 20/08/2026 à 12:50",
    "En préparation chez l'expéditeur",
    "Pris en charge par Chronopost",
    "En cours d'acheminement",
    "Envoi en cours de livraison",
    "Livré",
    "Voir la preuve de livraison"
  ].join("\n");
  global.document = {
    body: { innerText: chronopostText, textContent: chronopostText },
    querySelectorAll(selector) {
      if (selector === "*") return [];
      if (selector === "main") return [{ innerText: chronopostText, textContent: chronopostText }];
      if (selector === "input") return [{ value: chronopostTrackingNumber }];
      return [];
    },
    querySelector() { return null; }
  };
  const chronopostResult = checker.parseStatus("chronopost", chronopostTrackingNumber);
  assert.equal(chronopostResult.hasResult, true);
  assert.equal(chronopostResult.statusText, "Livraison effectuée");
  assert.equal(chronopostResult.eventDate, "2026-08-20T10:50:00.000Z");
  assert.equal(checker.extractEventDate("20/01/2026 à 12:50"), "2026-01-20T11:50:00.000Z");
});
