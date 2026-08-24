(function initChronopostRules(root) {
  "use strict";

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  const OBJECT_BY_REASON = Object.freeze({
    delivered_missing: "CL",
    delayed: "PC",
    lost: "PC",
    damaged: "LP",
    contents_missing: "LP",
    returned: "RE",
    other: "SD"
  });

  const MOTIVE_TERMS_BY_REASON = Object.freeze({
    delivered_missing: Object.freeze(["non recu", "contestation", "livre"]),
    delayed: Object.freeze(["retard", "delai", "position"]),
    lost: Object.freeze(["perdu", "perte", "introuvable", "non livre"]),
    damaged: Object.freeze(["endommage", "avarie", "deteriore"]),
    contents_missing: Object.freeze(["partiel", "manquant", "spolie"]),
    returned: Object.freeze(["retour"]),
    other: Object.freeze([])
  });

  function objectForReason(reason) {
    return OBJECT_BY_REASON[reason] || "PC";
  }

  function motiveTermsForReason(reason) {
    return MOTIVE_TERMS_BY_REASON[reason] || [];
  }

  function matchingOptionValue(options, terms) {
    const wanted = (Array.isArray(terms) ? terms : []).map(normalize).filter(Boolean);
    if (!wanted.length) return "";
    const option = [...(options || [])].find((item) => {
      const text = normalize(item?.textContent ?? item?.text ?? item?.label);
      return wanted.some((term) => text.includes(term));
    });
    return option?.value || "";
  }

  function productFamily(productName) {
    const product = normalize(productName);
    if (/telephone|smartphone|iphone|galaxy/.test(product)) return "F5";
    if (/ordinateur|pc|laptop|casque|headset|electron|camera|jabra|usb|bluetooth|dock/.test(product)) return "F2";
    if (/jouet|toy|lego|puzzle/.test(product)) return "F3";
    if (/textile|vetement|shirt|dress|chaussure/.test(product)) return "F4";
    if (/aliment|food|boisson/.test(product)) return "F6";
    if (/document|livre|book/.test(product)) return "F7";
    if (/medicament|medical|pharma/.test(product)) return "F8";
    if (/auto|voiture|car part/.test(product)) return "F9";
    if (/bagage|valise|sac/.test(product)) return "F10";
    return "F1";
  }

  const api = { normalize, objectForReason, motiveTermsForReason, matchingOptionValue, productFamily };
  root.CarrierChronopostRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
