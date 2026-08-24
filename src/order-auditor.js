(function initAmazonOrderAuditor() {
  "use strict";

  const marker = location.hash.match(/carrier-claim-order-audit=([^&]+)/);
  if (!marker || window.top !== window) return;

  const parser = globalThis.LaPosteOrderParser;
  const expectedOrderId = location.pathname.match(/\/orders-v3\/order\/([0-9-]+)/i)?.[1] || "";
  const auditId = decodeURIComponent(marker[1]);
  let reported = false;

  async function report(order, error = "") {
    if (reported) return;
    reported = true;
    await chrome.runtime.sendMessage({
      type: "ORDER_AUDIT_DETAILS",
      auditId,
      order,
      error
    });
  }

  const started = Date.now();
  const timer = setInterval(() => {
    const order = parser.parseOrderDetails(document.body.innerText, location.href);
    if (order.orderId === expectedOrderId && order.trackingNumber) {
      clearInterval(timer);
      report(order);
      return;
    }
    if (Date.now() - started >= 20000) {
      clearInterval(timer);
      report(order, order.orderId === expectedOrderId
        ? "No tracking number was found on the order detail page."
        : "Amazon did not finish rendering the requested order details.");
    }
  }, 350);
})();
