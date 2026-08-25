"use strict";

if (typeof importScripts === "function") importScripts("shared/carrier-rules.js", "shared/claim-outcome.js");

const carrierRules = globalThis.CarrierClaimRules;
const outcomeRules = globalThis.CarrierClaimOutcomeRules;
const CLAIM_OUTCOMES_KEY = "claimOutcomesByOrder";

const CLAIM_URLS = {
  laposte: "https://contact.aide.laposte.fr/kb/guide/fr/formulaire-courrier-colis-55CJ9A5dgN/Steps/4901506",
  chronopost: "https://www.chronopost.fr/service-client-en-ligne/home/iv4.html?lang=fr_FR"
};

const TRACKING_URLS = {
  laposte: "https://www.laposte.fr/outils/suivre-vos-envois",
  chronopost: "https://www.chronopost.fr/fr/suivi-colis"
};

const DEFAULT_SENDER_PROFILE = {
  email: "",
  phone: "",
  senderType: "part",
  contactTitle: "Monsieur",
  contactFirstName: "",
  contactLastName: "",
  companyName: "",
  address1: "",
  address2: "",
  postalCode: "",
  city: "",
  country: "France"
};

const DEFAULT_CLAIM_SETTINGS = {
  autoStatusCheck: true,
  chronopostStaleHours: 48,
  laposteOverdueDays: 7
};

const STATUS_TIMEOUT_MS = 60000;
const ORDER_AUDIT_LOAD_TIMEOUT_MS = 30000;

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(["senderProfile", "claimSettings"]);
  await chrome.storage.local.set({
    senderProfile: { ...DEFAULT_SENDER_PROFILE, ...(stored.senderProfile || {}) },
    claimSettings: { ...DEFAULT_CLAIM_SETTINGS, ...(stored.claimSettings || {}) }
  });
  if (details.reason === "install") await chrome.runtime.openOptionsPage();
});

async function startStatusCheck(message, sender) {
  const { carrier, order, auditId, auditWorkerTabId } = message;
  if (!TRACKING_URLS[carrier] || !order?.trackingNumber || !sender.tab?.id) {
    return { ok: false, error: "Missing supported carrier, tracking number, or Amazon tab." };
  }

  const requestId = crypto.randomUUID();
  const request = {
    requestId,
    carrier,
    order,
    sourceTabId: sender.tab.id,
    auditId: auditId || "",
    auditWorkerTabId: auditWorkerTabId ?? null,
    createdAt: Date.now()
  };
  const requestKey = `carrierStatusRequest:${requestId}`;
  await chrome.storage.session.set({ [requestKey]: request });
  const trackingUrl = carrier === "laposte"
    ? `${TRACKING_URLS[carrier]}?code=${encodeURIComponent(order.trackingNumber)}`
    : TRACKING_URLS[carrier];
  try {
    const destination = `${trackingUrl}#carrier-claim-check=${encodeURIComponent(requestId)}`;
    const tab = request.auditWorkerTabId != null
      ? await chrome.tabs.update(request.auditWorkerTabId, { active: false, url: destination })
      : await chrome.tabs.create({ active: false, url: destination });
    request.checkerTabId = tab.id;
    if (request.auditWorkerTabId != null) {
      await chrome.storage.session.remove(`orderAuditTab:${request.auditWorkerTabId}`);
    }
    await chrome.storage.session.set({
      [requestKey]: request,
      [`carrierStatusTab:${tab.id}`]: requestId
    });
    await chrome.alarms.create(`carrierStatusTimeout:${requestId}`, { when: Date.now() + STATUS_TIMEOUT_MS });
    return { ok: true, requestId };
  } catch (error) {
    await chrome.storage.session.remove(requestKey);
    throw error;
  }
}

async function deliverStatusResult(message, sender) {
  const key = `carrierStatusRequest:${message.requestId}`;
  const stored = await chrome.storage.session.get(key);
  const request = stored[key];
  if (!request) return { ok: false, error: "Status request expired." };

  const result = { ...message.result, carrier: request.carrier, checkedAt: new Date().toISOString() };
  await chrome.tabs.sendMessage(request.sourceTabId, request.auditId ? {
    type: "ORDER_AUDIT_RESULT",
    auditId: request.auditId,
    orderId: request.order?.orderId || "",
    order: request.order,
    result
  } : {
    type: "CARRIER_STATUS_RESULT",
    requestId: message.requestId,
    result
  }).catch(() => {});
  await chrome.alarms.clear(`carrierStatusTimeout:${message.requestId}`);
  await chrome.storage.session.remove([
    key,
    `carrierStatusTab:${sender.tab?.id}`
  ].filter(Boolean));
  if (request.auditWorkerTabId == null && sender.tab?.id) {
    await chrome.tabs.remove(sender.tab.id).catch(() => {});
  }
  return { ok: true };
}

async function expireStatusRequest(requestId, explanation) {
  const requestKey = `carrierStatusRequest:${requestId}`;
  const stored = await chrome.storage.session.get(requestKey);
  const request = stored[requestKey];
  if (!request) return;
  const result = {
      carrier: request.carrier,
      statusText: "Tracking status could not be read automatically.",
      summaryText: "",
      eventDate: null,
      checkedAt: new Date().toISOString(),
      error: explanation
  };
  await chrome.tabs.sendMessage(request.sourceTabId, request.auditId ? {
    type: "ORDER_AUDIT_RESULT",
    auditId: request.auditId,
    orderId: request.order?.orderId || "",
    order: request.order,
    result,
    error: explanation
  } : {
    type: "CARRIER_STATUS_RESULT",
    requestId,
    result
  }).catch(() => {});
  await chrome.storage.session.remove([
    requestKey,
    request.checkerTabId == null ? "" : `carrierStatusTab:${request.checkerTabId}`
  ].filter(Boolean));
  if (request.auditWorkerTabId == null && request.checkerTabId != null) {
    await chrome.tabs.remove(request.checkerTabId).catch(() => {});
  }
}

async function openCarrierClaim(claim, sourceTabId) {
  const url = CLAIM_URLS[claim?.carrier];
  if (!url) throw new Error("Unsupported carrier claim route.");
  const preparedClaim = { ...claim, sourceTabId };
  if (claim.carrier === "laposte") await chrome.storage.session.set({ pendingLaPosteClaim: preparedClaim });
  if (claim.carrier === "chronopost") await chrome.storage.session.set({ pendingChronopostClaim: preparedClaim });
  return chrome.tabs.create({
    url,
    active: claim.executionMode !== "automatic"
  });
}

async function statusRequestForContentScript(requestId) {
  if (!requestId) return { ok: false, error: "Missing status request ID." };
  const key = `carrierStatusRequest:${requestId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key]
    ? { ok: true, request: stored[key] }
    : { ok: false, error: "Status request expired." };
}

async function startOrderAudit(message, sender) {
  const orderId = String(message.orderId || "");
  if (!sender.tab?.id || !/^[0-9]{3}-[0-9]{7}-[0-9]{7}$/.test(orderId)) {
    return { ok: false, error: "Missing source tab or valid Amazon order ID." };
  }
  let orderUrl;
  try {
    orderUrl = new URL(message.orderUrl, "https://sellercentral.amazon.fr");
  } catch {
    return { ok: false, error: "Invalid Amazon order URL." };
  }
  if (orderUrl.origin !== "https://sellercentral.amazon.fr" || !orderUrl.pathname.startsWith(`/orders-v3/order/${orderId}`)) {
    return { ok: false, error: "The order URL does not match the requested Amazon order." };
  }

  const auditId = crypto.randomUUID();
  const requestKey = `orderAuditRequest:${auditId}`;
  const workerKey = `orderAuditWorker:${sender.tab.id}`;
  const request = { auditId, orderId, sourceTabId: sender.tab.id, createdAt: Date.now(), detailTabId: null, workerKey };
  await chrome.storage.session.set({ [requestKey]: request });
  orderUrl.hash = `carrier-claim-order-audit=${encodeURIComponent(auditId)}`;
  try {
    const storedWorker = await chrome.storage.session.get(workerKey);
    let tab = null;
    if (storedWorker[workerKey] != null) {
      tab = await chrome.tabs.update(storedWorker[workerKey], { active: false, url: orderUrl.href }).catch(() => null);
      if (!tab) await chrome.storage.session.remove(workerKey);
    }
    if (!tab) {
      tab = await chrome.tabs.create({ active: false, url: orderUrl.href });
      await chrome.storage.session.set({ [workerKey]: tab.id });
    }
    request.detailTabId = tab.id;
    await chrome.storage.session.set({
      [requestKey]: request,
      [`orderAuditTab:${tab.id}`]: auditId
    });
    await chrome.alarms.create(`orderAuditLoadTimeout:${auditId}`, { when: Date.now() + ORDER_AUDIT_LOAD_TIMEOUT_MS });
    return { ok: true, auditId };
  } catch (error) {
    await chrome.storage.session.remove(requestKey);
    return { ok: false, error: error.message };
  }
}

async function finishOrderAuditLoad(request, { order = null, result = null, error = "" } = {}) {
  await chrome.tabs.sendMessage(request.sourceTabId, {
    type: "ORDER_AUDIT_RESULT",
    auditId: request.auditId,
    orderId: request.orderId,
    order,
    result,
    error
  }).catch(() => {});
  await chrome.alarms.clear(`orderAuditLoadTimeout:${request.auditId}`);
  await chrome.storage.session.remove([
    `orderAuditRequest:${request.auditId}`,
    request.detailTabId == null ? "" : `orderAuditTab:${request.detailTabId}`
  ].filter(Boolean));
}

async function receiveOrderAuditDetails(message, sender) {
  const requestKey = `orderAuditRequest:${message.auditId}`;
  const stored = await chrome.storage.session.get(requestKey);
  const request = stored[requestKey];
  if (!request) return { ok: false, error: "Order audit request expired." };
  if (request.detailTabId != null && sender.tab?.id !== request.detailTabId) {
    return { ok: false, error: "Order details came from the wrong tab." };
  }
  const order = message.order || {};
  if (message.error || order.orderId !== request.orderId || !order.trackingNumber) {
    await finishOrderAuditLoad(request, {
      order,
      error: message.error || "Amazon did not expose a tracking number for this order."
    });
    return { ok: true, completed: true };
  }
  const carrier = carrierRules.detectCarrier(order);
  if (!carrier.supported) {
    await finishOrderAuditLoad(request, {
      order,
      error: `Unsupported carrier: ${carrier.label}`
    });
    return { ok: true, completed: true };
  }

  await chrome.alarms.clear(`orderAuditLoadTimeout:${request.auditId}`);
  let status;
  try {
    status = await startStatusCheck({
      carrier: carrier.id,
      order,
      auditId: request.auditId,
      auditWorkerTabId: request.detailTabId
    }, { tab: { id: request.sourceTabId } });
  } catch (error) {
    status = { ok: false, error: error.message };
  }
  if (!status.ok) {
    await finishOrderAuditLoad(request, { order, error: status.error });
    return status;
  }
  await chrome.storage.session.remove([
    requestKey,
    request.detailTabId == null ? "" : `orderAuditTab:${request.detailTabId}`
  ].filter(Boolean));
  return { ok: true, statusRequestId: status.requestId };
}

async function releaseOrderAuditWorker(sender) {
  if (sender.tab?.id == null) return { ok: false, error: "Missing Manage Orders source tab." };
  const workerKey = `orderAuditWorker:${sender.tab.id}`;
  const stored = await chrome.storage.session.get(workerKey);
  const workerTabId = stored[workerKey];
  await chrome.storage.session.remove(workerKey);
  if (workerTabId == null) return { ok: true, released: false };
  await chrome.storage.session.remove([
    `orderAuditTab:${workerTabId}`,
    `carrierStatusTab:${workerTabId}`
  ]);
  await chrome.tabs.remove(workerTabId).catch(() => {});
  return { ok: true, released: true };
}

function pendingClaimKey(carrier) {
  if (carrier === "laposte") return "pendingLaPosteClaim";
  if (carrier === "chronopost") return "pendingChronopostClaim";
  return "";
}

async function pendingClaimForContentScript(carrier) {
  const key = pendingClaimKey(carrier);
  if (!key) return { ok: false, error: "Unsupported carrier claim." };
  const stored = await chrome.storage.session.get(key);
  return { ok: true, claim: stored[key] || null };
}

async function updatePendingClaim(carrier, claim) {
  const key = pendingClaimKey(carrier);
  if (!key || !claim) return { ok: false, error: "Missing supported pending claim." };
  await chrome.storage.session.set({ [key]: claim });
  return { ok: true };
}

async function clearPendingClaim(carrier) {
  const key = pendingClaimKey(carrier);
  if (!key) return { ok: false, error: "Unsupported carrier claim." };
  await chrome.storage.session.remove(key);
  return { ok: true };
}

async function handleClaimWorkflowState(message, sender) {
  const key = pendingClaimKey(message.carrier);
  if (!key) return { ok: false, error: "Unsupported carrier claim." };
  const stored = await chrome.storage.session.get(key);
  const claim = stored[key];
  if (!claim || (message.claimId && claim.id !== message.claimId)) {
    return { ok: false, error: "Pending claim expired." };
  }

  if (claim.sourceTabId != null) {
    await chrome.tabs.sendMessage(claim.sourceTabId, {
      type: "CLAIM_WORKFLOW_STATE",
      carrier: message.carrier,
      claimId: claim.id,
      status: message.status,
      message: message.message || ""
    }).catch(() => {});
  }

  const needsForeground = ["captcha", "ready", "needs_attention", "error"].includes(message.status);
  if (needsForeground && sender.tab?.id != null) {
    await chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
  }
  return { ok: true, foregrounded: needsForeground };
}

async function handleClaimSubmissionSuccess(message) {
  const key = pendingClaimKey(message.carrier);
  if (!key) return { ok: false, error: "Unsupported carrier claim." };
  const storedClaim = await chrome.storage.session.get(key);
  const claim = storedClaim[key];
  if (!claim || !message.claimId || claim.id !== message.claimId) {
    return { ok: false, error: "Pending claim expired or does not match." };
  }
  if (!claim.submissionStartedAt) {
    return { ok: false, error: "The carrier submission was not explicitly confirmed." };
  }

  const reference = String(message.reference || "").replace(/[^A-Z0-9./_-]/gi, "").slice(0, 40);
  const outcome = {
    id: claim.id,
    carrier: claim.carrier,
    orderId: claim.order?.orderId || "",
    trackingNumber: claim.order?.trackingNumber || "",
    reason: claim.reason || "other",
    reference,
    confirmationText: String(message.confirmationText || "").replace(/\s+/g, " ").trim().slice(0, 500),
    submittedAt: new Date().toISOString(),
    noteSaved: false
  };
  outcome.sellerNote = outcomeRules.buildSellerNote(outcome);

  const storedOutcomes = await chrome.storage.local.get(CLAIM_OUTCOMES_KEY);
  const outcomes = { ...(storedOutcomes[CLAIM_OUTCOMES_KEY] || {}) };
  if (outcome.orderId) outcomes[outcome.orderId] = outcome;
  await chrome.storage.local.set({ [CLAIM_OUTCOMES_KEY]: outcomes });
  await chrome.storage.session.remove(key);

  let amazonResponse = null;
  if (claim.sourceTabId != null) {
    amazonResponse = await chrome.tabs.sendMessage(claim.sourceTabId, {
      type: "CLAIM_SUBMISSION_SUCCESS",
      outcome
    }).catch(() => null);
  }
  return { ok: true, outcome, noteSaved: Boolean(amazonResponse?.noteSaved) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CHECK_CARRIER_STATUS") {
    startStatusCheck(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CARRIER_STATUS_SCRAPED") {
    deliverStatusResult(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_CARRIER_STATUS_REQUEST") {
    statusRequestForContentScript(message.requestId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "START_ORDER_AUDIT") {
    startOrderAudit(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ORDER_AUDIT_DETAILS") {
    receiveOrderAuditDetails(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RELEASE_ORDER_AUDIT_WORKER") {
    releaseOrderAuditWorker(sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OPEN_CARRIER_CLAIM" && message.claim) {
    openCarrierClaim(message.claim, sender.tab?.id)
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_PENDING_CLAIM") {
    pendingClaimForContentScript(message.carrier)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "UPDATE_PENDING_CLAIM") {
    updatePendingClaim(message.carrier, message.claim)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_PENDING_CLAIM") {
    clearPendingClaim(message.carrier)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLAIM_WORKFLOW_STATE") {
    handleClaimWorkflowState(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLAIM_SUBMISSION_SUCCESS") {
    handleClaimSubmissionSuccess(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const sourceWorkerKey = `orderAuditWorker:${tabId}`;
  chrome.storage.session.get(sourceWorkerKey).then(async (stored) => {
    const workerTabId = stored[sourceWorkerKey];
    await chrome.storage.session.remove(sourceWorkerKey);
    if (workerTabId != null) await chrome.tabs.remove(workerTabId).catch(() => {});
  });

  const tabKey = `carrierStatusTab:${tabId}`;
  chrome.storage.session.get(tabKey).then(async (stored) => {
    const requestId = stored[tabKey];
    await chrome.storage.session.remove(tabKey);
    if (!requestId) return;
    await chrome.alarms.clear(`carrierStatusTimeout:${requestId}`);
    await expireStatusRequest(requestId, "The temporary carrier tracking tab closed before a readable result was returned.");
  });

  const auditTabKey = `orderAuditTab:${tabId}`;
  chrome.storage.session.get(auditTabKey).then(async (stored) => {
    const auditId = stored[auditTabKey];
    await chrome.storage.session.remove(auditTabKey);
    if (!auditId) return;
    const requestKey = `orderAuditRequest:${auditId}`;
    const requestStored = await chrome.storage.session.get(requestKey);
    const request = requestStored[requestKey];
    if (!request) return;
    await chrome.storage.session.remove(request.workerKey || `orderAuditWorker:${request.sourceTabId}`);
    await finishOrderAuditLoad({ ...request, detailTabId: null }, {
      error: "The temporary Amazon order-detail tab closed before shipment details were read."
    });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("orderAuditLoadTimeout:")) {
    const auditId = alarm.name.slice("orderAuditLoadTimeout:".length);
    const requestKey = `orderAuditRequest:${auditId}`;
    chrome.storage.session.get(requestKey).then(async (stored) => {
      const request = stored[requestKey];
      if (!request) return;
      await finishOrderAuditLoad(request, {
        error: "Amazon did not expose the order shipment details within 30 seconds."
      });
    });
    return;
  }
  if (!alarm.name.startsWith("carrierStatusTimeout:")) return;
  const requestId = alarm.name.slice("carrierStatusTimeout:".length);
  expireStatusRequest(requestId, "The official tracking page did not return a readable result within one minute.");
});
