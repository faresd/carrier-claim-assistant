"use strict";
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.storage.local.get("claimSettings").then(({ claimSettings = {} }) => {
  const connected = claimSettings.cloudSyncEnabled && claimSettings.monitorServerUrl && claimSettings.monitorAccessToken;
  document.getElementById("connection").textContent = connected ? "Return monitor connected" : "Return monitor not paired";
  document.getElementById("dashboard").disabled = !connected;
  document.getElementById("dashboard").addEventListener("click", () => chrome.tabs.create({ url: claimSettings.monitorServerUrl }));
});
document.getElementById("refresh").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: "REFRESH_MONITOR_ALERTS" }).catch(() => null);
  document.getElementById("connection").textContent = response?.ok
    ? response.skipped ? "Return monitor not configured" : `${response.count || 0} new pickup alert(s)`
    : "Could not reach return monitor";
  event.currentTarget.disabled = false;
});
