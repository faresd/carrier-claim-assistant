(function initChronopostClaimAssistant() {
  "use strict";

  if (window.top !== window || document.getElementById("lpca-chronopost-panel")) return;

  const outcomeRules = globalThis.CarrierClaimOutcomeRules;
  const chronopostRules = globalThis.CarrierChronopostRules;

  const state = {
    claim: null,
    working: false,
    clicked: new WeakSet(),
    successReported: false,
    lastProgressAt: Date.now(),
    lastReported: ""
  };
  const normalize = chronopostRules.normalize;

  const escapeHtml = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const visible = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };

  function descriptor(control) {
    const labels = [];
    if (control.labels) labels.push(...[...control.labels].map((label) => label.innerText));
    labels.push(
      control.getAttribute("aria-label") || "",
      control.getAttribute("placeholder") || "",
      control.name || "",
      control.id || "",
      control.closest("label,p,fieldset,tr,.form-group")?.innerText?.slice(0, 220) || ""
    );
    return normalize(labels.join(" "));
  }

  function setValue(control, value) {
    if (!control || !value || control.disabled || !visible(control)) return false;
    if (control.value && control.dataset.lpcaFilled !== "true") return false;
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(control, String(value));
    else control.value = String(value);
    control.dataset.lpcaFilled = "true";
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function clearExtensionValue(control) {
    if (!control || control.dataset.lpcaFilled !== "true") return;
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(control, "");
    else control.value = "";
    delete control.dataset.lpcaFilled;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function mappedValue(description) {
    const { order, sender, details } = state.claim;
    const recipient = String(order.recipientName || "").split(/\s+/);
    const rules = [
      [["numero d'envoi", "numero de colis", "tracking"], order.trackingNumber],
      [["email", "courriel"], sender.email],
      [["telephone", "mobile"], sender.phone],
      [["prenom expediteur", "votre prenom"], sender.contactFirstName],
      [["nom expediteur", "votre nom"], sender.contactLastName],
      [["societe", "raison sociale"], sender.companyName],
      [["adresse expediteur", "votre adresse"], sender.address1],
      [["code postal expediteur", "votre code postal"], sender.postalCode],
      [["ville expediteur", "votre ville"], sender.city],
      [["prenom destinataire"], recipient[0]],
      [["nom destinataire"], recipient.slice(1).join(" ")],
      [["adresse destinataire"], order.recipientAddress1],
      [["code postal destinataire"], order.recipientPostalCode],
      [["ville destinataire"], order.recipientCity],
      [["montant", "valeur marchandise", "indemnisation"], String(order.itemValue || "").replace(/[^\d.,]/g, "")],
      [["contenu de l'envoi", "contenu colis"], order.productName || `Commande Amazon ${order.orderId}`],
      [["message", "description", "commentaire", "motif", "detail"], details]
    ];
    return rules.find(([needles]) => needles.some((needle) => description.includes(normalize(needle))))?.[1] || "";
  }

  function chooseOption(select, wantedValue) {
    if (!select || !wantedValue || !visible(select) || select.value === wantedValue) return false;
    const option = [...select.options].find((item) => item.value === wantedValue);
    if (!option) return false;
    select.value = wantedValue;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function chooseKnownTicketFields() {
    let count = 0;
    if (chooseOption(document.querySelector("#object"), chronopostRules.objectForReason(state.claim.reason))) count += 1;

    const motive = document.querySelector("#motive");
    if (motive && visible(motive) && !motive.value) {
      const value = chronopostRules.matchingOptionValue(motive.options, chronopostRules.motiveTermsForReason(state.claim.reason));
      if (value && chooseOption(motive, value)) count += 1;
    }

    if (chooseOption(document.querySelector("#product-family"), chronopostRules.productFamily(state.claim.order.productName))) count += 1;
    const continueTicket = document.querySelector("#has-replied-2");
    if (continueTicket && visible(continueTicket) && !continueTicket.checked) {
      continueTicket.click();
      count += 1;
    }
    return count;
  }

  function fillVisibleFields() {
    let count = 0;
    for (const control of document.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]),textarea')) {
      if (control.id === "sender" || control.id === "package-number") continue;
      if (setValue(control, mappedValue(descriptor(control)))) count += 1;
    }
    for (const select of document.querySelectorAll("select")) {
      if (select.value || !visible(select)) continue;
      const text = descriptor(select);
      const terms = chronopostRules.motiveTermsForReason(state.claim.reason);
      if (!/motif|nature|raison/.test(text)) continue;
      const option = [...select.options].find((item) => terms.some((term) => normalize(item.textContent).includes(term)));
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        count += 1;
      }
    }
    count += chooseKnownTicketFields();
    return count;
  }

  function finalButton() {
    return [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a[role="button"]')]
      .filter(visible)
      .filter((node) => !node.disabled && node.getAttribute("aria-disabled") !== "true")
      .find((node) => /envoyer|soumettre|creer (?:la demande|le ticket)|valider la demande/.test(normalize(node.innerText || node.value)));
  }

  function updatePanel(message) {
    const status = document.querySelector("#lpca-status");
    if (status) status.textContent = message;
    const submit = document.querySelector("#lpca-submit");
    if (submit) submit.disabled = !finalButton();
  }

  function clickOnce(node) {
    if (!node || !visible(node) || state.clicked.has(node)) return false;
    state.clicked.add(node);
    node.click();
    return true;
  }

  function intermediateButton() {
    return [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a[role="button"]')]
      .filter(visible)
      .find((node) => /^(enregistrer|continuer|suivant)$/.test(normalize(node.innerText || node.value)));
  }

  function accessProblem() {
    const page = normalize(document.body.innerText);
    if (/authentification n'est pas valide|authentication is not valid/.test(page)) {
      return "Sign in to the contracted Chronopost account, then reopen the claim from Amazon.";
    }
    if (/version de votre navigateur web n'est pas supportee|unsupported browser/.test(page)) {
      return "Chronopost redirected to its legacy browser error page. Reopen the claim after signing in at chronopost.fr.";
    }
    if (/une erreur technique est survenue/.test(page)) {
      return "Chronopost reported a temporary Service Client error. Try the official workflow again shortly.";
    }
    return "";
  }

  function reportWorkflowState(status, message) {
    if (!state.claim) return;
    const signature = `${status}|${message}`;
    if (signature === state.lastReported) return;
    state.lastReported = signature;
    chrome.runtime.sendMessage({
      type: "CLAIM_WORKFLOW_STATE",
      carrier: "chronopost",
      claimId: state.claim.id,
      status,
      message
    });
  }

  async function finishSuccessfulSubmission() {
    if (!state.claim?.submissionStartedAt) return false;
    const success = outcomeRules.detectClaimSuccess("chronopost", document.body.innerText);
    if (!success) return false;
    if (state.successReported) return true;
    const response = await chrome.runtime.sendMessage({
      type: "CLAIM_SUBMISSION_SUCCESS",
      carrier: "chronopost",
      claimId: state.claim.id,
      reference: success.reference,
      confirmationText: success.confirmationText
    });
    if (!response?.ok) {
      updatePanel(`Chronopost confirmed submission, but Amazon could not be updated: ${response?.error || "Unknown error"}`);
      return false;
    }
    state.successReported = true;
    updatePanel(success.reference ? `Claim sent · Reference ${success.reference}` : "Claim sent successfully.");
    return true;
  }

  function prefillStep() {
    const problem = accessProblem();
    if (problem) {
      updatePanel(problem);
      reportWorkflowState("needs_attention", problem);
      return;
    }

    const tracking = document.querySelector("#package-number") ||
      [...document.querySelectorAll("input")].find((input) => descriptor(input).includes("numero d'envoi"));
    if (tracking && visible(tracking) && sessionStorage.getItem("lpcaChronopostAdded") !== state.claim.id) {
      setValue(tracking, state.claim.order.trackingNumber);
      clearExtensionValue(document.querySelector("#sender"));
      const add = [...document.querySelectorAll('button,input[type="button"],input[type="submit"]')]
        .find((node) => visible(node) && normalize(node.innerText || node.value) === "ajouter");
      if (tracking.value === state.claim.order.trackingNumber && add) {
        sessionStorage.setItem("lpcaChronopostAdded", state.claim.id);
        clickOnce(add);
        state.lastProgressAt = Date.now();
        updatePanel("Shipment found; preparing the Chronopost ticket fields…");
        reportWorkflowState("preparing", "Chronopost is looking up the shipment in the contracted account.");
        return;
      }
    }

    const count = fillVisibleFields();
    const final = finalButton();
    if (final) {
      updatePanel("Ready to submit through Chronopost's signed-in ticket endpoint. Review and confirm.");
      reportWorkflowState("ready", "Review and confirm the Chronopost ticket submission.");
      return;
    }
    const next = intermediateButton();
    if (next && clickOnce(next)) {
      state.lastProgressAt = Date.now();
      updatePanel("Continuing automatically through the Chronopost ticket…");
      reportWorkflowState("preparing", "Chronopost claim is being prepared in the background.");
      return;
    }
    updatePanel(count ? `Filled ${count} field(s); waiting for the next Chronopost step.` : "Waiting for a required Chronopost choice.");
    if (count) {
      state.lastProgressAt = Date.now();
      reportWorkflowState("preparing", "Chronopost claim is being prepared in the background.");
    } else if (Date.now() - state.lastProgressAt > 5000) {
      reportWorkflowState("needs_attention", "Chronopost requires one unresolved choice before continuing.");
    }
  }

  async function advance() {
    if (!state.claim || state.working) return;
    state.working = true;
    try {
      if (await finishSuccessfulSubmission()) return;
      prefillStep();
    } finally {
      state.working = false;
    }
  }

  function renderPanel() {
    const { order, sender, reason } = state.claim;
    const panel = document.createElement("aside");
    panel.id = "lpca-chronopost-panel";
    panel.className = "lpca-panel";
    panel.innerHTML = `
      <div class="lpca-panel__header">
        <div><small>Carrier Claim Assistant</small><strong>${escapeHtml(order.trackingNumber)}</strong></div>
        <div class="lpca-panel__header-actions">
          <button id="lpca-collapse" class="lpca-icon-button" type="button" aria-label="Collapse claim assistant" title="Collapse claim assistant">▾</button>
        </div>
      </div>
      <dl>
        <div><dt>Carrier</dt><dd>Chronopost</dd></div>
        <div><dt>Order</dt><dd>${escapeHtml(order.orderId)}</dd></div>
        <div><dt>Reason</dt><dd>${escapeHtml(reason.replaceAll("_", " "))}</dd></div>
        <div><dt>Sender</dt><dd>${escapeHtml(sender.companyName || sender.contactLastName)}</dd></div>
      </dl>
      <p id="lpca-status" class="lpca-status">Preparing Chronopost ticket…</p>
      <div class="lpca-stack">
        <button id="lpca-fill" class="lpca-button lpca-button--secondary">Prefill this step</button>
        <button id="lpca-submit" class="lpca-button" disabled>Confirm and submit to Chronopost</button>
        <button id="lpca-clear" class="lpca-link-button">Clear pending claim</button>
      </div>`;
    document.body.append(panel);

    const setCollapsed = (collapsed) => {
      panel.classList.toggle("lpca-panel--collapsed", collapsed);
      const button = panel.querySelector("#lpca-collapse");
      button.textContent = collapsed ? "▴" : "▾";
      button.setAttribute("aria-label", collapsed ? "Expand claim assistant" : "Collapse claim assistant");
      button.title = collapsed ? "Expand claim assistant" : "Collapse claim assistant";
      sessionStorage.setItem("lpcaChronopostPanelCollapsed", collapsed ? "true" : "false");
    };
    setCollapsed(sessionStorage.getItem("lpcaChronopostPanelCollapsed") === "true");
    panel.querySelector("#lpca-collapse").addEventListener("click", () => {
      setCollapsed(!panel.classList.contains("lpca-panel--collapsed"));
    });

    panel.querySelector("#lpca-fill").addEventListener("click", advance);
    panel.querySelector("#lpca-submit").addEventListener("click", async () => {
      const target = finalButton();
      if (!target) return window.alert("The final Chronopost submission step is not visible yet.");
      const ok = window.confirm(
        `Submit this Chronopost claim now?\n\nTracking: ${order.trackingNumber}\nOrder: ${order.orderId}\nEmail: ${sender.email}\nReason: ${reason.replaceAll("_", " ")}\n\nThis sends the claim and personal/order details to Chronopost.`
      );
      if (!ok) return;
      state.claim = { ...state.claim, submissionStartedAt: new Date().toISOString() };
      const updated = await chrome.runtime.sendMessage({
        type: "UPDATE_PENDING_CLAIM",
        carrier: "chronopost",
        claim: state.claim
      });
      if (!updated?.ok) {
        window.alert(`The claim could not be armed for confirmation tracking: ${updated?.error || "Unknown error"}`);
        return;
      }
      updatePanel("Submission sent; waiting for Chronopost's confirmation…");
      target.click();
    });
    panel.querySelector("#lpca-clear").addEventListener("click", async () => {
      if (!window.confirm("Clear the pending Chronopost claim from this browser session?")) return;
      await chrome.runtime.sendMessage({ type: "CLEAR_PENDING_CLAIM", carrier: "chronopost" });
      panel.remove();
    });
  }

  chrome.runtime.sendMessage({ type: "GET_PENDING_CLAIM", carrier: "chronopost" }).then((response) => {
    const pendingChronopostClaim = response?.claim;
    if (!pendingChronopostClaim) return;
    state.claim = pendingChronopostClaim;
    renderPanel();
    advance();
    let timer;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        advance();
      }, 300);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(advance, 750);
  });
})();
