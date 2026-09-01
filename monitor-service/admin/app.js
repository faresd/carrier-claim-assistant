(function initReturnDashboard() {
  "use strict";

  const state = { orders: [], view: "all", query: "", accountId: "", token: sessionStorage.getItem("carrierMonitorAdminToken") || "" };
  const body = document.getElementById("orders-body");
  const table = document.querySelector(".table-wrap");
  const loading = document.getElementById("loading");
  const toast = document.getElementById("toast");

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

  function claimPackage(order) {
    try {
      const payload = JSON.parse(order.claimPayload || "{}");
      return payload && typeof payload === "object" ? payload : {};
    } catch {
      return {};
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function filteredOrders() {
    const wanted = state.orders.filter((order) => {
      if (state.view === "lost" && !["lost", "damaged"].includes(order.trackingState)) return false;
      if (state.view === "returned" && !["returning", "pickup_ready"].includes(order.trackingState)) return false;
      if (state.view === "resolved" && order.trackingState !== "resolved") return false;
      if (state.accountId && order.accountId !== state.accountId) return false;
      const haystack = `${order.orderId} ${order.trackingNumber} ${order.recipientName}`.toLowerCase();
      return haystack.includes(state.query.toLowerCase());
    });
    return wanted;
  }

  function counts() {
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
    const accounts = [...new Map(state.orders.map((order) => [order.accountId, order.accountName || order.accountId])).entries()]
      .sort((left, right) => left[1].localeCompare(right[1]));
    accountFilter.innerHTML = `<option value="">All accounts</option>${accounts.map(([id, name]) => `<option value="${escapeHtml(id)}"${state.accountId === id ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
    const orders = filteredOrders();
    table.hidden = orders.length === 0;
    loading.hidden = orders.length > 0;
    if (!orders.length) loading.textContent = state.orders.length ? "No orders match this view." : "No tracked orders have been registered yet.";
    body.innerHTML = orders.map((order) => {
      const address = [order.recipientPostalCode, order.recipientCity, order.recipientCountry].filter(Boolean).join(" · ");
      const claim = order.claimStatus === "sent"
        ? `<strong>Sent${order.claimReference ? ` · ${escapeHtml(order.claimReference)}` : ""}</strong>${escapeHtml(order.claimReason || "")}`
        : order.claimRecommended || order.claimStatus === "requested"
          ? `<strong>${order.claimStatus === "requested" ? "Requested" : "Recommended"}</strong>${escapeHtml(order.claimReason || "Review")}`
          : "No claim queued";
      return `<tr>
        <td><a class="order-link" href="${escapeHtml(order.amazonUrl || `https://sellercentral.amazon.fr/orders-v3/order/${order.orderId}`)}" target="_blank" rel="noopener">${escapeHtml(order.orderId)}</a><span class="subline">${escapeHtml(order.accountName || order.accountId)} · ${escapeHtml(order.recipientName || "Recipient not captured")} · ${escapeHtml(address)}</span></td>
        <td><span class="tracking">${escapeHtml(order.trackingNumber)}</span><span class="subline">${escapeHtml(order.carrierLabel || order.carrierId)}</span></td>
        <td><span class="state state--${escapeHtml(order.trackingState)}">${escapeHtml(labelFor(order.trackingState))}</span><span class="subline">Checked ${escapeHtml(dateTime(order.checkedAt))}</span></td>
        <td class="status-copy">${escapeHtml(order.statusText || "Waiting for the morning check")}<span class="subline">Updated ${escapeHtml(dateTime(order.updatedAt))}</span></td>
        <td class="claim">${claim}</td>
        <td><div class="row-actions">
          <button type="button" data-detail="${escapeHtml(order.recordId)}">Details</button>
          ${!["resolved", "delivered"].includes(order.trackingState) && order.claimStatus !== "sent" ? `<button type="button" data-launch-claim="${escapeHtml(order.recordId)}">Start ${/chrono/i.test(order.carrierId || order.carrierLabel) ? "Chronopost" : "La Poste"} claim</button>` : ""}
          ${["returning", "pickup_ready"].includes(order.trackingState) ? `<button class="receive" type="button" data-resolve="${escapeHtml(order.recordId)}">Confirm received</button>` : ""}
          ${["lost", "damaged"].includes(order.trackingState) ? `<button class="receive" type="button" data-resolve="${escapeHtml(order.recordId)}">Mark resolved</button>` : ""}
          ${order.trackingState === "resolved" ? `<button type="button" data-reopen="${escapeHtml(order.recordId)}">Reopen</button>` : ""}
        </div></td>
      </tr>`;
    }).join("");
  }

  async function load() {
    if (!state.token) return;
    loading.hidden = false;
    loading.textContent = "Loading tracked orders…";
    table.hidden = true;
    try {
      let offset = 0;
      let payload = null;
      const orders = [];
      do {
        payload = await api(`/api/orders?limit=500&offset=${offset}`);
        orders.push(...(payload.orders || []));
        offset += (payload.orders || []).length;
      } while (payload.hasMore && offset < 100000);
      state.orders = orders;
      document.getElementById("last-sync").textContent = `Server ${dateTime(payload.serverTime)}`;
      document.getElementById("auth-card").hidden = true;
      render();
    } catch (error) {
      loading.hidden = false;
      loading.textContent = error.message;
      document.getElementById("auth-card").hidden = false;
    }
  }

  async function showDetails(order) {
    const claimData = claimPackage(order);
    const sender = claimData.sender || {};
    const item = claimData.order || {};
    const fields = [
      ["Seller account", order.accountName || order.accountId], ["Marketplace", order.marketplaceId],
      ["Tracking state", labelFor(order.trackingState)], ["Tracking number", order.trackingNumber],
      ["Carrier", order.carrierLabel || order.carrierId], ["Last checked", dateTime(order.checkedAt)],
      ["Recipient", order.recipientName], ["Destination", [order.recipientAddress1, order.recipientAddress2, order.recipientPostalCode, order.recipientCity, order.recipientCountry].filter(Boolean).join(", ")],
      ["Sender", [sender.companyName, sender.contactFirstName, sender.contactLastName].filter(Boolean).join(" ")],
      ["Sender contact", [sender.email, sender.phone].filter(Boolean).join(" · ")],
      ["Item", [item.productName || order.productName, item.asin, item.sku, item.quantity ? `Qty ${item.quantity}` : "", item.itemValue || order.itemValue].filter(Boolean).join(" · ")],
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

  document.getElementById("auth-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.token = document.getElementById("admin-token").value.trim();
    sessionStorage.setItem("carrierMonitorAdminToken", state.token);
    load();
  });
  if (state.token) {
    document.getElementById("admin-token").value = state.token;
    load();
  }
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
    state.view = tab.dataset.view;
    render();
  }));
  document.getElementById("search").addEventListener("input", (event) => { state.query = event.target.value; render(); });
  document.getElementById("account-filter").addEventListener("change", (event) => { state.accountId = event.target.value; render(); });
  document.getElementById("refresh").addEventListener("click", load);
  document.getElementById("add-browser").addEventListener("click", async (event) => {
    if (!state.token) return notify("Connect the dashboard first.");
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
    const recordId = button.dataset.detail || button.dataset.resolve || button.dataset.reopen || button.dataset.launchClaim;
    const order = state.orders.find((item) => item.recordId === recordId);
    if (!order) return;
    if (button.dataset.detail) return showDetails(order);
    button.disabled = true;
    try {
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
      if (button.dataset.launchClaim) {
        const claimData = claimPackage(order);
        const reason = prompt("Claim reason: lost, returned, delayed, damaged, delivered_missing, or other", order.claimReason !== "none" ? order.claimReason : order.trackingState === "returning" ? "returned" : "lost");
        if (!reason) return;
        const details = prompt("Review or edit the claim message", claimData.details || order.claimTitle || order.statusText || "");
        if (!details) return;
        const isLaPoste = !/chrono/i.test(order.carrierId || order.carrierLabel);
        const recipientTitle = isLaPoste ? prompt("Recipient title required by La Poste (Monsieur or Madame)", claimData.recipientTitle || "") : claimData.recipientTitle || "";
        if (isLaPoste && !recipientTitle) return;
        const claimWindow = window.open("about:blank", "_blank");
        const launch = await api(`/api/orders/${encodeURIComponent(recordId)}/launch-claim`, {
          method: "POST",
          body: JSON.stringify({ reason, details, recipientTitle })
        });
        if (!claimWindow) throw new Error("Allow pop-ups for this dashboard, then try again.");
        claimWindow.opener = null;
        claimWindow.location.href = launch.url;
        notify(`${launch.carrier === "chronopost" ? "Chronopost" : "La Poste"} claim opened in the paired extension.`);
      }
      await load();
    } catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  });

  setInterval(() => { if (state.token) load(); }, 300000);
})();
