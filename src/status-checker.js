(function initCarrierStatusChecker() {
  "use strict";

  const SESSION_KEY = "carrierClaimStatusRequest";
  const markerMatch = location.hash.match(/carrier-claim-check=([^&]+)/);

  const normalize = (value) =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  function textOf(root) {
    return String(root?.innerText || root?.textContent || "");
  }

  function openRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      for (const node of roots[index].querySelectorAll?.("*") || []) {
        if (node.shadowRoot && !roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
      }
    }
    return roots;
  }

  function deepQueryAll(selector) {
    return openRoots().flatMap((root) => [...(root.querySelectorAll?.(selector) || [])]);
  }

  function setNativeValue(control, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(control, value);
    else control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function candidateStatusLines(root) {
    const lines = textOf(root)
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length >= 15 && line.length <= 320);
    const terms = /livr|remis|remettre|remise|achemin|transit|retrait|incident|retard|douane|endommag|deterior|perdu|introuvable|retour|destinataire|distribution|pris en charge|envoi/i;
    return lines.filter((line) => terms.test(line));
  }

  function parisDateToISOString(year, monthIndex, day, hour, minute) {
    const requestedWallTime = Date.UTC(year, monthIndex, day, hour, minute);
    let utcGuess = requestedWallTime;
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const values = Object.fromEntries(
        formatter
          .formatToParts(new Date(utcGuess))
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, Number(part.value)])
      );
      const renderedWallTime = Date.UTC(
        values.year,
        values.month - 1,
        values.day,
        values.hour,
        values.minute,
        values.second
      );
      utcGuess += requestedWallTime - renderedWallTime;
    }

    return new Date(utcGuess).toISOString();
  }

  function extractEventDate(text) {
    const french = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:\s+(?:(?:a|à)\s+)?(\d{1,2}):?(\d{2}))?/i);
    if (french) {
      return parisDateToISOString(
        Number(french[3]),
        Number(french[2]) - 1,
        Number(french[1]),
        Number(french[4] || 12),
        Number(french[5] || 0)
      );
    }
    const months = {
      janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
      juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11
    };
    const words = normalize(text).match(/\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})(?:\s+a\s+(\d{1,2})(?:h|:)(\d{2}))?/);
    if (words) {
      return parisDateToISOString(
        Number(words[3]),
        months[words[2]],
        Number(words[1]),
        Number(words[4] || 12),
        Number(words[5] || 0)
      );
    }
    return null;
  }

  function parseStatus(carrier, trackingNumber) {
    const roots = [
      ...deepQueryAll('[data-testid="tracking-detail" i]'),
      ...deepQueryAll('[data-testid*="tracking" i]'),
      ...deepQueryAll('[class*="tracking" i]'),
      ...deepQueryAll('[class*="suivi" i]'),
      ...deepQueryAll("main"),
      ...openRoots(),
      document.body
    ].filter((root, index, list) => root && list.indexOf(root) === index);
    const combinedText = roots.map(textOf).filter(Boolean).join("\n");
    const summaryText = textOf(roots[0] || document.body)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5000);
    const lines = roots.flatMap(candidateStatusLines);
    const bodyLines = combinedText
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const normalizedTracking = normalize(trackingNumber);
    const trackingIndex = bodyLines.findIndex((line) => normalize(line).includes(normalizedTracking));
    const nearbyLines = trackingIndex >= 0
      ? bodyLines.slice(Math.max(0, trackingIndex - 4), trackingIndex + 14).filter((line) => candidateStatusLines({ innerText: line }).length)
      : [];
    const boilerplate = /informations concernant votre envoi|comment suivre|suivre votre (?:colis|envoi)|outil de suivi|renseignez|entrez votre numero|attention aux messages|besoin d'aide|temps reel|nos solutions|decouvrez|questions frequentes|faq/i;
    const statusText = [...nearbyLines, ...lines].find((line) => !boilerplate.test(line)) || "";
    const inputValues = deepQueryAll("input").map((input) => input.value).join(" ");
    const hasTracking = normalize(`${combinedText} ${inputValues}`).includes(normalizedTracking);
    const hasResult = hasTracking && trackingIndex >= 0 && Boolean(statusText);
    return {
      carrier,
      statusText: statusText || "Carrier page loaded, but no concise status line was detected.",
      summaryText,
      eventDate: extractEventDate(summaryText),
      hasResult
    };
  }

  async function report(requestId, result) {
    sessionStorage.removeItem(SESSION_KEY);
    await chrome.runtime.sendMessage({ type: "CARRIER_STATUS_SCRAPED", requestId, result });
  }

  async function pollForResult(request) {
    const started = Date.now();
    while (Date.now() - started < 20000) {
      const result = parseStatus(request.carrier, request.order.trackingNumber);
      if (result.hasResult) return report(request.requestId, result);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return report(request.requestId, {
      carrier: request.carrier,
      statusText: "Tracking status could not be read automatically.",
      summaryText: "",
      eventDate: null,
      error: "The official tracking page did not expose a readable result within 20 seconds."
    });
  }

  async function start(request) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(request));
    history.replaceState(null, "", `${location.pathname}${location.search}`);

    if (request.carrier === "chronopost") {
      const input = document.querySelector('#suivi-number,input[name="suivi_number"]');
      if (!input) return pollForResult(request);
      setNativeValue(input, request.order.trackingNumber);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...request, submitted: true }));
      input.form?.requestSubmit();
      return;
    }

    return pollForResult(request);
  }

  async function init() {
    if (markerMatch) {
      const requestId = decodeURIComponent(markerMatch[1]);
      const response = await chrome.runtime.sendMessage({
        type: "GET_CARRIER_STATUS_REQUEST",
        requestId
      });
      const request = response?.request;
      if (request) return start(request);
    }

    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        const request = JSON.parse(saved);
        if (request?.submitted) return pollForResult(request);
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseStatus, extractEventDate, candidateStatusLines };
  }

  init();
})();
