(function initClaimOutcomeRules(root) {
  "use strict";

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function extractClaimReference(text) {
    const source = String(text || "").replace(/\s+/g, " ");
    const patterns = [
      /(?:référence|reference)(?:\s+de\s+(?:votre\s+)?(?:demande|réclamation|reclamation|dossier|ticket))?\s*(?:(?:n[°ºo])|(?:est(?:\s+le)?)|[:#-])\s*([A-Z0-9][A-Z0-9./_-]{4,35})/i,
      /(?:numéro|numero|n[°ºo])\s+(?:de\s+)?(?:dossier|demande|réclamation|reclamation|ticket)\s*(?:(?:est(?:\s+le)?)|[:#-])?\s*([A-Z0-9][A-Z0-9./_-]{4,35})/i,
      /(?:dossier|ticket)\s*(?:n[°ºo]|numéro|numero|[:#-])\s*(?:est\s+)?([A-Z0-9][A-Z0-9./_-]{4,35})/i
    ];
    return patterns.map((pattern) => source.match(pattern)?.[1] || "").find(Boolean) || "";
  }

  function detectClaimSuccess(carrier, text) {
    const source = String(text || "").slice(0, 30000);
    const normalized = normalize(source);
    const genericSuccess = /(?:votre |la )?(?:demande|reclamation|dossier) (?:a bien ete|a ete|est) (?:prise en compte|enregistree|transmise|creee)|(?:^|\b)message envoye(?:\b|!)|votre message (?:a bien ete|a ete|est) transmis|nous avons bien recu votre (?:demande|reclamation)|bonne reception de votre (?:demande|reclamation)|merci[^.]{0,100}(?:demande|reclamation)[^.]{0,100}(?:prise en compte|enregistree|transmise)/;
    const carrierSuccess = carrier === "chronopost"
      ? /(?:votre )?ticket (?:a bien ete|a ete|est) (?:cree|enregistre|transmis)/
      : /(?:votre )?reclamation (?:a bien ete|a ete|est) (?:prise en compte|enregistree|transmise)/;
    if (!genericSuccess.test(normalized) && !carrierSuccess.test(normalized)) return null;

    const confirmationText = source
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => {
        const normalizedLine = normalize(line);
        return genericSuccess.test(normalizedLine) || carrierSuccess.test(normalizedLine);
      }) || "Claim submission confirmed by the carrier.";

    return {
      reference: extractClaimReference(source),
      confirmationText: confirmationText.slice(0, 500)
    };
  }

  function carrierLabel(carrier) {
    return carrier === "chronopost" ? "Chronopost" : "La Poste/Colissimo";
  }

  function buildSellerNote(outcome) {
    const date = new Date(outcome?.submittedAt || Date.now());
    const timestamp = Number.isNaN(date.getTime())
      ? "date inconnue"
      : date.toLocaleString("fr-FR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
    return [
      `[Carrier Claim Assistant] Réclamation envoyée à ${carrierLabel(outcome?.carrier)} le ${timestamp}.`,
      outcome?.trackingNumber ? `Suivi : ${outcome.trackingNumber}.` : "",
      outcome?.reason ? `Motif : ${String(outcome.reason).replaceAll("_", " ")}.` : "",
      outcome?.reference ? `Référence : ${outcome.reference}.` : ""
    ].filter(Boolean).join(" ");
  }

  function appendSellerNote(existing, note, maximumLength = 4000) {
    const current = String(existing || "").trim();
    const addition = String(note || "").trim();
    if (!addition || current.includes(addition)) return current;
    const separator = current ? "\n" : "";
    const limit = Number(maximumLength) > 0 ? Number(maximumLength) : 4000;
    const available = Math.max(0, limit - current.length - separator.length);
    return `${current}${separator}${addition.slice(0, available)}`;
  }

  const api = {
    normalize,
    extractClaimReference,
    detectClaimSuccess,
    buildSellerNote,
    appendSellerNote
  };
  root.CarrierClaimOutcomeRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
