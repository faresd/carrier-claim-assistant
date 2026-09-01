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
    const returnPattern = /retour(?:ne|nee|ne)?(?:\s+|.*\s)a l'expediteur|retour expediteur|renvoye a l'expediteur|returned to sender|return to sender|retour de votre envoi/;
    const futureReturnPattern = /(?:sera|serait|pourra|pourrait|va|doit|devra) (?:etre )?(?:retourne|renvoye) a l'expediteur|(?:sans|faute de|a defaut de|en l'absence de) (?:votre )?retrait.*(?:retour|expediteur)|passe ce delai.*(?:retour|expediteur)/;
    const returnContext = (returnPattern.test(current) && !futureReturnPattern.test(current)) ||
      (returnPattern.test(all) && !futureReturnPattern.test(all));
    const senderPickup = /mis(?:e)? a disposition de l'expediteur|disponible pour l'expediteur|expediteur.*(?:retirer|retrait|disponible)|retour.*(?:a retirer|disponible|point de retrait|bureau de poste|agence)/.test(current);
    const pickup = /(?:disponible|vous attend|a retirer|en attente de retrait|mis(?:e)? a disposition).*(?:point de retrait|bureau de poste|agence|relais|site de retrait)|(?:point de retrait|bureau de poste|agence|relais).*(?:disponible|vous attend|a retirer|retrait)/.test(current);
    const lostPattern = /perdu|introuvable|egare|lost|missing|recherche infructueuse|ne peut (?:plus )?etre localise/;
    const damagedPattern = /endommage|deteriore|avarie|damaged|damage/;
    const lost = lostPattern.test(all);
    const damaged = damagedPattern.test(all);
    const delivered = /(?:^|\b)(?:a (?:bien )?ete|est) livre\b|livraison (?:a ete )?effectuee|remis au destinataire|^livre\b|\bdelivered\b/.test(current) &&
      !/non livre|pas livre|jamais livre|impossible de livrer|n'a pas pu.*remis|n'avons pu.*remettre|echec de livraison|tentative de livraison/.test(current);

    if (senderPickup || (returnContext && pickup)) return "pickup_ready";
    if (delivered) return "delivered";
    if (lostPattern.test(current)) return "lost";
    if (damagedPattern.test(current)) return "damaged";
    if (returnContext) return "returning";
    if (lost) return "lost";
    if (damaged) return "damaged";
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
      "sourceUrl", "orderId", "trackingNumber", "orderDate", "shipDate", "deliverBy", "carrier", "shippingService",
      "itemValue", "quantity", "recipientName", "recipientAddress1", "recipientAddress2", "recipientCity",
      "recipientPostalCode", "recipientCountry", "productName", "asin", "sku"
      , "sellerAccountId", "sellerAccountName", "marketplaceId"
    ];
    return Object.fromEntries(allowed.map((key) => [key, String(order[key] || "").slice(0, 500)]));
  }

  function identity(record = {}) {
    const nested = record.order && typeof record.order === "object" ? record.order : {};
    const orderId = String(record.orderId || nested.orderId || "").slice(0, 40);
    const sellerAccountId = String(
      record.sellerAccountId || record.accountId || nested.sellerAccountId || nested.accountId || "sellercentral.amazon.fr"
    ).slice(0, 180);
    const marketplaceId = String(
      record.marketplaceId || nested.marketplaceId || "A13V1IB3VIYZZH"
    ).slice(0, 180);
    return { orderId, sellerAccountId, marketplaceId };
  }

  function recordKey(record = {}) {
    const parts = identity(record);
    return parts.orderId ? `${parts.sellerAccountId}|${parts.marketplaceId}|${parts.orderId}` : "";
  }

  function trackingNumber(record = {}) {
    return String(record.trackingNumber || record.order?.trackingNumber || "").toUpperCase();
  }

  function findRecordEntry(collection = {}, wanted = {}) {
    const wantedIdentity = identity(wanted);
    if (!wantedIdentity.orderId) return null;
    const exactKey = recordKey(wanted);
    if (collection[exactKey]) return { key: exactKey, value: collection[exactKey] };

    const legacy = collection[wantedIdentity.orderId];
    const wantedTracking = trackingNumber(wanted);
    if (legacy && (!wantedTracking || !trackingNumber(legacy) || trackingNumber(legacy) === wantedTracking)) {
      return { key: wantedIdentity.orderId, value: legacy };
    }

    let candidates = Object.entries(collection).filter(([, value]) => identity(value).orderId === wantedIdentity.orderId);
    if (wantedTracking) {
      const matchingTracking = candidates.filter(([, value]) => !trackingNumber(value) || trackingNumber(value) === wantedTracking);
      if (matchingTracking.length) candidates = matchingTracking;
    }
    const exactAccount = candidates.filter(([, value]) => {
      const current = identity(value);
      return current.sellerAccountId === wantedIdentity.sellerAccountId && current.marketplaceId === wantedIdentity.marketplaceId;
    });
    if (exactAccount.length === 1) return { key: exactAccount[0][0], value: exactAccount[0][1] };
    if (candidates.length !== 1) return null;
    const candidateIdentity = identity(candidates[0][1]);
    const fallbackAccounts = new Set(["default", "sellercentral.amazon.fr"]);
    return fallbackAccounts.has(wantedIdentity.sellerAccountId) || fallbackAccounts.has(candidateIdentity.sellerAccountId)
      ? { key: candidates[0][0], value: candidates[0][1] }
      : null;
  }

  function findRecord(collection = {}, wanted = {}) {
    return findRecordEntry(collection, wanted)?.value || null;
  }

  function rekeyRecords(collection = {}) {
    const next = {};
    for (const [legacyKey, value] of Object.entries(collection || {})) {
      if (!value || typeof value !== "object") continue;
      const key = recordKey(value) || legacyKey;
      const existing = next[key];
      const existingTime = new Date(existing?.updatedAt || existing?.submittedAt || existing?.checkedAt || 0).getTime();
      const valueTime = new Date(value.updatedAt || value.submittedAt || value.checkedAt || 0).getTime();
      if (!existing || !Number.isFinite(existingTime) || valueTime >= existingTime) next[key] = value;
    }
    return next;
  }

  function claimOutcomeForRecord(record = {}) {
    if (record.claimStatus !== "sent" || !identity(record).orderId) return null;
    const parts = identity(record);
    return {
      id: `cloud:${record.recordId || recordKey(record)}:${record.claimSubmittedAt || record.claimReference || "sent"}`,
      recordId: record.recordId || recordKey(record),
      carrier: record.carrierId || (/chrono/i.test(record.carrierLabel || "") ? "chronopost" : "laposte"),
      orderId: parts.orderId,
      trackingNumber: trackingNumber(record),
      sellerAccountId: parts.sellerAccountId,
      sellerAccountName: record.sellerAccountName || record.accountName || parts.sellerAccountId,
      marketplaceId: parts.marketplaceId,
      reason: record.claimReason || "other",
      reference: record.claimReference || "",
      confirmationText: "Claim synchronized from the private return monitor.",
      submittedAt: record.claimSubmittedAt || "",
      noteSaved: false
    };
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
      trackingSource: result.source || previous?.trackingSource || "",
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

  const api = {
    normalize, trackingState, isTerminal, monitorEligible, cleanOrder, identity, recordKey,
    findRecordEntry, findRecord, rekeyRecords, claimOutcomeForRecord, buildRecord, badgeForRecord
  };
  root.CarrierTrackingRecords = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
