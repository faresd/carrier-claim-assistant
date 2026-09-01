(function initLaPosteAssistant() {
  "use strict";

  if (window.top !== window || document.getElementById("lpca-laposte-panel")) return;

  const sharedRules = globalThis.CarrierClaimRules;
  const outcomeRules = globalThis.CarrierClaimOutcomeRules;

  const FINAL_LABELS = [
    "envoyer ma demande",
    "envoyer la demande",
    "soumettre ma demande",
    "déposer ma réclamation",
    "confirmer l'envoi",
    "envoyer"
  ];
  const state = {
    claim: null,
    working: false,
    paused: false,
    clicked: new WeakSet(),
    finalReady: false,
    successReported: false,
    lastProgressAt: Date.now(),
    lastReported: ""
  };

  const normalize = (value) =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

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

  function setControlValue(control, value) {
    if (!control || value == null || value === "" || !visible(control)) return false;
    if (control.dataset.lpcaFilled === "true" && control.value === String(value)) return false;
    if (control.value && control.dataset.lpcaFilled !== "true") return false;

    const prototype = control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(control, String(value));
    else control.value = String(value);
    control.dataset.lpcaFilled = "true";
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function descriptor(control) {
    const labels = [];
    if (control.labels) labels.push(...[...control.labels].map((label) => label.innerText));
    const labelledBy = control.getAttribute("aria-labelledby");
    if (labelledBy) {
      labels.push(
        ...labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || "")
      );
    }
    labels.push(
      control.getAttribute("aria-label") || "",
      control.getAttribute("placeholder") || "",
      control.name || "",
      control.id || "",
      control.closest("label,fieldset,[role='group'],.form-group")?.innerText?.slice(0, 240) || ""
    );
    return normalize(labels.join(" "));
  }

  function bestFieldValue(description, claim) {
    const { order, sender, details } = claim;
    const fullSenderName = [sender.contactFirstName, sender.contactLastName].filter(Boolean).join(" ");
    const rules = [
      [["numero de suivi", "avis de passage", "tracking"], order.trackingNumber],
      [["adresse e-mail", "adresse email", "courriel", "email"], sender.email],
      [["telephone", "tel", "mobile"], sender.phone],
      [["raison sociale", "societe", "entreprise"], sender.companyName],
      [["prenom exp", "votre prenom", "prenom"], sender.contactFirstName],
      [["nom exp", "votre nom", "nom de famille"], sender.contactLastName || fullSenderName],
      [["adresse de l'expediteur", "votre adresse", "numero et voie", "adresse postale"], sender.address1],
      [["complement d'adresse", "adresse 2"], sender.address2],
      [["code postal exped", "votre code postal", "code postal"], sender.postalCode],
      [["ville exped", "votre ville", "commune", "ville"], sender.city],
      [["pays exped", "votre pays", "pays"], sender.country],
      [["nom du destinataire", "destinataire nom"], order.recipientName],
      [["adresse du destinataire", "destinataire adresse"], order.recipientAddress1],
      [["code postal du destinataire", "destinataire code postal"], order.recipientPostalCode],
      [["ville du destinataire", "destinataire ville"], order.recipientCity],
      [["pays du destinataire", "destinataire pays"], order.recipientCountry],
      [["numero de commande", "reference commande"], order.orderId],
      [["montant", "valeur", "prix", "indemnisation"], String(order.itemValue || "").replace(/[^\d.,]/g, "")],
      [["description", "detail", "commentaire", "message", "expliquez"], details]
    ];

    for (const [needles, value] of rules) {
      if (value && needles.some((needle) => description.includes(normalize(needle)))) return value;
    }
    return "";
  }

  function fillVisibleFields() {
    if (!state.claim) return 0;
    let count = 0;
    for (const control of document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea")) {
      const value = bestFieldValue(descriptor(control), state.claim);
      if (setControlValue(control, value)) count += 1;
    }
    return count;
  }

  function shipmentAgeDays(order) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const match = String(order.shipDate || "").match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (!match) return null;
    const sent = new Date(Number(match[3]), months[match[2].toLowerCase()], Number(match[1]));
    return Math.max(0, Math.floor((Date.now() - sent.getTime()) / 86400000));
  }

  function shipmentDateFr(order) {
    const age = shipmentAgeDays(order);
    if (age == null) return order.shipDate || "date inconnue";
    const sent = new Date(Date.now() - age * 86400000);
    return sent.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function deriveClaimFromTracking() {
    if (!state.claim || state.claim.reason !== "auto") return;
    const status = [...document.querySelectorAll("main p")]
      .map((node) => node.innerText.trim())
      .filter((text) => text && text !== state.claim.order.trackingNumber && normalize(text) !== "colissimo")
      .find((text) => text.length > 25) || "Aucune mise à jour de livraison récente.";
    const normalizedStatus = normalize(status);
    const age = shipmentAgeDays(state.claim.order);

    if (/endommage|deteriore|avarie/.test(normalizedStatus)) state.claim.reason = "damaged";
    else if (age != null && age >= 14) state.claim.reason = "lost";
    else state.claim.reason = "delayed";

    const { order } = state.claim;
    const value = order.itemValue || "valeur non détectée";
    if (state.claim.reason === "lost") {
      state.claim.details = `Le colis ${order.trackingNumber}, expédié le ${shipmentDateFr(order)} à ${order.recipientName} (${order.recipientCountry}), n'a jamais été livré. Le suivi indique : « ${status.slice(0, 155)} ». Après ${age ?? "de nombreux"} jours, le destinataire ne peut ni localiser ni récupérer l'envoi. Merci d'ouvrir une enquête et de procéder à l'indemnisation si la perte est confirmée (valeur : ${value}).`.slice(0, 500);
    } else if (state.claim.reason === "damaged") {
      state.claim.details = `Le colis ${order.trackingNumber} est signalé endommagé. Le suivi indique : « ${status.slice(0, 190)} ». Merci d'ouvrir une enquête et de nous indiquer la procédure d'indemnisation (valeur : ${value}).`.slice(0, 500);
    } else {
      state.claim.details = `Le colis ${order.trackingNumber}, expédié le ${shipmentDateFr(order)}, n'est toujours pas livré. Le suivi indique : « ${status.slice(0, 210)} ». Merci de vérifier l'acheminement et de nous communiquer une solution de livraison.`.slice(0, 500);
    }
    state.claim.statusSnapshot = status;
    chrome.runtime.sendMessage({
      type: "UPDATE_PENDING_CLAIM",
      carrier: "laposte",
      claim: state.claim
    });
  }

  function transmissionField(key) {
    return document.querySelector(`[data-transmission-key="${key}"]`);
  }

  function clickRadio(value, index = 0) {
    const radios = [...document.querySelectorAll(`input[type="radio"][data-value="${value}"]`)].filter(visible);
    const radio = radios[index];
    if (!radio || radio.checked) return false;
    radio.click();
    return true;
  }

  function chooseCountry(key, country) {
    const trigger = transmissionField(key);
    if (!trigger || normalize(trigger.innerText) === normalize(country)) return false;
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible);
    if (dialog) {
      const option = [...dialog.querySelectorAll('[role="option"]')]
        .find((node) => normalize(node.innerText) === normalize(country));
      return clickOnce(option);
    }
    return clickOnce(trigger);
  }

  function fillKnownContactFields() {
    if (!state.claim) return false;
    const { sender, order } = state.claim;
    const recipientParts = String(order.recipientName || "").trim().split(/\s+/);
    const recipientFirst = recipientParts.shift() || "";
    const recipientLast = recipientParts.join(" ");
    const values = {
      prenomclient: sender.contactFirstName,
      nomclient: sender.contactLastName,
      email: sender.email,
      telephone: sender.phone,
      adresseligne4: sender.address1,
      adresseligne6_ville: sender.city,
      adresseligne6_code: sender.postalCode,
      prenomdest: recipientFirst,
      nomdest: recipientLast,
      adresseligne4dest: order.recipientAddress1,
      adresseligne6dest_code: order.recipientPostalCode,
      adresseligne6dest_ville: order.recipientCity
    };
    Object.entries(values).forEach(([key, value]) => setControlValue(transmissionField(key), value));
    if (sender.senderType) clickRadio(sender.senderType);
    if (sender.contactTitle) clickRadio(sender.contactTitle, 0);
    if (state.claim.recipientTitle) clickRadio(state.claim.recipientTitle, 1);

    if (chooseCountry("adresseligne7", sender.country || "France")) return true;
    const recipientCountry = sharedRules?.laPosteCountryLabel(order.recipientCountry) || order.recipientCountry;
    return chooseCountry("adresseligne7dest", recipientCountry);
  }

  function buttons(root = document) {
    return [...root.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")]
      .filter(visible)
      .map((node) => ({ node, text: normalize(node.innerText || node.value || node.getAttribute("aria-label")) }))
      .filter((item) => item.text);
  }

  function clickOnce(node) {
    if (!node || state.clicked.has(node)) return false;
    state.clicked.add(node);
    node.click();
    return true;
  }

  function chooseReasonButton() {
    const terms = {
      delivered_missing: ["indique comme livre", "n'est pas arrive", "pas ete depose", "pas ete livre"],
      lost: ["non recu", "non livre", "perdu", "perte", "ne peut pas recuperer", "introuvable"],
      delayed: ["retard", "delai"],
      damaged: ["endommage", "deteriore", "avarie"],
      contents_missing: ["contenu manquant", "objet manquant", "spolie"],
      returned: ["retour", "retourne a l'expediteur"],
      other: ["autre"]
    }[state.claim.reason] || [];
    const candidates = buttons().filter(({ text }) => terms.some((term) => text.includes(term)));
    if (candidates.length === 1) return clickOnce(candidates[0].node);
    return false;
  }

  function chooseGenericStep() {
    const heading = normalize(
      [...document.querySelectorAll("h1,h2,h3")].filter(visible).map((node) => node.innerText).join(" ")
    );
    const main = [...document.querySelectorAll("main")].find(visible) || document;
    const choices = buttons(main);

    if (heading.includes("vous etes")) {
      return clickOnce(choices.find(({ text }) => text === "expediteur")?.node);
    }

    if (heading.includes("numero de suivi")) {
      const tracking = [...document.querySelectorAll("input")].find((input) =>
        descriptor(input).includes("numero de suivi")
      );
      setControlValue(tracking, state.claim.order.trackingNumber);
      if (tracking?.value === state.claim.order.trackingNumber) {
        return clickOnce(choices.find(({ text }) => text === "rechercher")?.node);
      }
    }

    if (heading.includes("resultat de votre recherche")) {
      if (state.claim.reason === "auto") deriveClaimFromTracking();
      return clickOnce(choices.find(({ text }) => text === "poursuivre")?.node);
    }

    if (heading.includes("a quel sujet nous contactez-vous")) {
      const firstAnswerIndex = sharedRules?.firstLaPosteSubjectAnswerIndex(
        choices.map(({ text }) => text)
      ) ?? 0;
      return clickOnce(choices[firstAnswerIndex]?.node);
    }

    if (heading.includes("ajoutez une precision") && state.claim.reason === "delivered_missing") {
      return clickOnce(choices.find(({ text }) => text.includes("pas ete depose en boite aux lettres"))?.node);
    }

    if (heading.includes("ajoutez une precision") && state.claim.reason === "lost") {
      return clickOnce(choices.find(({ text }) => text.includes("est introuvable"))?.node);
    }

    if (heading.includes("votre message")) {
      const message = document.querySelector("textarea");
      setControlValue(message, state.claim.details);
      if (message?.value === state.claim.details) {
        return clickOnce(choices.find(({ text }) => text === "continuer")?.node);
      }
    }

    if (heading.includes("quelles sont vos coordonnees")) {
      if (fillKnownContactFields()) return true;
      const missing = [...document.querySelectorAll("input[required]")].some((input) => !input.disabled && !input.value.trim());
      const countriesReady = [...document.querySelectorAll('[data-transmission-key="adresseligne7"],[data-transmission-key="adresseligne7dest"]')]
        .every((node) => !normalize(node.innerText).includes("choisissez"));
      if (!missing && countriesReady) {
        return clickOnce(choices.find(({ text }) => text === "acceder au recapitulatif")?.node);
      }
    }

    if (/a quel sujet|ajoutez une precision|motif|raison|probleme|incident|situation/.test(heading) && chooseReasonButton()) return true;

    if (/courrier ou colis|type d'envoi|votre envoi/.test(heading)) {
      const colissimo = choices.filter(({ text }) => text.includes("colissimo"));
      if (colissimo.length === 1) return clickOnce(colissimo[0].node);
    }

    if (/expediteur|destinataire/.test(heading)) {
      const sender = choices.filter(({ text }) => text === "expediteur");
      if (sender.length === 1) return clickOnce(sender[0].node);
    }

    return false;
  }

  function finalButton() {
    const node = buttons().find(({ text }) => FINAL_LABELS.some((label) => text === normalize(label)))?.node;
    return node && !node.disabled && node.getAttribute("aria-disabled") !== "true" ? node : null;
  }

  function captchaNeedsUser() {
    const selectors = [
      "#li-antibot-content",
      '[id*="captcha" i]',
      '[class*="captcha" i]',
      'iframe[src*="captcha" i]',
      'iframe[title*="captcha" i]'
    ];
    return selectors.some((selector) => [...document.querySelectorAll(selector)].some((node) => {
      if (!visible(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    }));
  }

  function reportWorkflowState(status, message) {
    if (!state.claim) return;
    const signature = `${status}|${message}`;
    if (signature === state.lastReported) return;
    state.lastReported = signature;
    chrome.runtime.sendMessage({
      type: "CLAIM_WORKFLOW_STATE",
      carrier: "laposte",
      claimId: state.claim.id,
      status,
      message
    });
  }

  function updatePanel(message) {
    const status = document.querySelector("#lpca-status");
    if (status) status.textContent = message;
    const submit = document.querySelector("#lpca-submit");
    if (submit) submit.disabled = !finalButton();
    const reason = document.querySelector("#lpca-reason-value");
    if (reason && state.claim) reason.textContent = state.claim.reason.replaceAll("_", " ");
  }

  async function finishSuccessfulSubmission() {
    if (!state.claim) return false;
    const success = outcomeRules.detectClaimSuccess("laposte", document.body.innerText);
    if (!success) return false;
    const recoveredFromCarrierConfirmation = !state.claim.submissionStartedAt;
    if (recoveredFromCarrierConfirmation && !success.reference) return false;
    if (state.successReported) return true;
    const response = await chrome.runtime.sendMessage({
      type: "CLAIM_SUBMISSION_SUCCESS",
      carrier: "laposte",
      claimId: state.claim.id,
      reference: success.reference,
      confirmationText: success.confirmationText,
      recoveredFromCarrierConfirmation
    });
    if (!response?.ok) {
      updatePanel(`La Poste confirmed submission, but Amazon could not be updated: ${response?.error || "Unknown error"}`);
      return false;
    }
    state.successReported = true;
    const pauseButton = document.querySelector("#lpca-laposte-panel #lpca-pause");
    if (pauseButton) pauseButton.hidden = true;
    updatePanel(success.reference ? `Claim sent · Reference ${success.reference}` : "Claim sent successfully.");
    return true;
  }

  async function advance() {
    if (!state.claim || state.working) return;
    state.working = true;
    try {
      if (await finishSuccessfulSubmission()) return;
      if (state.paused) return;
      const filled = fillVisibleFields();
      const moved = chooseGenericStep();
      const progress = document.querySelector("[role='progressbar']")?.innerText || "";
      const ready = finalButton();
      const captcha = captchaNeedsUser();
      if (filled || moved) state.lastProgressAt = Date.now();
      state.finalReady = Boolean(ready);
      updatePanel(ready
        ? "Ready to submit through La Poste's official endpoint. Review the recap and continue."
        : moved
          ? `Continuing automatically… ${progress}`
          : `${filled ? `Filled ${filled} field(s). ` : ""}${progress || "Waiting for a required choice or CAPTCHA."}`);
      if (ready) {
        reportWorkflowState("ready", "Review the recap and confirm the La Poste submission.");
      } else if (captcha) {
        reportWorkflowState("captcha", "Complete La Poste's CAPTCHA to continue.");
      } else if (filled || moved) {
        reportWorkflowState("preparing", "La Poste claim is being prepared in the background.");
      } else if (Date.now() - state.lastProgressAt > 5000) {
        reportWorkflowState("needs_attention", "La Poste requires one unresolved choice before continuing.");
      }
    } finally {
      state.working = false;
    }
  }

  function renderPanel() {
    const { order, sender, reason } = state.claim;
    const senderLabel = sender.companyName || [sender.contactFirstName, sender.contactLastName].filter(Boolean).join(" ");
    const panel = document.createElement("aside");
    panel.id = "lpca-laposte-panel";
    panel.className = "lpca-panel";
    panel.innerHTML = `
      <div class="lpca-panel__header">
        <div><small>La Poste Claim Assistant</small><strong>${escapeHtml(order.trackingNumber)}</strong></div>
        <div class="lpca-panel__header-actions">
          <button id="lpca-collapse" class="lpca-icon-button" type="button" aria-label="Collapse claim assistant" title="Collapse claim assistant">▾</button>
          <button id="lpca-pause" class="lpca-icon-button" type="button" aria-label="Pause automation" title="Pause automation">⏸</button>
        </div>
      </div>
      <dl>
        <div><dt>Order</dt><dd>${escapeHtml(order.orderId)}</dd></div>
        <div><dt>Reason</dt><dd id="lpca-reason-value">${escapeHtml(reason.replaceAll("_", " "))}</dd></div>
        <div><dt>Sender</dt><dd>${escapeHtml(senderLabel)}</dd></div>
      </dl>
      <p id="lpca-status" class="lpca-status">Starting…</p>
      <div class="lpca-stack">
        <button id="lpca-fill" class="lpca-button lpca-button--secondary">Prefill this step</button>
        <button id="lpca-submit" class="lpca-button" disabled>Confirm and submit to La Poste</button>
        <button id="lpca-clear" class="lpca-link-button">Clear pending claim</button>
      </div>`;
    document.body.append(panel);

    const setCollapsed = (collapsed) => {
      panel.classList.toggle("lpca-panel--collapsed", collapsed);
      const button = panel.querySelector("#lpca-collapse");
      button.textContent = collapsed ? "▴" : "▾";
      button.setAttribute("aria-label", collapsed ? "Expand claim assistant" : "Collapse claim assistant");
      button.title = collapsed ? "Expand claim assistant" : "Collapse claim assistant";
      sessionStorage.setItem("lpcaLaPostePanelCollapsed", collapsed ? "true" : "false");
    };
    setCollapsed(sessionStorage.getItem("lpcaLaPostePanelCollapsed") === "true");
    panel.querySelector("#lpca-collapse").addEventListener("click", () => {
      setCollapsed(!panel.classList.contains("lpca-panel--collapsed"));
    });

    panel.querySelector("#lpca-fill").addEventListener("click", () => {
      state.paused = false;
      fillVisibleFields();
      chooseGenericStep();
      updatePanel("Prefill applied.");
    });
    panel.querySelector("#lpca-pause").addEventListener("click", (event) => {
      state.paused = !state.paused;
      event.currentTarget.textContent = state.paused ? "▶" : "⏸";
      event.currentTarget.setAttribute("aria-label", state.paused ? "Resume automation" : "Pause automation");
      event.currentTarget.title = state.paused ? "Resume automation" : "Pause automation";
      updatePanel(state.paused ? "Automation paused." : "Automation resumed.");
      if (!state.paused) advance();
    });
    panel.querySelector("#lpca-submit").addEventListener("click", async () => {
      const target = finalButton();
      if (!target) {
        window.alert("The final La Poste submit button is not visible yet.");
        return;
      }
      const ok = window.confirm(
        `Submit this claim to La Poste now?\n\nTracking: ${order.trackingNumber}\nOrder: ${order.orderId}\nEmail: ${sender.email}\nReason: ${state.claim.reason.replaceAll("_", " ")}\n\nThis sends the claim and personal/order details to La Poste.`
      );
      if (!ok) return;
      state.claim = { ...state.claim, submissionStartedAt: new Date().toISOString() };
      const updated = await chrome.runtime.sendMessage({
        type: "UPDATE_PENDING_CLAIM",
        carrier: "laposte",
        claim: state.claim
      });
      if (!updated?.ok) {
        window.alert(`The claim could not be armed for confirmation tracking: ${updated?.error || "Unknown error"}`);
        return;
      }
      updatePanel("Submission sent; waiting for La Poste's confirmation…");
      target.click();
    });
    panel.querySelector("#lpca-clear").addEventListener("click", async () => {
      const ok = window.confirm("Clear the pending claim from this browser session?");
      if (!ok) return;
      await chrome.runtime.sendMessage({ type: "CLEAR_PENDING_CLAIM", carrier: "laposte" });
      panel.remove();
      state.claim = null;
    });
  }

  async function loadPendingClaim() {
    const launchToken = new URLSearchParams(location.hash.slice(1)).get("carrier-claim-launch");
    if (!launchToken) return chrome.runtime.sendMessage({ type: "GET_PENDING_CLAIM", carrier: "laposte" });
    const response = await chrome.runtime.sendMessage({ type: "REDEEM_CLOUD_CLAIM", token: launchToken });
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    if (!response?.ok) window.alert(`Could not load the dashboard claim: ${response?.error || "Pair this browser with the return monitor first."}`);
    return response;
  }

  loadPendingClaim().then((response) => {
    const pendingLaPosteClaim = response?.claim;
    if (!pendingLaPosteClaim) return;
    state.claim = pendingLaPosteClaim;
    renderPanel();
    advance();
    let timer;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(advance, 250);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(advance, 750);
  });
})();
