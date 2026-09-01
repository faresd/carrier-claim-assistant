(function initReturnDashboard() {
  "use strict";

  const PAGE_SIZE = 100;
  const state = {
    orders: [], view: "all", query: "", accountId: "", csrfToken: "", user: null,
    authenticated: false, claimOrder: null, offset: 0, hasMore: true, loadingMore: false,
    requestVersion: 0, summary: null, accounts: []
  };
  const body = document.getElementById("orders-body");
  const table = document.querySelector(".table-wrap");
  const loading = document.getElementById("loading");
  const toast = document.getElementById("toast");
  const scrollStatus = document.getElementById("scroll-status");

  function escapeHtml(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
  }

  function labelFor(stateName) {
    return {
      pickup_ready: "Pickup required",
      returning: "Returning to sender",
      lost: "Lost / unlocated",
      damaged: "Damaged",
      resolved: "Returned · received",
      delivered: "Delivered",
      in_transit: "In transit",
      unknown: "Needs review"
    }[stateName] || "Needs review";
  }

  function dateTime(value) {
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) && date.getTime() > 0
      ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(date)
      : "Not checked";
  }

  function carrierTrackingUrl(order) {
    const trackingNumber = encodeURIComponent(order.trackingNumber || "");
    return /chrono/i.test(`${order.carrierId || ""} ${order.carrierLabel || ""}`)
      ? `https://www.chronopost.fr/tracking-no-cms/suivi-page?langue=fr&listeNumerosLT=${trackingNumber}`
      : `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}`;
  }

  function trackingSourceLabel(value) {
    return {
      "laposte-suivi-v2": "La Poste Suivi API v2",
      "laposte-suivi-v1": "La Poste Suivi API v1 fallback",
      "carrier-page-laposte": "La Poste tracking page",
      "carrier-page-chronopost": "Chronopost tracking page"
    }[value] || "Tracking source not recorded";
  }

  function claimPackage(order) {
    try {
      const payload = JSON.parse(order.claimPayload || "{}");
      return payload && typeof payload === "object" ? payload : {};
    } catch {
      return {};
    }
  }

  function defaultClaimReason(order) {
    if (["lost", "returned", "delayed", "damaged", "delivered_missing", "contents_missing", "other"].includes(order.claimReason)) {
      return order.claimReason;
    }
    if (["returning", "pickup_ready"].includes(order.trackingState)) return "returned";
    if (order.trackingState === "damaged") return "damaged";
    if (order.trackingState === "lost") return "lost";
    return "other";
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(state.csrfToken ? { "x-csrf-token": state.csrfToken } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function startLogin() {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    location.replace(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  function counts() {
    if (state.summary && state.summary.counts) return state.summary.counts;
    const count = (states) => state.orders.filter((order) => states.includes(order.trackingState)).length;
    return {
      all: state.orders.length,
      pickup: count(["pickup_ready"]),
      returning: count(["returning"]),
      lost: count(["lost", "damaged"]),
      returned: count(["returning", "pickup_ready"]),
      resolved: count(["resolved"])
    };
  }

  function render() {
    const totals = counts();
    for (const [key, value] of Object.entries({ all: totals.all, lost: totals.lost, returned: totals.returned, resolved: totals.resolved })) {
      document.getElementById(`count-${key}`).textContent = value;
    }
    document.getElementById("metric-pickup").textContent = totals.pickup;
    document.getElementById("metric-returning").textContent = totals.returning;
    document.getElementById("metric-lost").textContent = totals.lost;
    document.getElementById("metric-resolved").textContent = totals.resolved;
    const urgent = document.getElementById("urgent-card");
    urgent.hidden = totals.pickup === 0;
    document.getElementById("urgent-copy").textContent = `${totals.pickup} returned package${totals.pickup === 1 ? " is" : "s are"} waiting to be collected.`;

    const accountFilter = document.getElementById("account-filter");
    const accounts = state.accounts.length
      ? state.accounts.map((account) => [account.accountId, account.accountName])
      : [...new Map(state.orders.map((order) => [order.accountId, order.accountName || order.accountId])).entries()]
        .sort((left, right) => left[1].localeCompare(right[1]));
    accountFilter.innerHTML = `<option value="">All accounts</option>${accounts.map(([id, name]) => `<option value="${escapeHtml(id)}"${state.accountId === id ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
    const orders = state.orders;
    table.hidden = orders.length === 0;
    loading.hidden = orders.length > 0;
    if (!orders.length && !state.loadingMore) loading.textContent = totals.all ? "No orders match this view." : "No tracked orders have been registered yet.";
    body.innerHTML = orders.map((order) => {
      const address = [order.recipientPostalCode, order.recipientCity, order.recipientCountry].filter(Boolean).join(" · ");
      const claim = order.claimStatus === "sent"
        ? `<strong>Sent${order.claimReference ? ` · ${escapeHtml(order.claimReference)}` : ""}</strong>${escapeHtml(order.claimReason || "")}`
        : order.claimRecommended || order.claimStatus === "requested"
          ? `<strong>${order.claimStatus === "requested" ? "Requested" : "Recommended"}</strong>${escapeHtml(order.claimReason || "Review")}`
          : "No claim queued";
      return `<tr>
        <td><a class="order-link" href="${escapeHtml(order.amazonUrl || `https://sellercentral.amazon.fr/orders-v3/order/${order.orderId}`)}" target="_blank" rel="noopener">${escapeHtml(order.orderId)}</a><span class="subline">${escapeHtml(order.recipientName || "Recipient not captured")} · ${escapeHtml(address)}</span></td>
        <td><strong class="order-date">${escapeHtml(order.orderDate || "Not captured")}</strong></td>
        <td><strong class="account-name">${escapeHtml(order.accountName || order.accountId || "Amazon seller")}</strong><span class="subline">${escapeHtml(order.accountId || "Account ID not captured")}</span></td>
        <td><a class="tracking tracking-link" href="${escapeHtml(carrierTrackingUrl(order))}" target="_blank" rel="noopener" title="Open official carrier tracking">${escapeHtml(order.trackingNumber)}</a><span class="subline">${escapeHtml(order.carrierLabel || order.carrierId)}</span></td>
        <td><span class="state state--${escapeHtml(order.trackingState)}">${escapeHtml(labelFor(order.trackingState))}</span><span class="subline">Checked ${escapeHtml(dateTime(order.checkedAt))}</span><span class="api-source">${escapeHtml(trackingSourceLabel(order.trackingSource))}</span></td>
        <td class="status-copy">${escapeHtml(order.statusText || "Waiting for the morning check")}<span class="subline">Updated ${escapeHtml(dateTime(order.updatedAt))}</span></td>
        <td class="claim">${claim}</td>
        <td><div class="row-actions">
          <button class="recheck" type="button" data-recheck="${escapeHtml(order.recordId)}" aria-label="Recheck order ${escapeHtml(order.orderId)}" title="Recheck this parcel now">↻</button>
          <button type="button" data-detail="${escapeHtml(order.recordId)}">Details</button>
          ${!["resolved", "delivered"].includes(order.trackingState) && order.claimStatus !== "sent" ? `<button type="button" data-launch-claim="${escapeHtml(order.recordId)}">Start ${/chrono/i.test(order.carrierId || order.carrierLabel) ? "Chronopost" : "La Poste"} claim</button>` : ""}
          ${["returning", "pickup_ready"].includes(order.trackingState) ? `<button class="receive" type="button" data-resolve="${escapeHtml(order.recordId)}">Confirm received</button>` : ""}
          ${["lost", "damaged"].includes(order.trackingState) ? `<button class="receive" type="button" data-resolve="${escapeHtml(order.recordId)}">Mark resolved</button>` : ""}
          ${order.trackingState === "resolved" ? `<button type="button" data-reopen="${escapeHtml(order.recordId)}">Reopen</button>` : ""}
          ${order.trackingState === "resolved" ? `<button class="delete" type="button" data-delete="${escapeHtml(order.recordId)}">Delete record</button>` : ""}
        </div></td>
      </tr>`;
    }).join("");
    if (state.loadingMore) scrollStatus.textContent = state.orders.length ? "Loading more orders…" : "Loading tracked orders…";
    else if (state.orders.length) scrollStatus.textContent = state.hasMore ? "Scroll to load more orders" : `All ${state.orders.length} matching orders loaded`;
    else scrollStatus.textContent = "";
  }

  async function loadMore(version = state.requestVersion) {
    if (!state.authenticated || state.loadingMore || !state.hasMore || version !== state.requestVersion) return;
    state.loadingMore = true;
    render();
    const offset = state.offset;
    const params = new URLSearchParams({ view: state.view, limit: String(PAGE_SIZE), offset: String(offset) });
    if (state.accountId) params.set("account", state.accountId);
    if (state.query) params.set("q", state.query);
    if (offset === 0) params.set("summary", "1");
    try {
      const payload = await api(`/api/orders?${params}`);
      if (version !== state.requestVersion) return;
      const page = payload.orders || [];
      const seen = new Set(state.orders.map((order) => order.recordId));
      state.orders.push(...page.filter((order) => !seen.has(order.recordId)));
      state.offset += page.length;
      state.hasMore = Boolean(payload.hasMore && page.length);
      if (payload.summary) {
        state.summary = payload.summary;
        state.accounts = payload.summary.accounts || [];
      }
      document.getElementById("last-sync").textContent = `Server ${dateTime(payload.serverTime)}`;
      document.getElementById("auth-card").hidden = true;
    } catch (error) {
      if (version !== state.requestVersion) return;
      if (error.status === 401) {
        state.authenticated = false;
        startLogin();
        return;
      }
      state.hasMore = false;
      loading.hidden = false;
      loading.textContent = error.message;
      document.getElementById("auth-card").hidden = false;
    } finally {
      if (version === state.requestVersion) {
        state.loadingMore = false;
        render();
      }
    }
  }

  async function load() {
    if (!state.authenticated) return;
    const version = ++state.requestVersion;
    state.orders = [];
    state.offset = 0;
    state.hasMore = true;
    state.loadingMore = false;
    state.summary = null;
    loading.hidden = false;
    loading.textContent = "Loading tracked orders…";
    table.hidden = true;
    render();
    await loadMore(version);
  }

  async function showDetails(order) {
    const claimData = claimPackage(order);
    const sender = claimData.sender || {};
    const item = claimData.order || {};
    const fields = [
      ["Seller account", order.accountName || order.accountId], ["Marketplace", order.marketplaceId],
      ["Tracking state", labelFor(order.trackingState)], ["Tracking number", order.trackingNumber],
      ["Carrier", order.carrierLabel || order.carrierId], ["Last checked", dateTime(order.checkedAt)],
      ["Tracking source", trackingSourceLabel(order.trackingSource)],
      ["Amazon order date", order.orderDate], ["Shipment dates", [order.shipDate && `Shipped ${order.shipDate}`, order.deliverBy && `Deliver by ${order.deliverBy}`].filter(Boolean).join(" · ")],
      ["Recipient title", claimData.recipientTitle], ["Recipient", order.recipientName], ["Destination", [order.recipientAddress1, order.recipientAddress2, order.recipientPostalCode, order.recipientCity, order.recipientCountry].filter(Boolean).join(", ")],
      ["Sender", [sender.companyName, sender.contactFirstName, sender.contactLastName].filter(Boolean).join(" ")],
      ["Sender contact", [sender.email, sender.phone].filter(Boolean).join(" · ")],
      ["Sender address", [sender.address1, sender.address2, sender.postalCode, sender.city, sender.country].filter(Boolean).join(", ")],
      ["Item", [item.productName || order.productName, item.asin, item.sku, item.quantity ? `Qty ${item.quantity}` : "", item.itemValue || order.itemValue].filter(Boolean).join(" · ")],
      ["Claim reason", order.claimReason || defaultClaimReason(order)],
      ["Claim message", claimData.details],
      ["Current carrier event", order.statusText], ["Carrier summary", order.statusSummary],
      ["Claim", `${order.claimStatus || "none"}${order.claimReference ? ` · ${order.claimReference}` : ""}`],
      ["Resolution", order.resolvedAt ? `${dateTime(order.resolvedAt)} · ${order.resolutionNote}` : "Open"]
    ];
    document.getElementById("detail-title").textContent = order.orderId;
    document.getElementById("detail-content").innerHTML = `${fields.map(([label, value], index) => `<div class="detail-field${index >= 6 ? " detail-field--wide" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></div>`).join("")}
      <section class="event-history detail-field--wide"><span>Saved tracking history</span><div id="event-history">Loading…</div></section>`;
    document.getElementById("detail-dialog").showModal();
    try {
      const payload = await api(`/api/orders/${encodeURIComponent(order.recordId)}/events`);
      const events = payload.events || [];
      document.getElementById("event-history").innerHTML = events.length
        ? events.map((event) => `<article><i class="state state--${escapeHtml(event.trackingState)}">${escapeHtml(labelFor(event.trackingState))}</i><strong>${escapeHtml(event.statusText || "Carrier update")}</strong><time>${escapeHtml(dateTime(event.eventAt || event.observedAt))}</time></article>`).join("")
        : "No server-side carrier events saved yet.";
    } catch (error) {
      document.getElementById("event-history").textContent = error.message;
    }
  }

  function openClaimDialog(order) {
    const claimData = claimPackage(order);
    const sender = claimData.sender || {};
    const item = claimData.order || {};
    const isLaPoste = !/chrono/i.test(order.carrierId || order.carrierLabel);
    const rows = [
      ["Seller account", order.accountName || order.accountId],
      ["Tracking", `${order.trackingNumber} · ${order.carrierLabel || order.carrierId || "Carrier"}`],
      ["Recipient", [claimData.recipientTitle, order.recipientName].filter(Boolean).join(" ")],
      ["Destination", [order.recipientAddress1, order.recipientAddress2, order.recipientPostalCode, order.recipientCity, order.recipientCountry].filter(Boolean).join(", ")],
      ["Sender", [sender.companyName, sender.contactFirstName, sender.contactLastName].filter(Boolean).join(" ")],
      ["Sender contact", [sender.email, sender.phone].filter(Boolean).join(" · ")],
      ["Sender address", [sender.address1, sender.address2, sender.postalCode, sender.city, sender.country].filter(Boolean).join(", ")],
      ["Item", [item.productName || order.productName, item.asin, item.sku, item.quantity ? `Qty ${item.quantity}` : "", item.itemValue || order.itemValue].filter(Boolean).join(" · ")],
      ["Carrier status", order.statusText || "Waiting for a carrier check"]
    ];
    state.claimOrder = order;
    document.getElementById("claim-dialog-title").textContent = `${isLaPoste ? "La Poste" : "Chronopost"} claim`;
    document.getElementById("claim-order-summary").textContent = `Order ${order.orderId} · checked ${dateTime(order.checkedAt)}`;
    document.getElementById("claim-context").innerHTML = rows.map(([label, value], index) => `<article class="${index >= 3 ? "wide" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "Not captured")}</strong></article>`).join("");
    document.getElementById("claim-reason").value = defaultClaimReason(order);
    document.getElementById("claim-details").value = claimData.details || order.claimTitle || order.statusText || "";
    const titleRow = document.getElementById("claim-recipient-title-row");
    const title = document.getElementById("claim-recipient-title");
    titleRow.hidden = !isLaPoste;
    title.required = isLaPoste;
    title.value = isLaPoste && ["Monsieur", "Madame"].includes(claimData.recipientTitle) ? claimData.recipientTitle : "";
    document.getElementById("claim-dialog").showModal();
  }

  async function loadDevices() {
    const container = document.getElementById("device-list");
    try {
      const payload = await api("/api/devices");
      container.innerHTML = (payload.devices || []).length
        ? payload.devices.map((device) => `<article><div><strong>${escapeHtml(device.name || "Chrome/Brave browser")}</strong><small>${device.revokedAt ? `Revoked ${escapeHtml(dateTime(device.revokedAt))}` : `Last seen ${escapeHtml(dateTime(device.lastSeenAt))}`}</small></div>${device.revokedAt ? '<span class="device-revoked">Revoked</span>' : `<button type="button" data-revoke-device="${escapeHtml(device.id)}">Revoke</button>`}</article>`).join("")
        : "No browsers have been paired yet.";
    } catch (error) {
      container.textContent = error.message;
    }
  }

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
    state.view = tab.dataset.view;
    load();
  }));
  let searchTimer = 0;
  document.getElementById("search").addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });
  document.getElementById("account-filter").addEventListener("change", (event) => { state.accountId = event.target.value; load(); });
  const scrollObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore();
  }, { rootMargin: "600px 0px" });
  scrollObserver.observe(document.getElementById("scroll-sentinel"));
  document.getElementById("refresh").addEventListener("click", load);
  document.getElementById("export-history").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = { version: 1, exportedAt: new Date().toISOString() };
      for (const resource of ["orders", "trackingEvents", "sellerAccounts", "monitorRuns"]) {
        const rows = [];
        let offset = 0;
        let page;
        do {
          page = await api(`/api/export?resource=${encodeURIComponent(resource)}&limit=500&offset=${offset}`);
          rows.push(...(page.rows || []));
          offset += (page.rows || []).length;
          if (offset >= 100000 && page.hasMore) throw new Error(`The ${resource} export exceeds the safe browser limit.`);
        } while (page.hasMore);
        result[resource] = rows;
      }
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `carrier-return-history-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      notify(`Exported ${result.orders.length} tracked orders.`);
    } catch (error) { notify(error.message); }
    finally { event.currentTarget.disabled = false; }
  });
  document.getElementById("add-browser").addEventListener("click", async (event) => {
    if (!state.authenticated) return notify("Sign in to the dashboard first.");
    event.currentTarget.disabled = true;
    try {
      const result = await api("/api/pairing", { method: "POST", body: JSON.stringify({ deviceName: "Chrome/Brave browser" }) });
      document.getElementById("pairing-code").textContent = result.code;
      document.getElementById("pairing-expiry").textContent = `Expires ${dateTime(result.expiresAt)} · Server: ${location.origin}`;
      document.getElementById("pairing-dialog").showModal();
      await loadDevices();
    } catch (error) { notify(error.message); }
    finally { event.currentTarget.disabled = false; }
  });
  document.getElementById("show-pickups").addEventListener("click", () => document.querySelector('[data-view="returned"]').click());
  document.getElementById("device-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-revoke-device]");
    if (!button || !confirm("Revoke this browser's access to the return monitor?")) return;
    button.disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(button.dataset.revokeDevice)}/revoke`, { method: "POST", body: "{}" });
      notify("Browser access revoked.");
      await loadDevices();
    } catch (error) { notify(error.message); }
  });
  document.getElementById("run-monitor").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api("/api/monitor/run", { method: "POST", body: "{}" });
      notify(result.skipped ? "Today's morning monitor already ran." : `Queued ${result.queuedCount} parcels for checking.`);
      await load();
    } catch (error) { notify(error.message); }
    finally { event.currentTarget.disabled = false; }
  });
  body.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const recordId = button.dataset.recheck || button.dataset.detail || button.dataset.resolve || button.dataset.reopen || button.dataset.launchClaim || button.dataset.delete;
    const order = state.orders.find((item) => item.recordId === recordId);
    if (!order) return;
    if (button.dataset.detail) return showDetails(order);
    if (button.dataset.launchClaim) return openClaimDialog(order);
    button.disabled = true;
    try {
      if (button.dataset.recheck) {
        await api(`/api/orders/${encodeURIComponent(recordId)}/recheck`, { method: "POST", body: "{}" });
        order.statusText = "Fresh carrier check queued…";
        render();
        notify(`Rechecking order ${order.orderId}.`);
        setTimeout(load, 3000);
        setTimeout(load, 12000);
        return;
      }
      if (button.dataset.resolve) {
        const returned = ["returning", "pickup_ready"].includes(order.trackingState);
        if (!confirm(returned ? `Confirm that returned order ${order.orderId} was physically received?` : `Mark order ${order.orderId} as resolved?`)) return;
        await api(`/api/orders/${encodeURIComponent(recordId)}/resolve`, { method: "POST", body: JSON.stringify({ note: returned ? "Returned parcel physically received" : "Lost/damaged case manually resolved" }) });
        notify("Order moved to Resolved.");
      }
      if (button.dataset.reopen) {
        await api(`/api/orders/${encodeURIComponent(recordId)}/reopen`, { method: "POST", body: "{}" });
        notify("Order reopened.");
      }
      if (button.dataset.delete) {
        if (!confirm(`Permanently delete resolved order ${order.orderId} and its tracking history? Export history first if you need a backup. This cannot be undone.`)) return;
        await api(`/api/orders/${encodeURIComponent(recordId)}/delete`, { method: "POST", body: "{}" });
        notify("Resolved order permanently deleted.");
      }
      await load();
    } catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  });

  document.querySelectorAll("[data-claim-cancel]").forEach((button) => button.addEventListener("click", () => {
    state.claimOrder = null;
    document.getElementById("claim-dialog").close();
  }));
  document.getElementById("claim-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const order = state.claimOrder;
    if (!order) return;
    const reason = document.getElementById("claim-reason").value;
    const details = document.getElementById("claim-details").value.trim();
    const isLaPoste = !/chrono/i.test(order.carrierId || order.carrierLabel);
    const recipientTitle = isLaPoste ? document.getElementById("claim-recipient-title").value : claimPackage(order).recipientTitle || "";
    if (!details || (isLaPoste && !recipientTitle)) return event.currentTarget.reportValidity();
    const claimWindow = window.open("about:blank", "_blank");
    if (!claimWindow) return notify("Allow pop-ups for this dashboard, then try again.");
    claimWindow.opener = null;
    const submit = document.getElementById("claim-submit");
    submit.disabled = true;
    try {
      const launch = await api(`/api/orders/${encodeURIComponent(order.recordId)}/launch-claim`, {
        method: "POST",
        body: JSON.stringify({ reason, details, recipientTitle })
      });
      claimWindow.location.href = launch.url;
      state.claimOrder = null;
      document.getElementById("claim-dialog").close();
      notify(`${launch.carrier === "chronopost" ? "Chronopost" : "La Poste"} claim opened in the paired extension.`);
      await load();
    } catch (error) {
      claimWindow.close();
      notify(error.message);
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById("sso-sign-in").addEventListener("click", startLogin);
  document.getElementById("logout").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      location.replace("/?signed_out=1");
    }
  });

  async function start() {
    sessionStorage.removeItem("carrierMonitorAdminToken");
    const params = new URLSearchParams(location.search);
    const authCard = document.getElementById("auth-card");
    const authMessage = document.getElementById("auth-message");
    if (params.get("signed_out")) {
      authMessage.textContent = "You are signed out. Use your Cheaply account when you are ready to reconnect.";
      authCard.hidden = false;
      loading.textContent = "Signed out.";
      return;
    }
    if (params.get("auth_error")) {
      authMessage.textContent = "The Cheaply sign-in did not complete or this account is not a tracking administrator.";
      authCard.hidden = false;
      loading.textContent = "Administrator sign-in required.";
      return;
    }
    try {
      const auth = await api("/api/auth/me");
      state.csrfToken = auth.csrfToken;
      state.user = auth.user;
      state.authenticated = true;
      document.getElementById("session-label").textContent = `Signed in · ${auth.user.name || auth.user.email}`;
      document.getElementById("logout").hidden = false;
      authCard.hidden = true;
      await load();
    } catch (error) {
      if (error.status === 401) return startLogin();
      authMessage.textContent = error.message;
      authCard.hidden = false;
      loading.textContent = error.message;
    }
  }

  setInterval(() => { if (state.authenticated) load(); }, 300000);
  start();
})();
