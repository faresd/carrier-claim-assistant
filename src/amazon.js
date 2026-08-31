(function initAmazonCarrierAssistant() {
  "use strict";

  if (window.top !== window || location.hash.includes("carrier-claim-order-audit=") || document.getElementById("lpca-amazon-launch")) return;

  const parser = globalThis.LaPosteOrderParser;
  const rules = globalThis.CarrierClaimRules;
  const outcomeRules = globalThis.CarrierClaimOutcomeRules;
  let order = parser.parseOrderDetails(document.body.innerText, location.href);
  let carrier = rules.detectCarrier(order);
  const state = { result: null, recommendation: null, checkedAt: "", checking: false, requestId: null, outcome: null, noteAttempts: 0 };
  let noteRetryTimer;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function element(tag, attributes = {}) {
    const node = document.createElement(tag);
    Object.entries(attributes).forEach(([key, value]) => {
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    });
    return node;
  }

  function setLaunchState(kind, text) {
    launchButton.dataset.state = kind;
    launchButton.textContent = text;
    launchButton.disabled = kind !== "sent" && (!order.trackingNumber || !carrier.supported);
  }

  function sellerNotesControl() {
    const controls = [...document.querySelectorAll('textarea,input:not([type="hidden"]),[contenteditable="true"]')]
      .filter((control) => !control.closest("#lpca-claim-dialog"));
    return controls.find((control) => {
      const description = rules.normalize([
        control.getAttribute("placeholder"),
        control.getAttribute("aria-label"),
        control.name,
        control.id,
        control.closest("label,section,div")?.innerText?.slice(0, 180)
      ].filter(Boolean).join(" "));
      return /seller notes|notes vendeur|records only|pour vos archives|ne sera pas affiche/.test(description);
    }) || null;
  }

  function controlText(control) {
    return "value" in control ? String(control.value || "") : String(control.textContent || "");
  }

  function setControlText(control, value) {
    control.focus();
    if ("value" in control) {
      const prototype = control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(control, value);
      else control.value = value;
    } else {
      control.textContent = value;
    }
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.blur();
  }

  async function markSellerNoteSaved(outcome) {
    const stored = await chrome.storage.local.get("claimOutcomesByOrder");
    const outcomes = { ...(stored.claimOutcomesByOrder || {}) };
    const saved = outcomes[outcome.orderId];
    if (!saved || saved.id !== outcome.id) return;
    outcomes[outcome.orderId] = { ...saved, noteSaved: true };
    state.outcome = outcomes[outcome.orderId];
    await chrome.storage.local.set({ claimOutcomesByOrder: outcomes });
  }

  async function appendOutcomeToSellerNotes(outcome) {
    if (outcome.noteSaved) return true;
    const control = sellerNotesControl();
    if (!control) return false;
    const existing = controlText(control);
    const maximumLength = Number(control.maxLength) > 0 ? Number(control.maxLength) : 4000;
    const next = outcomeRules.appendSellerNote(existing, outcome.sellerNote, maximumLength);
    if (next !== existing) setControlText(control, next);
    await new Promise((resolve) => setTimeout(resolve, 650));
    const saved = controlText(control) === next && next.includes(outcome.sellerNote);
    if (saved) await markSellerNoteSaved(outcome);
    return saved;
  }

  async function applyClaimOutcome(outcome) {
    if (!outcome || outcome.orderId !== order.orderId || outcome.trackingNumber !== order.trackingNumber) {
      return { ok: false, noteSaved: false, error: "The submitted claim belongs to a different Amazon order." };
    }
    state.outcome = outcome;
    setLaunchState("sent", outcome.reference ? `Claim sent · ${outcome.reference}` : `Claim sent · ${carrier.label}`);
    const noteSaved = await appendOutcomeToSellerNotes(outcome);
    if (!noteSaved && state.noteAttempts < 20) {
      state.noteAttempts += 1;
      clearTimeout(noteRetryTimer);
      noteRetryTimer = setTimeout(() => applyClaimOutcome(state.outcome), 750);
    }
    return { ok: true, noteSaved };
  }

  async function storedOutcomeForOrder() {
    if (!order.orderId) return null;
    const stored = await chrome.storage.local.get("claimOutcomesByOrder");
    const outcome = stored.claimOutcomesByOrder?.[order.orderId] || null;
    return outcome?.trackingNumber === order.trackingNumber ? outcome : null;
  }

  async function recordExistingClaim(reference, reason) {
    const normalizedReference = String(reference || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9][A-Z0-9./_-]{4,39}$/.test(normalizedReference)) {
      window.alert("Enter the reference exactly as shown on the carrier confirmation (for example, COL-91855121).");
      return false;
    }
    const confirmed = window.confirm(
      `Record this existing ${carrier.label} claim?\n\nReference: ${normalizedReference}\nTracking: ${order.trackingNumber}\nOrder: ${order.orderId}\n\nThis saves the claim state in the extension and adds it to Seller Notes when that field is available.`
    );
    if (!confirmed) return false;

    const outcome = {
      id: crypto.randomUUID(),
      carrier: carrier.id,
      orderId: order.orderId,
      trackingNumber: order.trackingNumber,
      reason: reason || state.recommendation?.reason || "other",
      reference: normalizedReference,
      confirmationText: "Existing carrier claim recorded from its confirmation reference.",
      submittedAt: new Date().toISOString(),
      noteSaved: false
    };
    outcome.sellerNote = outcomeRules.buildSellerNote(outcome);
    const stored = await chrome.storage.local.get("claimOutcomesByOrder");
    const outcomes = { ...(stored.claimOutcomesByOrder || {}), [order.orderId]: outcome };
    await chrome.storage.local.set({ claimOutcomesByOrder: outcomes });
    await chrome.runtime.sendMessage({
      type: "REGISTER_TRACKED_ORDER",
      order,
      result: state.result || {},
      recommendation: state.recommendation || null,
      outcome
    }).catch(() => {});
    await applyClaimOutcome(outcome);
    return true;
  }

  function trimAuditCache(audits) {
    const entries = Object.entries(audits || {});
    const deliveredEntries = entries.filter(([, audit]) => rules.isTerminalDeliveredRecommendation(audit?.recommendation));
    const recentEntries = entries
      .filter(([, audit]) => !rules.isTerminalDeliveredRecommendation(audit?.recommendation))
      .sort(([, left], [, right]) => new Date(right.checkedAt || 0) - new Date(left.checkedAt || 0))
      .slice(0, 500);
    return Object.fromEntries([...deliveredEntries, ...recentEntries]);
  }

  async function storedDeliveredAuditForOrder() {
    if (!order.orderId || !order.trackingNumber) return null;
    const stored = await chrome.storage.local.get("orderAuditResultsByOrder");
    const audit = stored.orderAuditResultsByOrder?.[order.orderId] || null;
    if (audit?.order?.trackingNumber !== order.trackingNumber) return null;
    const auditedCarrierId = audit?.result?.carrier || audit?.recommendation?.carrier?.id || "";
    if (auditedCarrierId && auditedCarrierId !== carrier.id) return null;
    return rules.isTerminalDeliveredRecommendation(audit.recommendation) ? audit : null;
  }

  async function saveAuditForOrder(result, recommendation, error = "") {
    if (!order.orderId || !order.trackingNumber) return;
    const stored = await chrome.storage.local.get("orderAuditResultsByOrder");
    const audits = { ...(stored.orderAuditResultsByOrder || {}) };
    const checkedAt = result?.checkedAt || new Date().toISOString();
    audits[order.orderId] = {
      order: { ...order },
      result: result || null,
      recommendation: recommendation || null,
      error: error || result?.error || "",
      checkedAt
    };
    state.checkedAt = checkedAt;
    await chrome.storage.local.set({ orderAuditResultsByOrder: trimAuditCache(audits) });
  }

  async function removeSavedAuditForOrder() {
    if (!order.orderId) return;
    const stored = await chrome.storage.local.get("orderAuditResultsByOrder");
    const audits = { ...(stored.orderAuditResultsByOrder || {}) };
    delete audits[order.orderId];
    await chrome.storage.local.set({ orderAuditResultsByOrder: audits });
    state.checkedAt = "";
  }

  async function settings() {
    const stored = await chrome.storage.local.get(["senderProfile", "claimSettings"]);
    return {
      senderProfile: stored.senderProfile || {},
      claimSettings: stored.claimSettings || { autoStatusCheck: true, chronopostStaleHours: 48, laposteOverdueDays: 7 }
    };
  }

  async function checkStatus() {
    if (state.checking || !carrier.supported || !order.trackingNumber) return;
    state.checking = true;
    setLaunchState("checking", `Checking ${carrier.label}…`);
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "CHECK_CARRIER_STATUS",
        carrier: carrier.id,
        order
      });
    } catch (error) {
      response = { ok: false, error: error.message };
    }
    if (!response?.ok) {
      state.checking = false;
      state.result = { error: response?.error || "Status check could not start.", checkedAt: new Date().toISOString() };
      const { claimSettings } = await settings();
      state.recommendation = rules.recommendClaim(order, state.result, claimSettings);
      setLaunchState("warning", "Status check needs review");
      saveAuditForOrder(state.result, state.recommendation, state.result.error).catch(() => {});
      return;
    }
    state.requestId = response.requestId;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CLAIM_SUBMISSION_SUCCESS") {
      applyClaimOutcome(message.outcome)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, noteSaved: false, error: error.message }));
      return true;
    }
    if (message?.type === "CLAIM_WORKFLOW_STATE" && message.carrier === carrier.id) {
      if (state.outcome) return false;
      const labels = {
        preparing: `Preparing ${carrier.label} claim…`,
        captcha: `${carrier.label} CAPTCHA required`,
        ready: `${carrier.label} claim ready to confirm`,
        needs_attention: `${carrier.label} needs one choice`,
        error: `${carrier.label} claim needs review`
      };
      setLaunchState(
        ["captcha", "ready"].includes(message.status) ? "recommended" : message.status === "error" ? "warning" : "checking",
        labels[message.status] || message.message || `${carrier.label} workflow updated`
      );
      return;
    }
    if (message?.type !== "CARRIER_STATUS_RESULT" || message.requestId !== state.requestId) return;
    if (state.outcome) return;
    state.checking = false;
    state.result = message.result;
    settings().then(({ claimSettings }) => {
      state.recommendation = rules.recommendClaim(order, state.result, claimSettings);
      const label = state.recommendation.recommended
        ? `Claim recommended · ${carrier.label}`
        : `${state.recommendation.title} · View`;
      setLaunchState(state.recommendation.recommended ? "recommended" : state.recommendation.severity, label);
      saveAuditForOrder(state.result, state.recommendation, message.result?.error || "").catch(() => {});
    });
  });

  function summaryRows() {
    const recommendation = state.recommendation || {
      title: state.checking ? "Checking official tracking…" : "Status not checked",
      explanation: "Open this panel to run the carrier check.",
      statusText: ""
    };
    const checkedAt = state.checkedAt ? new Date(state.checkedAt).toLocaleString("fr-FR") : "";
    return [
      ["Carrier", carrier.label],
      ["Tracking", order.trackingNumber],
      ["Order", order.orderId],
      ["Ship date", order.shipDate],
      ["Deliver by", order.deliverBy],
      ["Recipient", `${order.recipientName} · ${order.recipientCountry}`],
      ["Order value", order.itemValue],
      ["Carrier status", recommendation.statusText || state.result?.statusText || "Waiting for check"],
      ["Last checked", checkedAt]
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value || "Not found")}</strong></div>`)
      .join("");
  }

  async function openClaim(preview = {}) {
    const { senderProfile } = await settings();
    const missing = [
      ["email", senderProfile.email],
      ["sender name", senderProfile.contactFirstName || senderProfile.companyName],
      ["phone", senderProfile.phone],
      ["address", senderProfile.address1],
      ["postal code", senderProfile.postalCode],
      ["city", senderProfile.city]
    ].filter(([, value]) => !value).map(([label]) => label);

    if (missing.length) {
      if (window.confirm(`Complete sender settings first: ${missing.join(", ")}.\n\nOpen settings now?`)) {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      }
      return;
    }

    const recommendation = state.recommendation || rules.recommendClaim(order, state.result || {});
    const selectedReason = preview.reason || (recommendation.reason === "none" ? "other" : recommendation.reason);
    const editedRecommendation = { ...recommendation, reason: selectedReason };
    const editedDetails = String(preview.details || rules.buildClaimMessage(order, editedRecommendation)).trim().slice(0, 500);
    if (!editedDetails) {
      window.alert("Enter a complaint message before continuing.");
      return;
    }
    const recipientTitle = String(preview.recipientTitle || rules.detectRecipientTitle(order.recipientName) || "").trim();
    if (carrier.id === "laposte" && !recipientTitle) {
      window.alert("Choose the recipient title required by the La Poste form before continuing.");
      return;
    }
    const recipientCountry = String(preview.recipientCountry || order.recipientCountry || "").trim();
    if (!recipientCountry) {
      window.alert("Confirm the recipient country before continuing.");
      return;
    }
    const claim = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      carrier: carrier.id,
      reason: selectedReason,
      reasonContract: rules.carrierReasonContract(carrier.id, selectedReason),
      details: editedDetails,
      recommendation: editedRecommendation,
      trackingStatus: state.result,
      order: { ...order, recipientCountry },
      sender: senderProfile,
      recipientTitle,
      executionMode: "automatic"
    };
    const response = await chrome.runtime.sendMessage({ type: "OPEN_CARRIER_CLAIM", claim });
    if (!response?.ok) window.alert(`Could not open the ${carrier.label} claim workflow: ${response?.error || "Unknown error"}`);
    else {
      setLaunchState("checking", `Preparing ${carrier.label} claim…`);
      document.getElementById("lpca-claim-dialog")?.close();
    }
  }

  function showPanel() {
    document.getElementById("lpca-claim-dialog")?.remove();
    const recommendation = state.recommendation || {
      recommended: false,
      severity: "info",
      title: state.checking ? "Checking official tracking…" : "Status not checked",
      explanation: "Run the official carrier status check before creating a claim."
    };
    const detectedReason = recommendation.reason === "none" || !recommendation.reason ? "other" : recommendation.reason;
    const detectedRecipientTitle = rules.detectRecipientTitle(order.recipientName);
    const detectedRecipientCountry = carrier.id === "laposte"
      ? rules.laPosteCountryLabel(order.recipientCountry)
      : order.recipientCountry;
    const destinationLines = parser.destinationLines(order, detectedRecipientCountry);
    const destinationPreview = destinationLines.length ? `
      <section id="lpca-destination-preview" class="lpca-destination-preview" aria-label="Destination details">
        <small>Destination details</small>
        <strong>${escapeHtml(destinationLines[0])}</strong>
        ${destinationLines.slice(1).map((line) => `<span>${escapeHtml(line)}</span>`).join("")}
      </section>` : "";
    const previewMessage = rules.buildClaimMessage(order, { ...recommendation, reason: detectedReason });
    const dialog = element("dialog", { id: "lpca-claim-dialog", className: "lpca-dialog" });
    const actionLabel = recommendation.recommended ? `Start automated ${carrier.label} claim` : "Start claim anyway";
    const recipientTitleField = carrier.id === "laposte" ? `
          <label>Recipient title <small>(required by La Poste)</small>
            <select id="lpca-recipient-title-preview" aria-describedby="lpca-destination-preview" required>
              <option value="">Choose…</option>
              <option value="Madame"${detectedRecipientTitle === "Madame" ? " selected" : ""}>Madame</option>
              <option value="Monsieur"${detectedRecipientTitle === "Monsieur" ? " selected" : ""}>Monsieur</option>
            </select>
          </label>
          <label>Recipient country <small>(detected — editable)</small>
            <input id="lpca-recipient-country-preview" value="${escapeHtml(detectedRecipientCountry)}" autocomplete="off">
          </label>` : "";
    dialog.innerHTML = `
      <form method="dialog">
        <div class="lpca-dialog__header">
          <div><small>Carrier Claim Assistant</small><h2>${escapeHtml(recommendation.title)}</h2></div>
          <button type="button" id="lpca-dialog-close-icon" class="lpca-icon-button" aria-label="Close">×</button>
        </div>
        <p class="lpca-recommendation lpca-recommendation--${escapeHtml(recommendation.severity)}">${escapeHtml(recommendation.explanation)}</p>
        <div class="lpca-order-summary">${summaryRows()}</div>
        ${destinationPreview}
        <div class="lpca-preview-fields">
          <label>Complaint reason
            <select id="lpca-reason-preview">
              <option value="delivered_missing"${detectedReason === "delivered_missing" ? " selected" : ""}>Marked delivered but not received</option>
              <option value="delayed"${detectedReason === "delayed" ? " selected" : ""}>Delayed / not delivered</option>
              <option value="lost"${detectedReason === "lost" ? " selected" : ""}>Lost / unlocated</option>
              <option value="damaged"${detectedReason === "damaged" ? " selected" : ""}>Damaged</option>
              <option value="returned"${detectedReason === "returned" ? " selected" : ""}>Returned to sender</option>
              <option value="contents_missing"${detectedReason === "contents_missing" ? " selected" : ""}>Contents missing</option>
              <option value="other"${detectedReason === "other" ? " selected" : ""}>Other</option>
            </select>
          </label>
          ${recipientTitleField}
          <label>Editable complaint preview
            <textarea id="lpca-message-preview" maxlength="500" rows="7">${escapeHtml(previewMessage)}</textarea>
          </label>
          <small id="lpca-message-count" class="lpca-character-count">${previewMessage.length}/500</small>
          <label>Existing claim reference <small>(already submitted)</small>
            <input id="lpca-existing-claim-reference" placeholder="COL-91855121" autocomplete="off">
          </label>
        </div>
        <p class="lpca-notice">Status is read from the official ${escapeHtml(carrier.label)} tracking page. The extension advances the official carrier session automatically, then pauses for CAPTCHA (if requested) and explicit final confirmation.</p>
        <div class="lpca-actions">
          <button type="button" id="lpca-recheck" class="lpca-button lpca-button--secondary">Check again</button>
          <button type="button" id="lpca-record-existing" class="lpca-button lpca-button--secondary">Record existing claim</button>
          <button type="button" id="lpca-dialog-close" class="lpca-button lpca-button--secondary">Close</button>
          <button type="button" id="lpca-open-claim" class="lpca-button">${escapeHtml(actionLabel)}</button>
        </div>
      </form>`;
    document.body.append(dialog);
    const reasonPreview = dialog.querySelector("#lpca-reason-preview");
    const messagePreview = dialog.querySelector("#lpca-message-preview");
    const recipientTitlePreview = dialog.querySelector("#lpca-recipient-title-preview");
    const recipientCountryPreview = dialog.querySelector("#lpca-recipient-country-preview");
    const existingClaimReference = dialog.querySelector("#lpca-existing-claim-reference");
    const messageCount = dialog.querySelector("#lpca-message-count");
    const closeDialog = (event) => {
      event?.preventDefault();
      event?.stopPropagation();
      if (dialog.open) dialog.close();
    };
    dialog.querySelector("#lpca-dialog-close-icon").addEventListener("click", closeDialog);
    dialog.querySelector("#lpca-dialog-close").addEventListener("click", closeDialog);
    dialog.addEventListener("cancel", closeDialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    const updateCount = () => {
      messageCount.textContent = `${messagePreview.value.length}/500`;
    };
    messagePreview.addEventListener("input", updateCount);
    reasonPreview.addEventListener("change", () => {
      messagePreview.value = rules.buildClaimMessage(order, { ...recommendation, reason: reasonPreview.value });
      updateCount();
    });
    dialog.querySelector("#lpca-recheck").addEventListener("click", async () => {
      dialog.close();
      await removeSavedAuditForOrder().catch(() => {});
      state.result = null;
      state.recommendation = null;
      state.requestId = null;
      checkStatus();
    });
    dialog.querySelector("#lpca-record-existing").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const recorded = await recordExistingClaim(existingClaimReference.value, reasonPreview.value);
        if (recorded && dialog.open) dialog.close();
      } finally {
        button.disabled = false;
      }
    });
    dialog.querySelector("#lpca-open-claim").addEventListener("click", () => openClaim({
      reason: reasonPreview.value,
      details: messagePreview.value,
      recipientTitle: recipientTitlePreview?.value || "",
      recipientCountry: recipientCountryPreview?.value || order.recipientCountry
    }));
    dialog.showModal();
  }

  const launchButton = element("button", {
    id: "lpca-amazon-launch",
    className: "lpca-floating-button",
    type: "button",
    text: "Reading shipment details…"
  });
  launchButton.disabled = true;
  launchButton.addEventListener("click", () => {
    if (state.outcome) {
      const reference = state.outcome.reference ? `\nReference: ${state.outcome.reference}` : "";
      window.alert(`Claim sent to ${carrier.label}.${reference}\nTracking: ${state.outcome.trackingNumber}`);
      return;
    }
    if (!state.result && !state.recommendation && !state.checking) checkStatus();
    showPanel();
  });
  document.body.append(launchButton);

  async function startAutomaticCheck() {
    const { claimSettings } = await settings();
    if (claimSettings.autoStatusCheck !== false) checkStatus();
  }

  let lastOrderSignature = "";
  let lastShipmentIdentity = "";
  let refreshTimer;
  let observedUrl = location.href;

  function pageOrderId() {
    return location.pathname.match(/\/orders-v3\/order\/([0-9-]+)/i)?.[1] || "";
  }

  function orderSignature(value) {
    return [
      location.pathname,
      value.orderId,
      value.trackingNumber,
      value.carrier,
      value.shippingService,
      value.shipDate,
      value.deliverBy,
      value.itemValue,
      value.recipientName,
      value.recipientAddress1,
      value.recipientAddress2,
      value.recipientCity,
      value.recipientPostalCode,
      value.recipientCountry,
      value.productName
    ].join("|");
  }

  function shipmentIdentity(value, detectedCarrier) {
    return [
      location.pathname,
      value.orderId,
      value.trackingNumber,
      detectedCarrier.id
    ].join("|");
  }

  async function refreshOrderFromPage() {
    const nextOrder = parser.enrichSellerContext(parser.parseOrderDetails(document.body.innerText, location.href), document, location.href);
    const signature = orderSignature(nextOrder);
    if (signature === lastOrderSignature) return;
    lastOrderSignature = signature;
    const nextCarrier = rules.detectCarrier(nextOrder);
    const nextShipmentIdentity = shipmentIdentity(nextOrder, nextCarrier);
    const shipmentChanged = nextShipmentIdentity !== lastShipmentIdentity;
    lastShipmentIdentity = nextShipmentIdentity;
    order = nextOrder;
    carrier = nextCarrier;

    const expectedOrderId = pageOrderId();
    const ready = Boolean(order.trackingNumber) && (!expectedOrderId || order.orderId === expectedOrderId);
    if (!ready) {
      launchButton.dataset.state = "waiting";
      launchButton.disabled = true;
      launchButton.textContent = order.orderId && expectedOrderId && order.orderId !== expectedOrderId
        ? "Waiting for the new order details…"
        : "Waiting for shipment details…";
      return;
    }

    if (!carrier.supported) {
      setLaunchState("warning", `Unsupported carrier: ${carrier.label}`);
      return;
    }

    chrome.runtime.sendMessage({
      type: "REGISTER_TRACKED_ORDER",
      order,
      result: state.result || {},
      recommendation: state.recommendation || null,
      outcome: state.outcome || null
    }).catch(() => {});

    if (!shipmentChanged) return;

    state.result = null;
    state.recommendation = null;
    state.checkedAt = "";
    state.checking = false;
    state.requestId = null;
    state.outcome = null;
    state.noteAttempts = 0;

    const savedOutcome = await storedOutcomeForOrder();
    if (savedOutcome) {
      await applyClaimOutcome(savedOutcome);
      return;
    }

    const deliveredAudit = await storedDeliveredAuditForOrder();
    if (deliveredAudit) {
      state.result = deliveredAudit.result || null;
      state.recommendation = deliveredAudit.recommendation;
      state.checkedAt = deliveredAudit.checkedAt || deliveredAudit.result?.checkedAt || "";
      setLaunchState("info", `${state.recommendation.title} · View`);
      return;
    }

    setLaunchState("ready", `Check ${carrier.label} status`);
    startAutomaticCheck();
  }

  function scheduleOrderRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshOrderFromPage, 120);
  }

  refreshOrderFromPage();
  new MutationObserver(scheduleOrderRefresh)
    .observe(document.body, { childList: true, subtree: true, characterData: true });

  setInterval(() => {
    if (location.href === observedUrl) return;
    observedUrl = location.href;
    lastOrderSignature = "";
    lastShipmentIdentity = "";
    scheduleOrderRefresh();
  }, 750);

  setTimeout(() => {
    if (!order.trackingNumber) launchButton.textContent = "Tracking number not detected — waiting for updates";
  }, 20500);
})();
