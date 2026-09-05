(function initCarrierTrackingRecords(root) {
  "use strict";

  const TERMINAL_STATES = new Set(["delivered", "resolved"]);
  const rules = root.CarrierClaimRules || (typeof require === "function" ? require("./carrier-rules.js") : null);

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function trackingState(result = {}, recommendation = {}) {
    return rules.resultTrackingState(result, recommendation);
  }

  function repairRecord(record) {
    if (!record || !["delivered", "unknown"].includes(record.trackingState)) return record;
    const detected = trackingState(record);
    if (!["returned_delivered", "returning", "pickup_ready"].includes(detected)) return record;
    return { ...record, trackingState: detected };
  }

  function isTerminal(record) {
    return TERMINAL_STATES.has(repairRecord(record)?.trackingState);
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
      if (!existing || !Number.isFinite(existingTime) || valueTime >= existingTime) next[key] = repairRecord(value);
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
    previous = repairRecord(previous);
    const safeOrder = cleanOrder(order);
    const hasFreshStatus = Boolean(result.statusText || result.summaryText || result.currentSummaryText || recommendation.statusText);
    const detectedState = trackingState(result, recommendation);
    const state = previous?.trackingState === "resolved"
      ? "resolved"
      : previous?.trackingState === "returned_delivered" && ["delivered", "unknown"].includes(detectedState)
        ? "returned_delivered"
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
      statusCurrentSummary: String(result.currentSummaryText || (!hasFreshStatus ? previous?.statusCurrentSummary : "") || "").replace(/\s+/g, " ").trim().slice(0, 1000),
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
    record = repairRecord(record);
    const states = {
      pickup_ready: { state: "pickup", label: "Pickup required", actionable: true },
      returning: { state: "returned", label: "Returning to sender", actionable: true },
      returned_delivered: { state: "returned", label: "Returned · confirm receipt", actionable: true },
      lost: { state: "recommended", label: "Lost · investigate", actionable: true },
      delivered: { state: "delivered", label: "Delivered", actionable: false },
      resolved: { state: "resolved", label: "Returned · received", actionable: true }
    };
    return states[record?.trackingState] || null;
  }

  const api = {
    normalize, trackingState, repairRecord, isTerminal, monitorEligible, cleanOrder, identity, recordKey,
    findRecordEntry, findRecord, rekeyRecords, claimOutcomeForRecord, buildRecord, badgeForRecord
  };
  root.CarrierTrackingRecords = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
