(function initOrderListRules(root) {
  "use strict";
  const rules = root.CarrierClaimRules || (typeof require === "function" ? require("./carrier-rules.js") : null);

  function orderIdFromHref(href) {
    return String(href || "").match(/\/orders-v3\/order\/([0-9]{3}-[0-9]{7}-[0-9]{7})(?:[/?#]|$)/i)?.[1] || "";
  }

  function auditIsTerminalDelivered(audit) {
    if (rules.repairAudit(audit) !== audit) return false;
    const recommendation = audit?.recommendation;
    return recommendation?.recommended === false &&
      recommendation?.reason === "delivered_missing" &&
      recommendation?.title === "Marked delivered";
  }

  function auditIsFresh(audit, maximumAgeHours = 12, now = Date.now()) {
    if (rules.repairAudit(audit) !== audit) return false;
    if (auditIsTerminalDelivered(audit)) return true;
    const checkedAt = new Date(audit?.checkedAt || 0).getTime();
    return Number.isFinite(checkedAt) && checkedAt > 0 && now - checkedAt < Number(maximumAgeHours || 12) * 3600000;
  }

  function formatStatusTimestamp(value, locale = "fr-FR") {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "";
    return new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function badgeFor({ outcome, recommendation, error, eligibility = "shipped" } = {}) {
    if (outcome) {
      return {
        state: "sent",
        label: outcome.reference ? `Claim sent · ${outcome.reference}` : "Claim sent",
        actionable: true
      };
    }
    if (eligibility !== "shipped") {
      const labels = {
        unshipped: "Not eligible · Unshipped",
        canceled: "Not eligible · Cancelled",
        pending: "Not eligible · Pending"
      };
      return { state: "ineligible", label: labels[eligibility] || "Not eligible", actionable: false };
    }
    if (error) return { state: "review", label: "Needs review", actionable: true };
    if (!recommendation) return { state: "queued", label: "Queued for check", actionable: false };
    if (recommendation.trackingState === "returned_delivered") return { state: "returned", label: "Returned · confirm receipt", actionable: true };
    if (recommendation.trackingState === "pickup_ready") return { state: "pickup", label: "Pickup required", actionable: true };
    if (recommendation.recommended) return { state: "recommended", label: "Claim recommended", actionable: true };
    if (recommendation.title === "Marked delivered") return { state: "clear", label: "No claim · Delivered", actionable: true };
    if (recommendation.title === "Carrier not supported") return { state: "unsupported", label: "Unsupported carrier", actionable: true };
    return { state: "clear", label: "No claim needed", actionable: true };
  }

  const api = { orderIdFromHref, auditIsTerminalDelivered, auditIsFresh, formatStatusTimestamp, badgeFor };
  root.CarrierOrderListRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
