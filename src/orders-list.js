(function initAmazonOrdersListAssistant() {
  "use strict";

  if (window.top !== window || document.getElementById("lpca-orders-toolbar")) return;

  const rules = globalThis.CarrierClaimRules;
  const orderParser = globalThis.LaPosteOrderParser;
  const listRules = globalThis.CarrierOrderListRules;
  const trackingRecords = globalThis.CarrierTrackingRecords;
  const MAX_CONCURRENCY = 1;
  const CACHE_HOURS = 12;
  const state = {
    rows: new Map(),
    outcomes: {},
    audits: {},
    records: {},
    settings: {},
    queue: [],
    queued: new Set(),
    starting: new Set(),
    active: new Map(),
    paused: false,
    initialized: false,
    workerReleasePending: false,
    remoteLookupQueued: new Set(),
    remoteLookupTimer: null,
    observedLocation: `${location.pathname}${location.search}`
  };

  function eligibility() {
    if (location.pathname.includes("/shipped")) return "shipped";
    if (location.pathname.includes("/unshipped")) return "unshipped";
    if (location.pathname.includes("/canceled")) return "canceled";
    if (location.pathname.includes("/pending")) return "pending";
    return "other";
  }

  function sellerContextFromUrl(value) {
    try {
      const url = new URL(value || "", location.origin);
      return {
        sellerAccountId: url.searchParams.get("mons_sel_mcid") || url.searchParams.get("merchantId") || "",
        marketplaceId: url.searchParams.get("mons_sel_mkid") || url.searchParams.get("marketplaceId") || ""
      };
    } catch {
      return { sellerAccountId: "", marketplaceId: "" };
    }
  }

  function entryIdentity(entry, order = null) {
    return {
      orderId: entry?.orderId || order?.orderId || "",
      trackingNumber: order?.trackingNumber || "",
      sellerAccountId: order?.sellerAccountId || entry?.sellerAccountId || "sellercentral.amazon.fr",
      sellerAccountName: order?.sellerAccountName || entry?.sellerAccountName || "",
      marketplaceId: order?.marketplaceId || entry?.marketplaceId || "A13V1IB3VIYZZH"
    };
  }

  function recordForEntry(entry) {
    return trackingRecords.findRecord(state.records, entryIdentity(entry));
  }

  function localOutcomeForEntry(entry) {
    return trackingRecords.findRecord(state.outcomes, entryIdentity(entry));
  }

  function claimOutcomeForEntry(entry, record = recordForEntry(entry)) {
    const local = localOutcomeForEntry(entry);
    return local || trackingRecords.claimOutcomeForRecord(record);
  }

  function auditEntryFor(entry) {
    const exactKey = trackingRecords.recordKey(entryIdentity(entry));
    if (state.audits[exactKey]) return { key: exactKey, value: state.audits[exactKey] };
    if (state.audits[entry.orderId]) return { key: entry.orderId, value: state.audits[entry.orderId] };
    const candidates = Object.entries(state.audits).filter(([, audit]) => audit?.order?.orderId === entry.orderId);
    if (candidates.length === 1) return { key: candidates[0][0], value: candidates[0][1] };
    const exact = candidates.find(([, audit]) => trackingRecords.recordKey(audit.order) === exactKey);
    return exact ? { key: exact[0], value: exact[1] } : null;
  }

  function deleteAuditForEntry(entry) {
    const saved = auditEntryFor(entry);
    if (saved) delete state.audits[saved.key];
    delete state.audits[entry.orderId];
  }

  function ensureToolbar() {
    let toolbar = document.getElementById("lpca-orders-toolbar");
    if (toolbar) return toolbar;
    toolbar = document.createElement("section");
    toolbar.id = "lpca-orders-toolbar";
    toolbar.className = "lpca-orders-toolbar";
    toolbar.innerHTML = `
      <div>
        <small>Carrier Claim Assistant</small>
        <strong id="lpca-orders-summary">Finding order rows…</strong>
      </div>
      <div class="lpca-orders-toolbar__actions">
        <button id="lpca-orders-pause" class="lpca-button lpca-button--secondary" type="button">Pause scan</button>
        <button id="lpca-orders-rescan" class="lpca-button" type="button">Recheck page</button>
      </div>`;
    const heading = [...document.querySelectorAll("h1")].find((node) => /manage orders/i.test(node.innerText));
    if (heading) heading.insertAdjacentElement("afterend", toolbar);
    else document.body.prepend(toolbar);
    toolbar.querySelector("#lpca-orders-pause").addEventListener("click", () => {
      state.paused = !state.paused;
      toolbar.querySelector("#lpca-orders-pause").textContent = state.paused ? "Resume scan" : "Pause scan";
      if (!state.paused) pumpQueue();
      updateToolbar();
    });
    toolbar.querySelector("#lpca-orders-rescan").addEventListener("click", () => {
      for (const [orderId, entry] of state.rows) {
        deleteAuditForEntry(entry);
        enqueue(orderId, true);
      }
      chrome.storage.local.set({ orderAuditResultsByOrder: state.audits });
      state.paused = false;
      toolbar.querySelector("#lpca-orders-pause").textContent = "Pause scan";
      pumpQueue();
    });
    return toolbar;
  }

  function badgeElement(entry) {
    let badge = entry.row.querySelector(`.lpca-order-badge[data-order-id="${entry.orderId}"]`);
    if (badge) return badge;
    badge = document.createElement("button");
    badge.type = "button";
    badge.className = "lpca-order-badge";
    badge.dataset.orderId = entry.orderId;
    badge.addEventListener("click", (event) => {
      if (badge.dataset.actionable !== "true") return;
      event.preventDefault();
      event.stopPropagation();
      location.assign(entry.link.href);
    });
    entry.link.insertAdjacentElement("afterend", badge);
    return badge;
  }

  function statusTimeElement(entry) {
    let element = entry.row.querySelector(`.lpca-order-status-time[data-order-id="${entry.orderId}"]`);
    if (element) return element;
    element = document.createElement("small");
    element.className = "lpca-order-status-time";
    element.dataset.orderId = entry.orderId;
    badgeElement(entry).insertAdjacentElement("afterend", element);
    return element;
  }

  function setBadge(entry, model, tooltip = "", times = {}) {
    const badge = badgeElement(entry);
    const statusTime = statusTimeElement(entry);
    const timeLabels = [];
    const checkedAt = listRules.formatStatusTimestamp(times.checkedAt);
    const submittedAt = listRules.formatStatusTimestamp(times.submittedAt);
    if (checkedAt) timeLabels.push(`Last checked: ${checkedAt}`);
    if (submittedAt) timeLabels.push(`Claim submitted: ${submittedAt}`);
    badge.dataset.state = model.state;
    badge.dataset.actionable = String(Boolean(model.actionable));
    badge.textContent = model.label;
    badge.title = [tooltip || `${model.label} · Open order details`, ...timeLabels].filter(Boolean).join(" · ");
    badge.disabled = !model.actionable;
    statusTime.textContent = timeLabels.join(" · ");
    statusTime.hidden = timeLabels.length === 0;
    updateToolbar();
  }

  function renderOrder(orderId) {
    const entry = state.rows.get(orderId);
    if (!entry) return;
    const trackingRecord = recordForEntry(entry);
    const outcome = claimOutcomeForEntry(entry, trackingRecord);
    const auditEntry = auditEntryFor(entry);
    const audit = rules.repairAudit(auditEntry?.value);
    if (auditEntry && audit !== auditEntry.value) {
      state.audits[auditEntry.key] = audit;
      chrome.storage.local.set({ orderAuditResultsByOrder: state.audits });
    }
    const returnBadge = trackingRecords.badgeForRecord(trackingRecord);
    if (returnBadge) {
      setBadge(
        entry,
        returnBadge,
        [trackingRecord.trackingNumber, trackingRecord.statusText].filter(Boolean).join(" · "),
        { checkedAt: trackingRecord.checkedAt, submittedAt: outcome?.submittedAt }
      );
      return;
    }
    if (outcome) {
      setBadge(
        entry,
        listRules.badgeFor({ outcome }),
        [outcome.trackingNumber, outcome.reference].filter(Boolean).join(" · "),
        { checkedAt: audit?.checkedAt, submittedAt: outcome.submittedAt }
      );
      return;
    }
    const eligible = eligibility();
    if (eligible !== "shipped") {
      setBadge(entry, listRules.badgeFor({ eligibility: eligible }));
      return;
    }
    if (audit?.order) {
      const detectedCarrierId = rules.detectCarrier(audit.order).id;
      const auditedCarrierId = audit.result?.carrier || audit.recommendation?.carrier?.id || "";
      if (auditedCarrierId && detectedCarrierId !== auditedCarrierId) {
        deleteAuditForEntry(entry);
        chrome.storage.local.set({ orderAuditResultsByOrder: state.audits });
        setBadge(entry, listRules.badgeFor({}), "Carrier corrected from the tracking-number format");
        enqueue(orderId, true);
        return;
      }
    }
    if (listRules.auditIsFresh(audit, CACHE_HOURS)) {
      const recommendation = audit.recommendation || (audit.order
        ? rules.recommendClaim(audit.order, audit.result || {}, state.settings)
        : null);
      setBadge(
        entry,
        listRules.badgeFor({ recommendation, error: audit.error }),
        [audit.order?.carrier, audit.order?.trackingNumber, recommendation?.statusText || audit.error].filter(Boolean).join(" · "),
        { checkedAt: audit.checkedAt }
      );
      return;
    }
    setBadge(entry, listRules.badgeFor({}), "", { checkedAt: audit?.checkedAt });
    enqueue(orderId);
  }

  function discoverRows() {
    ensureToolbar();
    const currentLocation = `${location.pathname}${location.search}`;
    if (currentLocation !== state.observedLocation) {
      state.observedLocation = currentLocation;
      state.rows.clear();
      state.queue = [];
      state.queued.clear();
    }
    const discoveredOrderIds = [];
    const visibleOrderIds = new Set();
    const links = [...document.querySelectorAll('a[href*="/orders-v3/order/"]')];
    const pageContext = orderParser?.enrichSellerContext
      ? orderParser.enrichSellerContext(sellerContextFromUrl(location.href), document, location.href)
      : sellerContextFromUrl(location.href);
    for (const link of links) {
      const orderId = listRules.orderIdFromHref(link.href);
      if (!orderId || link.textContent.trim() !== orderId) continue;
      const row = link.closest("tr");
      if (!row) continue;
      visibleOrderIds.add(orderId);
      if (!state.rows.has(orderId)) discoveredOrderIds.push(orderId);
      const linkContext = sellerContextFromUrl(link.href);
      const previous = state.rows.get(orderId) || {};
      state.rows.set(orderId, {
        ...previous,
        orderId,
        link,
        row,
        sellerAccountId: linkContext.sellerAccountId || pageContext.sellerAccountId || previous.sellerAccountId || "sellercentral.amazon.fr",
        sellerAccountName: pageContext.sellerAccountName || previous.sellerAccountName || "",
        marketplaceId: linkContext.marketplaceId || pageContext.marketplaceId || previous.marketplaceId || "A13V1IB3VIYZZH"
      });
      renderOrder(orderId);
    }
    for (const orderId of state.rows.keys()) {
      if (!visibleOrderIds.has(orderId)) state.rows.delete(orderId);
    }
    state.queue = state.queue.filter((orderId) => visibleOrderIds.has(orderId));
    for (const orderId of state.queued) {
      if (!visibleOrderIds.has(orderId)) state.queued.delete(orderId);
    }
    if (state.initialized && discoveredOrderIds.length) scheduleRemoteLookup(discoveredOrderIds);
    updateToolbar();
    pumpQueue();
  }

  function scheduleRemoteLookup(orderIds) {
    for (const orderId of orderIds) state.remoteLookupQueued.add(orderId);
    clearTimeout(state.remoteLookupTimer);
    state.remoteLookupTimer = setTimeout(async () => {
      const wanted = [...state.remoteLookupQueued];
      state.remoteLookupQueued.clear();
      const remote = await chrome.runtime.sendMessage({ type: "GET_TRACKED_RECORDS", refresh: true, orderIds: wanted }).catch(() => null);
      if (!remote?.ok) return;
      state.records = remote.records || state.records;
      for (const orderId of wanted) renderOrder(orderId);
    }, 250);
  }

  function enqueue(orderId, force = false) {
    const entry = state.rows.get(orderId);
    if (!entry || eligibility() !== "shipped" || claimOutcomeForEntry(entry)) return;
    if (!force && trackingRecords.badgeForRecord(recordForEntry(entry))) return;
    if (state.queued.has(orderId) || state.starting.has(orderId) || [...state.active.values()].includes(orderId)) return;
    if (!force && listRules.auditIsFresh(auditEntryFor(entry)?.value, CACHE_HOURS)) return;
    state.queue.push(orderId);
    state.queued.add(orderId);
  }

  async function startAudit(orderId) {
    const entry = state.rows.get(orderId);
    if (!entry) return;
    state.starting.add(orderId);
    const badge = badgeElement(entry);
    badge.dataset.state = "checking";
    badge.textContent = "Checking carrier…";
    badge.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_ORDER_AUDIT",
        orderId,
        orderUrl: entry.link.href
      });
      if (!response?.ok) throw new Error(response?.error || "Order audit could not start.");
      state.active.set(response.auditId, orderId);
    } catch (error) {
      await saveAudit(orderId, { error: error.message, checkedAt: new Date().toISOString() });
      renderOrder(orderId);
    } finally {
      state.starting.delete(orderId);
      if (![...state.active.values()].includes(orderId)) pumpQueue();
      updateToolbar();
    }
  }

  function pumpQueue() {
    if (!state.initialized || state.paused || eligibility() !== "shipped") return;
    while (state.active.size + state.starting.size < MAX_CONCURRENCY && state.queue.length) {
      const orderId = state.queue.shift();
      state.queued.delete(orderId);
      const entry = state.rows.get(orderId);
      if (!entry || claimOutcomeForEntry(entry)) continue;
      startAudit(orderId);
    }
    if (!state.queue.length && !state.starting.size && !state.active.size && !state.workerReleasePending) {
      state.workerReleasePending = true;
      chrome.runtime.sendMessage({ type: "RELEASE_ORDER_AUDIT_WORKER" })
        .catch(() => {})
        .finally(() => { state.workerReleasePending = false; });
    }
  }

  async function saveAudit(orderId, audit) {
    const entry = state.rows.get(orderId);
    if (entry && audit?.order) {
      entry.sellerAccountId = audit.order.sellerAccountId || entry.sellerAccountId;
      entry.sellerAccountName = audit.order.sellerAccountName || entry.sellerAccountName;
      entry.marketplaceId = audit.order.marketplaceId || entry.marketplaceId;
    }
    const key = trackingRecords.recordKey(entryIdentity(entry || { orderId }, audit?.order)) || orderId;
    if (entry) deleteAuditForEntry(entry);
    state.audits[key] = audit;
    const entries = Object.entries(state.audits);
    const deliveredEntries = entries.filter(([, savedAudit]) => listRules.auditIsTerminalDelivered(savedAudit));
    const recentEntries = entries
      .filter(([, savedAudit]) => !listRules.auditIsTerminalDelivered(savedAudit))
      .sort(([, left], [, right]) => new Date(right.checkedAt || 0) - new Date(left.checkedAt || 0))
      .slice(0, 500);
    state.audits = Object.fromEntries([...deliveredEntries, ...recentEntries]);
    await chrome.storage.local.set({ orderAuditResultsByOrder: state.audits });
  }

  function updateToolbar() {
    const toolbar = ensureToolbar();
    const badges = [...document.querySelectorAll(".lpca-order-badge")];
    const count = (wanted) => badges.filter((badge) => badge.dataset.state === wanted).length;
    const checked = badges.filter((badge) => !["queued", "checking"].includes(badge.dataset.state)).length;
    const summary = eligibility() === "shipped"
      ? `${checked}/${state.rows.size} checked · ${count("pickup")} pickup · ${count("returned")} returning · ${count("recommended")} investigate · ${count("sent")} sent · ${state.active.size + state.starting.size} active`
      : `${state.rows.size} orders · claims are checked after shipment`;
    toolbar.querySelector("#lpca-orders-summary").textContent = summary;
    toolbar.querySelector("#lpca-orders-pause").disabled = eligibility() !== "shipped";
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "ORDER_AUDIT_RESULT") return;
    const orderId = state.active.get(message.auditId) || message.orderId;
    if (!orderId) return;
    state.active.delete(message.auditId);
    const recommendation = message.order
      ? rules.recommendClaim(message.order, message.result || {}, state.settings)
      : null;
    saveAudit(orderId, {
      order: message.order || null,
      result: message.result || null,
      recommendation,
      error: message.error || message.result?.error || "",
      checkedAt: new Date().toISOString()
    }).then(() => {
      renderOrder(orderId);
      pumpQueue();
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.claimOutcomesByOrder) state.outcomes = trackingRecords.rekeyRecords(changes.claimOutcomesByOrder.newValue || {});
    if (changes.trackedOrdersByOrder) state.records = trackingRecords.rekeyRecords(changes.trackedOrdersByOrder.newValue || {});
    if (!changes.claimOutcomesByOrder && !changes.trackedOrdersByOrder) return;
    for (const orderId of state.rows.keys()) renderOrder(orderId);
  });

  async function init() {
    const stored = await chrome.storage.local.get(["claimOutcomesByOrder", "orderAuditResultsByOrder", "claimSettings", "trackedOrdersByOrder"]);
    state.outcomes = trackingRecords.rekeyRecords(stored.claimOutcomesByOrder || {});
    state.audits = stored.orderAuditResultsByOrder || {};
    state.settings = stored.claimSettings || {};
    state.records = trackingRecords.rekeyRecords(stored.trackedOrdersByOrder || {});
    discoverRows();
    const remote = await chrome.runtime.sendMessage({ type: "GET_TRACKED_RECORDS", refresh: true, orderIds: [...state.rows.keys()] }).catch(() => null);
    if (remote?.ok) state.records = remote.records || state.records;
    state.queue = [];
    state.queued.clear();
    state.initialized = true;
    discoverRows();
    let timer;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(discoverRows, 180);
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener("pagehide", () => {
    chrome.runtime.sendMessage({ type: "RELEASE_ORDER_AUDIT_WORKER" }).catch(() => {});
  });

  init();
})();
