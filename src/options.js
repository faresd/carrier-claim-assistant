"use strict";

const form = document.getElementById("settings-form");
const status = document.getElementById("status");

function monitorOrigin(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? `${url.origin}/*` : "";
  } catch {
    return "";
  }
}

chrome.storage.local.get(["senderProfile", "claimSettings"]).then(({ senderProfile = {}, claimSettings = {} }) => {
  for (const [key, value] of Object.entries(senderProfile)) {
    if (form.elements[key]) form.elements[key].value = value || "";
  }
  for (const [key, value] of Object.entries(claimSettings)) {
    const control = form.elements[key];
    if (!control) continue;
    if (control.type === "checkbox") control.checked = Boolean(value);
    else control.value = value;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const senderProfile = Object.fromEntries(
    ["email", "phone", "senderType", "contactTitle", "contactFirstName", "contactLastName", "companyName", "address1", "address2", "postalCode", "city", "country"]
      .map((key) => [key, data.get(key) || ""])
  );
  const claimSettings = {
    autoStatusCheck: form.elements.autoStatusCheck.checked,
    chronopostStaleHours: Number(data.get("chronopostStaleHours") || 48),
    laposteOverdueDays: Number(data.get("laposteOverdueDays") || 7),
    cloudSyncEnabled: form.elements.cloudSyncEnabled.checked,
    monitorServerUrl: String(data.get("monitorServerUrl") || "").trim().replace(/\/$/, ""),
    monitorAccessToken: String(data.get("monitorAccessToken") || "").trim(),
    pickupNotifications: form.elements.pickupNotifications.checked
  };
  if (claimSettings.cloudSyncEnabled) {
    const origin = monitorOrigin(claimSettings.monitorServerUrl);
    if (!origin || !claimSettings.monitorAccessToken) {
      status.textContent = "Enter a secure server URL and sync token.";
      return;
    }
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      status.textContent = "Server access was not granted.";
      return;
    }
  }
  await chrome.storage.local.set({ senderProfile, claimSettings });
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 2500);
});

document.getElementById("test-monitor").addEventListener("click", async () => {
  status.textContent = "Testing…";
  const origin = monitorOrigin(form.elements.monitorServerUrl.value);
  if (!origin || !await chrome.permissions.request({ origins: [origin] })) {
    status.textContent = "Server access was not granted.";
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "TEST_MONITOR_CONNECTION",
    serverUrl: form.elements.monitorServerUrl.value.trim(),
    token: form.elements.monitorAccessToken.value.trim()
  }).catch((error) => ({ ok: false, error: error.message }));
  status.textContent = response?.ok ? "Monitor connected" : response?.error || "Connection failed";
});

document.getElementById("pair-monitor").addEventListener("click", async () => {
  const serverUrl = form.elements.monitorServerUrl.value.trim();
  const code = form.elements.monitorPairingCode.value.trim();
  const origin = monitorOrigin(serverUrl);
  if (!origin || !/^\d{6}$/.test(code)) {
    status.textContent = "Enter the monitor URL and six-digit code.";
    return;
  }
  if (!await chrome.permissions.request({ origins: [origin] })) {
    status.textContent = "Server access was not granted.";
    return;
  }
  status.textContent = "Pairing…";
  const response = await chrome.runtime.sendMessage({ type: "PAIR_MONITOR_DEVICE", serverUrl, code })
    .catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    status.textContent = response?.error || "Pairing failed";
    return;
  }
  const stored = await chrome.storage.local.get("claimSettings");
  form.elements.monitorAccessToken.value = stored.claimSettings?.monitorAccessToken || "";
  form.elements.cloudSyncEnabled.checked = true;
  form.elements.pickupNotifications.checked = true;
  status.textContent = "Browser connected";
});

document.getElementById("open-monitor").addEventListener("click", () => {
  const serverUrl = form.elements.monitorServerUrl.value.trim();
  if (!monitorOrigin(serverUrl)) {
    status.textContent = "Enter the monitor server URL first.";
    return;
  }
  chrome.tabs.create({ url: serverUrl });
});
