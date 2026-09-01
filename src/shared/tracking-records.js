(function initCarrierTrackingRecords(root) {
  "use strict";

  const TERMINAL_STATES = new Set(["delivered", "resolved"]);

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function trackingState(result = {}, recommendation = {}) {
    const current = normalize(result.statusText || recommendation.statusText);
    const all = normalize(`${result.statusText || ""} ${result.summaryText || ""} ${recommendation.statusText || ""}`);
    const returnContext = /retour(?:ne|nee|ne)?(?:\s+|.*\s)a l'expediteur|retour expediteur|renvoye a l'expediteur|returned to sender|return to sender|retour de votre envoi/.test(all);
    const senderPickup = /mis(?:e)? a disposition de l'expediteur|disponible pour l'expediteur|expediteur.*(?:retirer|retrait|disponible)|retour.*(?:a retirer|disponible|point de retrait|bureau de poste|agence)/.test(current);
    const pickup = /(?:disponible|vous attend|a retirer|en attente de retrait|mis(?:e)? a disposition).*(?:point de retrait|bureau de poste|agence|relais|site de retrait)|(?:point de retrait|bureau de poste|agence|relais).*(?:disponible|vous attend|a retirer|retrait)/.test(current);
    const lost = /perdu|introuvable|egare|lost|missing|recherche infructueuse|ne peut (?:plus )?etre localise/.test(all);
    const damaged = /endommage|deteriore|avarie|damaged|damage/.test(all);
    const delivered = /(?:^|\b)(?:a (?:bien )?ete|est) livre\b|livraison (?:a ete )?effectuee|remis au destinataire|^livre\b|\bdelivered\b/.test(current) &&
      !/non livre|pas livre|jamais livre|impossible de livrer|n'a pas pu.*remis|n'avons pu.*remettre|echec de livraison|tentative de livraison/.test(current);

    if (senderPickup || (returnContext && pickup)) return "pickup_ready";
    if (returnContext) return "returning";
    if (lost) return "lost";
    if (damaged) return "damaged";
    if (delivered) return "delivered";
    if (/acheminement|en transit|in transit|pris en charge|en cours de livraison|distribution|douane|customs/.test(all)) return "in_transit";
    return "unknown";
  }

  function isTerminal(record) {
    return TERMINAL_STATES.has(record?.trackingState);
  }

  function monitorEligible(record, maxAgeDays = 120, now = Date.now()) {
    if (!record?.orderId || !record?.trackingNumber || isTerminal(record)) return false;
    const createdAt = new Date(record.firstSeenAt || record.createdAt || record.updatedAt || now).getTime();
    if (!Number.isFinite(createdAt)) return true;
    return now - createdAt <= Number(maxAgeDays || 120) * 86400000;
  }

  function cleanOrder(order = {}) {
    const allowed = [
      "sourceUrl", "orderId", "trackingNumber", "shipDate", "deliverBy", "carrier", "shippingService",
      "itemValue", "quantity", "recipientName", "recipientAddress1", "recipientAddress2", "recipientCity",
      "recipientPostalCode", "recipientCountry", "productName", "asin", "sku"
      , "sellerAccountId", "sellerAccountName", "marketplaceId"
    ];
    return Object.fromEntries(allowed.map((key) => [key, String(order[key] || "").slice(0, 500)]));
  }

  function buildRecord({ order = {}, result = {}, recommendation = {}, outcome = null, previous = null, now = new Date().toISOString() } = {}) {
    const safeOrder = cleanOrder(order);
    const hasFreshStatus = Boolean(result.statusText || result.summaryText || recommendation.statusText);
    const detectedState = trackingState(result, recommendation);
    const state = previous?.trackingState === "resolved"
      ? "resolved"
      : hasFreshStatus
        ? detectedState
        : previous?.trackingState || detectedState;
    const sellerAccountId = safeOrder.sellerAccountId || previous?.sellerAccountId || "sellercentral.amazon.fr";
    const marketplaceId = safeOrder.marketplaceId || previous?.marketplaceId || "A13V1IB3VIYZZH";
    const orderId = safeOrder.orderId || previous?.orderId || "";
    return {
      ...(previous || {}),
      ...safeOrder,
      recordId: `${sellerAccountId}|${marketplaceId}|${orderId}`,
      orderId,
      trackingNumber: safeOrder.trackingNumber || previous?.trackingNumber || "",
      sellerAccountId,
      sellerAccountName: safeOrder.sellerAccountName || previous?.sellerAccountName || "Seller Central account",
      marketplaceId,
      carrierId: recommendation?.carrier?.id || previous?.carrierId || "",
      carrierLabel: recommendation?.carrier?.label || previous?.carrierLabel || safeOrder.carrier || "",
      statusText: String(result.statusText || recommendation.statusText || previous?.statusText || "").replace(/\s+/g, " ").trim().slice(0, 1000),
      statusSummary: String(result.summaryText || previous?.statusSummary || "").replace(/\s+/g, " ").trim().slice(0, 5000),
      trackingState: state,
      claimRecommended: Boolean(recommendation?.recommended),
      claimReason: recommendation?.reason || previous?.claimReason || "none",
      claimTitle: recommendation?.title || previous?.claimTitle || "",
      claimStatus: outcome ? "sent" : previous?.claimStatus || "none",
      claimReference: outcome?.reference || previous?.claimReference || "",
      claimSubmittedAt: outcome?.submittedAt || previous?.claimSubmittedAt || "",
      checkedAt: result.checkedAt || previous?.checkedAt || "",
      firstSeenAt: previous?.firstSeenAt || now,
      updatedAt: now,
      resolvedAt: previous?.resolvedAt || "",
      resolutionNote: previous?.resolutionNote || "",
      pickupNotifiedAt: previous?.pickupNotifiedAt || ""
    };
  }

  function badgeForRecord(record) {
    const states = {
      pickup_ready: { state: "pickup", label: "Pickup required", actionable: true },
      returning: { state: "returned", label: "Returning to sender", actionable: true },
      lost: { state: "recommended", label: "Lost · investigate", actionable: true },
      delivered: { state: "delivered", label: "Delivered", actionable: false },
      resolved: { state: "resolved", label: "Returned · received", actionable: true }
    };
    return states[record?.trackingState] || null;
  }

  const api = { normalize, trackingState, isTerminal, monitorEligible, cleanOrder, buildRecord, badgeForRecord };
  root.CarrierTrackingRecords = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
