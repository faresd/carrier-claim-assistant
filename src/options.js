"use strict";

const form = document.getElementById("settings-form");
const status = document.getElementById("status");

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
    laposteOverdueDays: Number(data.get("laposteOverdueDays") || 7)
  };
  await chrome.storage.local.set({ senderProfile, claimSettings });
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 2500);
});
