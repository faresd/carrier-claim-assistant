(function initOrderParser(root) {
  "use strict";

  const LABELS = new Set([
    "status",
    "image",
    "product name",
    "more information",
    "quantity",
    "proceeds",
    "shipped"
  ]);

  function clean(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function linesOf(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(clean)
      .filter(Boolean);
  }

  function valueAfter(lines, label, validator) {
    const wanted = clean(label).toLowerCase();
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (lines[index].toLowerCase() !== wanted) continue;
      for (let next = index + 1; next < Math.min(lines.length, index + 5); next += 1) {
        if (!validator || validator(lines[next])) return lines[next];
      }
    }
    return "";
  }

  function parseAddress(lines) {
    const start = lines.findIndex((line) => line.toLowerCase() === "ship to");
    const end = lines.findIndex((line, index) => {
      if (index <= start) return false;
      const normalized = line.toLowerCase();
      return normalized.startsWith("address type") ||
        normalized.startsWith("contact buyer") ||
        normalized === "order contents";
    });
    if (start < 0 || end < 0) return {};

    const block = lines.slice(start + 1, end).filter((line) => !/^contact buyer:/i.test(line));
    if (block.length < 4) return {};

    const country = block.at(-1) || "";
    const postalIndex = block.findLastIndex((line, index) => {
      if (index === 0 || index === block.length - 1) return false;
      return /\d/.test(line) && /^[A-Z0-9 -]{4,12}$/i.test(line);
    });
    const resolvedPostalIndex = postalIndex > 1 ? postalIndex : block.length - 2;
    const postalCode = block[resolvedPostalIndex] || "";
    const city = block[resolvedPostalIndex - 1] || "";
    const addressLines = block.slice(1, Math.max(1, resolvedPostalIndex - 1));

    return {
      recipientName: block[0] || "",
      recipientAddress1: addressLines[0] || "",
      recipientAddress2: addressLines.slice(1).join(", "),
      recipientCity: city,
      recipientPostalCode: postalCode,
      recipientCountry: country
    };
  }

  function parseProduct(lines) {
    const asinIndex = lines.findIndex((line) => /^ASIN:\s*/i.test(line));
    if (asinIndex < 1) return {};

    let productName = "";
    for (let index = asinIndex - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (!LABELS.has(candidate.toLowerCase()) && !/^€/.test(candidate)) {
        productName = candidate;
        break;
      }
    }

    return {
      productName,
      asin: clean(lines[asinIndex].replace(/^ASIN:\s*/i, "")),
      sku: clean((lines.find((line) => /^SKU:\s*/i.test(line)) || "").replace(/^SKU:\s*/i, ""))
    };
  }

  function parseOrderDetails(text, pageUrl) {
    const normalizedText = String(text || "").replace(/\u00a0/g, " ");
    const lines = linesOf(normalizedText);
    const orderIdMatch = normalizedText.match(/Order ID:\s*#?\s*([0-9-]+)/i);
    const trackingMatch = normalizedText.match(/Tracking ID\s*:?\s*\n\s*([A-Z]{2}[A-Z0-9]{9,13}[A-Z]{2}|[A-Z0-9-]{8,25})/i);
    const subtotalMatches = [...normalizedText.matchAll(/Item subtotal:\s*\n?\s*€\s*([\d.,]+)/gi)];
    const orderDateMatch = normalizedText.match(/(?:Purchase date|Order date|Date d'achat|Date de commande)\s*:?\s*(?:\n\s*)?([^\n]+)/i);
    const orderDateCandidate = orderDateMatch ? clean(orderDateMatch[1]) : "";
    const orderDate = /\d{4}/.test(orderDateCandidate) ? orderDateCandidate : "";
    const shipDate = valueAfter(lines, "Ship date", (line) => /\d{4}|mon|tue|wed|thu|fri|sat|sun/i.test(line));
    const deliverByMatch = normalizedText.match(/Deliver by:\s*([^\n]+(?:\s+to\s+[^\n]+)?)/i);
    const carrier = valueAfter(lines, "Shipping Carrier", (line) => !/^tracking id$/i.test(line));
    const shippingService = valueAfter(lines, "Shipping service", (line) => !/^fulfilment$/i.test(line));
    let sellerAccountId = "";
    let marketplaceId = "";
    try {
      const url = new URL(pageUrl || "", "https://sellercentral.amazon.fr");
      sellerAccountId = clean(url.searchParams.get("mons_sel_mcid") || url.searchParams.get("merchantId") || "");
      marketplaceId = clean(url.searchParams.get("mons_sel_mkid") || url.searchParams.get("marketplaceId") || "");
    } catch {}

    return {
      sourceUrl: pageUrl || "",
      orderId: orderIdMatch ? orderIdMatch[1] : "",
      trackingNumber: trackingMatch ? trackingMatch[1].toUpperCase() : "",
      orderDate,
      shipDate,
      deliverBy: deliverByMatch ? clean(deliverByMatch[1]) : "",
      carrier,
      shippingService,
      itemValue: subtotalMatches.length ? `€${subtotalMatches[0][1]}` : "",
      quantity: "1",
      sellerAccountId: sellerAccountId || "sellercentral.amazon.fr",
      sellerAccountName: sellerAccountId || "Seller Central account",
      marketplaceId: marketplaceId || "A13V1IB3VIYZZH",
      ...parseAddress(lines),
      ...parseProduct(lines)
    };
  }

  function destinationLines(order, countryOverride) {
    const locality = clean([order?.recipientPostalCode, order?.recipientCity].filter(Boolean).join(" "));
    return [
      order?.recipientName,
      order?.recipientAddress1,
      order?.recipientAddress2,
      locality,
      countryOverride || order?.recipientCountry
    ].map(clean).filter(Boolean);
  }

  function enrichSellerContext(order, root, pageUrl) {
    const next = { ...(order || {}) };
    const urls = [pageUrl || next.sourceUrl || ""];
    for (const link of root?.querySelectorAll?.('a[href*="mons_sel_mcid"],a[href*="merchantId"]') || []) {
      if (link.href) urls.push(link.href);
    }
    for (const value of urls) {
      try {
        const url = new URL(value, "https://sellercentral.amazon.fr");
        const accountId = clean(url.searchParams.get("mons_sel_mcid") || url.searchParams.get("merchantId") || "");
        const marketplaceId = clean(url.searchParams.get("mons_sel_mkid") || url.searchParams.get("marketplaceId") || "");
        if (accountId) next.sellerAccountId = accountId;
        if (marketplaceId) next.marketplaceId = marketplaceId;
        if (accountId) break;
      } catch {}
    }
    const accountControl = [
      ".dropdown-account-switcher-header-label-global",
      "#sc-mkt-switcher-dp-link",
      '[data-testid*="merchant" i]',
      '[aria-label*="merchant" i]',
      '[class*="merchant-name" i]'
    ].map((selector) => root?.querySelector?.(selector)).find(Boolean);
    const accountName = clean(accountControl?.innerText || accountControl?.textContent || "");
    if (accountName && accountName.length <= 160 && !/^(amazon|france|settings|help)$/i.test(accountName)) {
      next.sellerAccountName = accountName;
    } else if (!next.sellerAccountName || next.sellerAccountName === "Seller Central account") {
      next.sellerAccountName = next.sellerAccountId || "Seller Central account";
    }
    return next;
  }

  const api = { clean, linesOf, parseOrderDetails, destinationLines, enrichSellerContext };
  root.LaPosteOrderParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
