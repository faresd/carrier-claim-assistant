"use strict";

if (typeof importScripts === "function") importScripts("shared/carrier-rules.js", "shared/claim-outcome.js", "shared/tracking-records.js");

const carrierRules = globalThis.CarrierClaimRules;
const outcomeRules = globalThis.CarrierClaimOutcomeRules;
const trackingRecords = globalThis.CarrierTrackingRecords;
const CLAIM_OUTCOMES_KEY = "claimOutcomesByOrder";
const TRACKED_ORDERS_KEY = "trackedOrdersByOrder";
const ORDER_AUDITS_KEY = "orderAuditResultsByOrder";
const MONITOR_ALERT_ALARM = "carrierReturnMonitorAlerts";
const MONITOR_ORIGIN = "https://tracking.cheaply.fr";

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
  laposteOverdueDays: 7,
  cloudSyncEnabled: false,
  monitorServerUrl: "https://tracking.cheaply.fr",
  monitorAccessToken: "",
  pickupNotifications: true
};

const STATUS_TIMEOUT_MS = 60000;
const ORDER_AUDIT_LOAD_TIMEOUT_MS = 30000;
const SELLER_NOTE_RETRY_ATTEMPTS = 24;
const SELLER_NOTE_RETRY_DELAY_MS = 750;

// Chrome storage does not make read/modify/write atomic. Keep every writer of
// this shared map in one service-worker queue; never wait for the network here.
let trackedOrdersMutation = Promise.resolve();
function mutateTrackedOrders(mutator, extraKeys = []) {
  const mutation = trackedOrdersMutation.then(async () => {
    const stored = await chrome.storage.local.get([TRACKED_ORDERS_KEY, ...extraKeys]);
    const records = trackingRecords.rekeyRecords(stored[TRACKED_ORDERS_KEY] || {});
    for (const [key, record] of Object.entries(records)) {
      const repaired = trackingRecords.repairRecord?.(record) || record;
      const original = trackingRecords.findRecordEntry(stored[TRACKED_ORDERS_KEY] || {}, record)?.value || record;
      const changed = repaired.trackingState !== original.trackingState;
      records[key] = {
        ...repaired,
        cloudSyncRevision: changed || !record.cloudSyncRevision ? crypto.randomUUID() : record.cloudSyncRevision,
        ...(changed ? { cloudSyncedAt: "", cloudSyncError: "" } : {})
      };
    }
    const result = await mutator(records, stored);
    await chrome.storage.local.set({ [TRACKED_ORDERS_KEY]: records });
    return result;
  });
  trackedOrdersMutation = mutation.catch(() => {});
  return mutation;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await mutateTrackedOrders(async (records, stored) => {
    const previousSettings = stored.claimSettings || {};
    let monitorOriginChanged = false;
    if (previousSettings.monitorServerUrl) {
      try {
        monitorOriginChanged = new URL(previousSettings.monitorServerUrl).origin !== MONITOR_ORIGIN;
      } catch {
        monitorOriginChanged = true;
      }
    }
    await chrome.storage.local.set({
      senderProfile: { ...DEFAULT_SENDER_PROFILE, ...(stored.senderProfile || {}) },
      claimSettings: {
        ...DEFAULT_CLAIM_SETTINGS,
        ...previousSettings,
        monitorServerUrl: MONITOR_ORIGIN,
        cloudSyncEnabled: monitorOriginChanged ? false : previousSettings.cloudSyncEnabled === true,
        monitorAccessToken: monitorOriginChanged ? "" : String(previousSettings.monitorAccessToken || "")
      },
      [CLAIM_OUTCOMES_KEY]: trackingRecords.rekeyRecords(stored[CLAIM_OUTCOMES_KEY] || {}),
      [ORDER_AUDITS_KEY]: trackingRecords.rekeyRecords(stored[ORDER_AUDITS_KEY] || {})
    });
  }, ["senderProfile", "claimSettings", CLAIM_OUTCOMES_KEY, ORDER_AUDITS_KEY]);
  await scheduleMonitorAlertPolling();
  if (details.reason === "install") await chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup?.addListener(() => {
  scheduleMonitorAlertPolling().then(() => Promise.allSettled([
    syncPendingTrackingRecords(),
    refreshMonitorAlerts()
  ])).catch(() => {});
});

async function scheduleMonitorAlertPolling() {
  await chrome.alarms.create(MONITOR_ALERT_ALARM, { delayInMinutes: 1, periodInMinutes: 15 });
}

function normalizedMonitorConfig(settings = {}) {
  let serverUrl = "";
  try {
    const url = new URL(String(settings.monitorServerUrl || "").trim());
    if (url.protocol === "https:" && url.origin === MONITOR_ORIGIN) serverUrl = url.origin;
  } catch {}
  return {
    enabled: settings.cloudSyncEnabled === true && Boolean(serverUrl && settings.monitorAccessToken),
    serverUrl,
    token: String(settings.monitorAccessToken || "").trim(),
    pickupNotifications: settings.pickupNotifications !== false
  };
}

async function monitorConfig(overrides = null) {
  if (overrides) return normalizedMonitorConfig({ cloudSyncEnabled: true, monitorServerUrl: overrides.serverUrl, monitorAccessToken: overrides.token });
  const stored = await chrome.storage.local.get("claimSettings");
  return normalizedMonitorConfig({ ...DEFAULT_CLAIM_SETTINGS, ...(stored.claimSettings || {}) });
}

async function monitorRequest(path, options = {}, overrides = null) {
  const config = await monitorConfig(overrides);
  if (!config.enabled) throw new Error("Return monitor cloud sync is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${config.serverUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && !overrides) {
      const stored = await chrome.storage.local.get("claimSettings");
      await chrome.storage.local.set({
        claimSettings: {
          ...DEFAULT_CLAIM_SETTINGS,
          ...(stored.claimSettings || {}),
          cloudSyncEnabled: false,
          monitorAccessToken: ""
        }
      });
      throw new Error("This browser's return-monitor access was revoked. Pair it again in Settings.");
    }
    if (response.status === 410 && payload.deleted === true) {
      const error = new Error(payload.error || "This resolved order was permanently deleted from the return monitor.");
      error.permanentlyDeleted = true;
      throw error;
    }
    if (!response.ok) throw new Error(payload.error || `Monitor server returned HTTP ${response.status}.`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function testMonitorConnection(serverUrl, token = "") {
  const config = normalizedMonitorConfig({
    cloudSyncEnabled: true,
    monitorServerUrl: serverUrl,
    monitorAccessToken: token || "health-check"
  });
  if (!config.serverUrl) throw new Error("Enter a secure HTTPS monitor server URL.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = token ? { authorization: `Bearer ${String(token).trim()}` } : {};
    const response = await fetch(`${config.serverUrl}/api/health`, { headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || `Monitor server returned HTTP ${response.status}.`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function buildClaimPayload(order, record, senderProfile, recommendation, result = {}) {
  const reason = recommendation?.reason === "none" ? "other" : recommendation?.reason || record.claimReason || "other";
  const recipientTitle = carrierRules.detectRecipientTitle(order.recipientName) || "";
  return {
    version: 1,
    carrier: record.carrierId,
    reason,
    reasonContract: carrierRules.carrierReasonContract(record.carrierId, reason),
    details: carrierRules.buildClaimMessage(order, { ...recommendation, reason }).slice(0, 500),
    recommendation: {
      recommended: Boolean(recommendation?.recommended),
      reason,
      title: recommendation?.title || record.claimTitle || "",
      statusText: recommendation?.statusText || record.statusText || ""
    },
    trackingStatus: {
      statusText: result.statusText || record.statusText || "",
      summaryText: result.summaryText || record.statusSummary || "",
      currentSummaryText: result.currentSummaryText || record.statusCurrentSummary || "",
      checkedAt: result.checkedAt || record.checkedAt || ""
    },
    order: {
      sourceUrl: order.sourceUrl || "",
      orderId: order.orderId || "",
      trackingNumber: order.trackingNumber || "",
      orderDate: order.orderDate || "",
      shipDate: order.shipDate || "",
      deliverBy: order.deliverBy || "",
      carrier: order.carrier || record.carrierLabel || "",
      shippingService: order.shippingService || "",
      itemValue: order.itemValue || "",
      quantity: order.quantity || "1",
      productName: order.productName || "",
      asin: order.asin || "",
      sku: order.sku || "",
      recipientName: order.recipientName || "",
      recipientAddress1: order.recipientAddress1 || "",
      recipientAddress2: order.recipientAddress2 || "",
      recipientCity: order.recipientCity || "",
      recipientPostalCode: order.recipientPostalCode || "",
      recipientCountry: order.recipientCountry || "",
      sellerAccountId: record.sellerAccountId || "",
      sellerAccountName: record.sellerAccountName || "",
      marketplaceId: record.marketplaceId || ""
    },
    sender: { ...DEFAULT_SENDER_PROFILE, ...(senderProfile || {}) },
    recipientTitle,
    executionMode: "automatic"
  };
}

async function saveTrackingRecord(order, result = {}, recommendation = null, outcome = null) {
  if (!order?.orderId || !order?.trackingNumber || !trackingRecords) return null;
  const { record, config } = await mutateTrackedOrders((records, stored) => {
    const previousEntry = trackingRecords.findRecordEntry(records, order);
    const previous = previousEntry?.value || null;
    const settings = { ...DEFAULT_CLAIM_SETTINGS, ...(stored.claimSettings || {}) };
    const resolvedRecommendation = recommendation || carrierRules.recommendClaim(order, result || {}, settings);
    const resolvedOutcome = outcome || trackingRecords.findRecord(stored[CLAIM_OUTCOMES_KEY] || {}, order);
    const previousIdentity = trackingRecords.identity(previous || {});
    const orderIdentity = trackingRecords.identity(order);
    const fallbackAccounts = new Set(["default", "sellercentral.amazon.fr"]);
    const accountWasDisambiguated = previous && fallbackAccounts.has(previousIdentity.sellerAccountId)
      && !fallbackAccounts.has(orderIdentity.sellerAccountId);
    const record = {
      ...trackingRecords.buildRecord({ order, result, recommendation: resolvedRecommendation, outcome: resolvedOutcome, previous }),
      cloudSyncRevision: crypto.randomUUID(),
      cloudSyncedAt: "",
      cloudSyncError: "",
      cloudDeletedAt: accountWasDisambiguated ? "" : previous?.cloudDeletedAt || ""
    };
    record.claimPayload = buildClaimPayload(order, record, stored.senderProfile, resolvedRecommendation, result);
    if (previousEntry?.key && previousEntry.key !== record.recordId) delete records[previousEntry.key];
    records[record.recordId] = record;
    return { record, config: normalizedMonitorConfig(settings) };
  }, ["claimSettings", "senderProfile", CLAIM_OUTCOMES_KEY]);
  if (config.enabled && !record.cloudDeletedAt) {
    return (await uploadTrackingRecord(record)).record;
  }
  return record;
}

function isPendingTrackingRecord(record) {
  return record?.orderId && record?.trackingNumber && !record.cloudDeletedAt && (!record.cloudSyncedAt || record.cloudSyncError);
}

// Serialize uploads per order, not globally: a slow request must not prevent
// other accounts being saved, nor arrive after a newer version of this order.
const trackingUploads = new Map();
function uploadTrackingRecord(snapshot) {
  const key = trackingRecords.recordKey(snapshot);
  const previous = trackingUploads.get(key) || Promise.resolve();
  const upload = previous.catch(() => {}).then(async () => {
    const record = await mutateTrackedOrders((records) => records[key] || null);
    if (!isPendingTrackingRecord(record) || record.cloudSyncRevision !== snapshot.cloudSyncRevision) {
      return { record, skipped: true };
    }
    const attemptedAt = new Date().toISOString();
    let error = null;
    try {
      await monitorRequest("/api/orders", { method: "POST", body: JSON.stringify(record) });
    } catch (failure) {
      error = failure;
    }
    const saved = await mutateTrackedOrders((records) => {
      const current = records[key];
      // A completed request is not permission to recreate a removed order or
      // acknowledge a newer local version that it did not actually upload.
      if (!current || current.cloudDeletedAt) return current || null;
      if (error?.permanentlyDeleted) {
        records[key] = { ...current, cloudSyncedAt: attemptedAt, cloudDeletedAt: attemptedAt, cloudSyncError: "", cloudSyncAttemptedAt: attemptedAt };
      } else if (current.cloudSyncRevision === record.cloudSyncRevision) {
        records[key] = {
          ...current,
          cloudSyncedAt: error ? current.cloudSyncedAt || "" : attemptedAt,
          cloudSyncAttemptedAt: attemptedAt,
          cloudSyncError: error?.message || ""
        };
      }
      return records[key];
    });
    return { record: saved, error };
  });
  trackingUploads.set(key, upload);
  upload.finally(() => { if (trackingUploads.get(key) === upload) trackingUploads.delete(key); }).catch(() => {});
  return upload;
}

async function syncPendingTrackingRecords({ limit = 50 } = {}) {
  const config = await monitorConfig();
  if (!config.enabled) return { ok: true, skipped: true, uploaded: 0, remaining: 0 };
  const pending = await mutateTrackedOrders((records) => Object.values(records).filter(isPendingTrackingRecord));
  let uploaded = 0;
  let failed = 0;
  let suppressed = 0;
  for (const record of pending.slice(0, Math.max(1, Math.min(100, Number(limit) || 50)))) {
    const result = await uploadTrackingRecord(record);
    if (result.skipped) continue;
    if (!result.error) uploaded += 1;
    else {
      if (result.error.permanentlyDeleted) {
        suppressed += 1;
        continue;
      }
      failed += 1;
      if (/revoked|not configured/i.test(result.error.message)) break;
    }
  }
  const remaining = await mutateTrackedOrders((records) => Object.values(records).filter(isPendingTrackingRecord).length);
  return { ok: failed === 0, uploaded, failed, suppressed, remaining };
}

async function mergeRemoteTrackingRecords(remoteOrders = []) {
  return mutateTrackedOrders((records) => {
    for (const remote of remoteOrders) {
      if (!remote?.orderId) continue;
      const previousEntry = trackingRecords.findRecordEntry(records, remote);
      const local = previousEntry?.value || {};
      const fallbackAccounts = new Set(["default", "sellercentral.amazon.fr"]);
      const preserveAccount = previousEntry && !fallbackAccounts.has(trackingRecords.identity(local).sellerAccountId)
        && fallbackAccounts.has(trackingRecords.identity(remote).sellerAccountId);
      const key = trackingRecords.recordKey(preserveAccount ? local : remote);
      if (!key || local.cloudDeletedAt) continue;
      if (previousEntry?.key && previousEntry.key !== key) delete records[previousEntry.key];
      const incoming = {
        ...local,
        ...remote,
        recordId: key,
        sourceUrl: remote.amazonUrl || local.sourceUrl || "",
        sellerAccountId: preserveAccount ? local.sellerAccountId : remote.accountId || remote.sellerAccountId || local.sellerAccountId || "",
        sellerAccountName: preserveAccount ? local.sellerAccountName : remote.accountName || remote.sellerAccountName || local.sellerAccountName || "",
        cloudSyncedAt: local.cloudSyncedAt || (previousEntry ? "" : new Date().toISOString()),
        cloudSyncError: local.cloudSyncError || "",
        cloudDeletedAt: local.cloudDeletedAt || ""
      };
      // Do not replace an unsent local edit with a remote snapshot. Server-side
      // receipt confirmation and a genuinely newer carrier check still win.
      const remoteDataIsOlder = Date.parse(remote.updatedAt || "") < Date.parse(local.updatedAt || "");
      const merged = isPendingTrackingRecord(local) || remoteDataIsOlder ? { ...incoming, ...local } : incoming;
      merged.recordId = key;
      merged.sellerAccountId = incoming.sellerAccountId;
      merged.marketplaceId = incoming.marketplaceId;
      if ("accountId" in merged) merged.accountId = incoming.sellerAccountId;
      const localServerRevision = Date.parse(local.cloudUpdatedAt || local.resolvedAt || "");
      const remoteServerRevision = Date.parse(remote.updatedAt || "");
      const staleRemoteState = remoteServerRevision < localServerRevision;
      const remoteReopened = local.trackingState === "resolved" && remote.trackingState && remote.trackingState !== "resolved"
        && remote.resolvedAt === "" && remoteServerRevision > localServerRevision;
      if (remote.updatedAt && (!local.cloudUpdatedAt || remoteServerRevision >= Date.parse(local.cloudUpdatedAt))) {
        merged.cloudUpdatedAt = remote.updatedAt;
      }
      const remoteIsNewer = Date.parse(remote.checkedAt || "") > Date.parse(local.checkedAt || "") ||
        (remote.checkedAt && !local.checkedAt);
      const preserveLocalStatus = staleRemoteState || (local.trackingState === "resolved" && !remoteReopened)
        || (local.trackingState === "returned_delivered" && ["delivered", "unknown"].includes(remote.trackingState))
        || (!remoteIsNewer && local.checkedAt && local.checkedAt !== remote.checkedAt);
      const serverResolution = !staleRemoteState && (remote.trackingState === "resolved" || remoteReopened);
      const statusOwner = serverResolution ? remote : preserveLocalStatus ? local : remoteIsNewer ? remote : merged;
      for (const field of ["trackingState", "statusText", "statusSummary", "statusCurrentSummary", "checkedAt", "trackingSource", "resolvedAt", "resolutionNote"]) {
        if (field in statusOwner) merged[field] = statusOwner[field];
      }
      const remoteClaimIsOlder = Date.parse(remote.claimSubmittedAt || "") < Date.parse(local.claimSubmittedAt || "");
      const claimOwner = remote.claimStatus === "sent" && !(local.claimStatus === "sent" && remoteClaimIsOlder)
        ? remote : local.claimStatus === "sent" ? local : null;
      if (claimOwner) {
        for (const field of ["claimStatus", "claimReference", "claimSubmittedAt"]) {
          if (field in claimOwner) merged[field] = claimOwner[field];
        }
        if (!merged.claimReference && local.claimStatus === "sent" && local.claimReference &&
          (!remote.claimSubmittedAt || remote.claimSubmittedAt === local.claimSubmittedAt)) merged.claimReference = local.claimReference;
      }
      const repaired = trackingRecords.repairRecord?.(merged) || merged;
      records[key] = {
        ...repaired,
        cloudSyncRevision: JSON.stringify(repaired) === JSON.stringify(local) && local.cloudSyncRevision ? local.cloudSyncRevision : crypto.randomUUID()
      };
    }
    return records;
  });
}

async function trackedRecords({ refresh = true, orderIds = [] } = {}) {
  if (refresh) {
    const config = await monitorConfig();
    if (config.enabled) {
      const validOrderIds = [...new Set((orderIds || []).map(String).filter((value) => /^[0-9]{3}-[0-9]{7}-[0-9]{7}$/.test(value)))].slice(0, 100);
      const query = validOrderIds.length
        ? `?limit=${validOrderIds.length}&order_ids=${encodeURIComponent(validOrderIds.join(","))}`
        : "?limit=500";
      const payload = await monitorRequest(`/api/orders${query}`).catch(() => null);
      if (payload?.orders) return mergeRemoteTrackingRecords(payload.orders);
    }
  }
  return mutateTrackedOrders((records) => records);
}

async function refreshMonitorAlerts() {
  const config = await monitorConfig();
  if (!config.enabled || !config.pickupNotifications) return { ok: true, skipped: true };
  const payload = await monitorRequest("/api/orders?alerts=1&limit=100");
  await mergeRemoteTrackingRecords(payload.orders || []);
  for (const order of payload.orders || []) {
    const notificationId = `return-pickup:${encodeURIComponent(order.recordId || order.orderId)}`;
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Returned package ready for pickup",
      message: `Order ${order.orderId} · ${order.trackingNumber} is waiting to be collected.`,
      contextMessage: order.accountName || order.carrierLabel || "Carrier Return Monitor",
      priority: 2,
      requireInteraction: true
    });
    await monitorRequest(`/api/orders/${encodeURIComponent(order.recordId || order.orderId)}/ack-pickup`, { method: "POST", body: "{}" });
  }
  return { ok: true, count: (payload.orders || []).length };
}

async function pairMonitorDevice({ serverUrl, code, deviceName }) {
  const config = normalizedMonitorConfig({ cloudSyncEnabled: true, monitorServerUrl: serverUrl, monitorAccessToken: "temporary" });
  if (!config.serverUrl || !/^\d{6}$/.test(String(code || "").trim())) throw new Error("Enter the server URL and six-digit pairing code.");
  let response;
  try {
    response = await fetch(`${config.serverUrl}/api/pairing/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: String(code).trim(), deviceName: String(deviceName || navigator.userAgent || "Chrome/Brave browser").slice(0, 100) })
    });
  } catch (error) {
    throw new Error(`Cannot reach the return monitor. Check the server URL and browser permission (${error.message}).`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) {
    const detail = payload.error || `Pairing endpoint returned HTTP ${response.status}.`;
    throw new Error(detail);
  }
  const stored = await chrome.storage.local.get("claimSettings");
  const claimSettings = {
    ...DEFAULT_CLAIM_SETTINGS,
    ...(stored.claimSettings || {}),
    cloudSyncEnabled: true,
    monitorServerUrl: config.serverUrl,
    monitorAccessToken: payload.token,
    pickupNotifications: true
  };
  await chrome.storage.local.set({ claimSettings });
  await scheduleMonitorAlertPolling();
  const sync = await syncPendingTrackingRecords();
  return { ok: true, deviceId: payload.deviceId, deviceName: payload.deviceName, uploadedOrders: sync.uploaded, pendingOrders: sync.remaining };
}

async function redeemCloudClaimLaunch(token) {
  const cleanToken = String(token || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 160);
  if (!cleanToken) throw new Error("The cloud claim link is missing or invalid.");
  const payload = await monitorRequest("/api/claim-launch/redeem", {
    method: "POST",
    body: JSON.stringify({ token: cleanToken })
  });
  const claim = payload.claim;
  if (!claim || !["laposte", "chronopost"].includes(claim.carrier)) throw new Error("The cloud claim package is invalid.");
  await updatePendingClaim(claim.carrier, claim);
  return { ok: true, claim };
}

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

  const result = {
    ...message.result,
    carrier: request.carrier,
    checkedAt: new Date().toISOString(),
    source: `carrier-page-${request.carrier}`
  };
  await saveTrackingRecord(request.order, result);
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
  await saveTrackingRecord(order, {}, carrierRules.recommendClaim(order, {}));
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

function sellerNoteOrderUrl(order = {}, outcome = {}) {
  const orderId = String(order.orderId || outcome.orderId || "").trim();
  if (!/^[0-9]{3}-[0-9]{7}-[0-9]{7}$/.test(orderId) || !order.sourceUrl) return "";
  try {
    const url = new URL(String(order.sourceUrl));
    if (url.origin !== "https://sellercentral.amazon.fr" || url.pathname !== `/orders-v3/order/${orderId}`) return "";
    url.hash = `carrier-claim-seller-note=${encodeURIComponent(outcome.id || orderId)}`;
    return url.toString();
  } catch {
    return "";
  }
}

async function saveSellerNoteInBackground(claim, outcome) {
  const url = sellerNoteOrderUrl(claim.order, outcome);
  if (!url) return null;
  const tab = await chrome.tabs.create({ active: false, url });
  try {
    for (let attempt = 0; attempt < SELLER_NOTE_RETRY_ATTEMPTS; attempt += 1) {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "CLAIM_SUBMISSION_SUCCESS",
        outcome
      }).catch(() => null);
      if (response?.noteSaved) return response;
      if (attempt + 1 < SELLER_NOTE_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SELLER_NOTE_RETRY_DELAY_MS));
      }
    }
    return null;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
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

async function handleClaimSubmissionSuccess(message, sender) {
  const key = pendingClaimKey(message.carrier);
  if (!key) return { ok: false, error: "Unsupported carrier claim." };
  const storedClaim = await chrome.storage.session.get(key);
  const claim = storedClaim[key];
  if (!claim || !message.claimId || claim.id !== message.claimId) {
    return { ok: false, error: "Pending claim expired or does not match." };
  }
  const reference = String(message.reference || "").replace(/[^A-Z0-9./_-]/gi, "").slice(0, 40);
  const senderUrl = String(sender?.url || sender?.tab?.url || "");
  const recoveredFromOfficialConfirmation = message.recoveredFromCarrierConfirmation === true &&
    message.carrier === "laposte" &&
    Boolean(reference) &&
    /^https:\/\/(?:contact\.aide|aide)\.laposte\.fr\//i.test(senderUrl);
  if (!claim.submissionStartedAt && !recoveredFromOfficialConfirmation) {
    return { ok: false, error: "The carrier submission was not explicitly confirmed." };
  }

  const outcome = {
    id: claim.id,
    carrier: claim.carrier,
    orderId: claim.order?.orderId || "",
    trackingNumber: claim.order?.trackingNumber || "",
    sellerAccountId: claim.order?.sellerAccountId || "sellercentral.amazon.fr",
    sellerAccountName: claim.order?.sellerAccountName || "Seller Central account",
    marketplaceId: claim.order?.marketplaceId || "A13V1IB3VIYZZH",
    reason: claim.reason || "other",
    reference,
    confirmationText: String(message.confirmationText || "").replace(/\s+/g, " ").trim().slice(0, 500),
    submittedAt: new Date().toISOString(),
    noteSaved: false
  };
  outcome.sellerNote = outcomeRules.buildSellerNote(outcome);
  outcome.recordId = trackingRecords.recordKey(outcome);

  const storedOutcomes = await chrome.storage.local.get(CLAIM_OUTCOMES_KEY);
  const outcomes = trackingRecords.rekeyRecords(storedOutcomes[CLAIM_OUTCOMES_KEY] || {});
  const previousOutcome = trackingRecords.findRecordEntry(outcomes, outcome);
  if (previousOutcome?.key && previousOutcome.key !== outcome.recordId) delete outcomes[previousOutcome.key];
  if (outcome.recordId) outcomes[outcome.recordId] = outcome;
  await chrome.storage.local.set({ [CLAIM_OUTCOMES_KEY]: outcomes });
  await saveTrackingRecord(claim.order || {}, claim.trackingStatus || {}, claim.recommendation || null, outcome);
  await chrome.storage.session.remove(key);

  let amazonResponse = null;
  if (claim.sourceTabId != null) {
    amazonResponse = await chrome.tabs.sendMessage(claim.sourceTabId, {
      type: "CLAIM_SUBMISSION_SUCCESS",
      outcome
    }).catch(() => null);
  }
  if (!amazonResponse) {
    amazonResponse = await saveSellerNoteInBackground(claim, outcome);
  }
  return { ok: true, outcome, noteSaved: Boolean(amazonResponse?.noteSaved) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "REGISTER_TRACKED_ORDER") {
    saveTrackingRecord(message.order || {}, message.result || {}, message.recommendation || null, message.outcome || null)
      .then((record) => sendResponse({ ok: true, record }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_TRACKED_RECORDS") {
    trackedRecords({ refresh: message.refresh !== false, orderIds: message.orderIds || [] })
      .then((records) => sendResponse({ ok: true, records }))
      .catch((error) => sendResponse({ ok: false, records: {}, error: error.message }));
    return true;
  }

  if (message?.type === "PAIR_MONITOR_DEVICE") {
    pairMonitorDevice(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TEST_MONITOR_CONNECTION") {
    testMonitorConnection(message.serverUrl, message.token)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REDEEM_CLOUD_CLAIM") {
    redeemCloudClaimLaunch(message.token)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REFRESH_MONITOR_ALERTS") {
    refreshMonitorAlerts().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
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
    handleClaimSubmissionSuccess(message, sender)
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

chrome.notifications?.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("return-pickup:")) return;
  const recordId = decodeURIComponent(notificationId.slice("return-pickup:".length));
  chrome.storage.local.get(TRACKED_ORDERS_KEY).then((stored) => {
    const record = Object.values(stored[TRACKED_ORDERS_KEY] || {}).find((item) => item.recordId === recordId);
    const url = record?.sourceUrl || (record?.orderId ? `https://sellercentral.amazon.fr/orders-v3/order/${record.orderId}` : "");
    if (url) chrome.tabs.create({ url, active: true });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MONITOR_ALERT_ALARM) {
    syncPendingTrackingRecords().catch(() => {});
    refreshMonitorAlerts().catch(() => {});
    return;
  }
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
