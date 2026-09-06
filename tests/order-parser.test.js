"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOrderDetails, destinationLines, enrichSellerContext } = require("../src/shared/order-parser.js");

const AMAZON_ORDER_TEXT = `
Order details  Order ID: # 111-2222222-3333333
Purchase date
Thu, 16 Jul 2026, 12:30 CEST
Ship to
Arne Beispiel
Musterstraße 10
Berlin
10115
Germany
Address Type: Residential
Order contents
Shipped
Example Bluetooth Headset
ASIN: B000000000
SKU: EXAMPLE-SKU
Condition: New
1 €171.43 €204.00
Item subtotal:
€204.00
Package 1
Ship date
Fri, 17 Jul 2026
Shipping Carrier
Colissimo
Tracking ID
CC000000002FR
Shipping service
COLISSIMO Livraison a domicile sans signature
`;

test("extracts the claim fields from an Amazon Seller order", () => {
  const order = parseOrderDetails(AMAZON_ORDER_TEXT, "https://sellercentral.amazon.fr/orders-v3/order/example");
  assert.deepEqual(
    order,
    {
      sourceUrl: "https://sellercentral.amazon.fr/orders-v3/order/example",
      orderId: "111-2222222-3333333",
      trackingNumber: "CC000000002FR",
      orderDate: "Thu, 16 Jul 2026, 12:30 CEST",
      shipDate: "Fri, 17 Jul 2026",
      deliverBy: "",
      carrier: "Colissimo",
      shippingService: "COLISSIMO Livraison a domicile sans signature",
      itemValue: "€204.00",
      quantity: "1",
      sellerAccountId: "sellercentral.amazon.fr",
      sellerAccountName: "Seller Central account",
      marketplaceId: "A13V1IB3VIYZZH",
      recipientName: "Arne Beispiel",
      recipientAddress1: "Musterstraße 10",
      recipientAddress2: "",
      recipientCity: "Berlin",
      recipientPostalCode: "10115",
      recipientCountry: "Germany",
      productName: "Example Bluetooth Headset",
      asin: "B000000000",
      sku: "EXAMPLE-SKU"
    }
  );
  assert.deepEqual(destinationLines(order, "Allemagne"), [
    "Arne Beispiel",
    "Musterstraße 10",
    "10115 Berlin",
    "Allemagne"
  ]);
});

test("keeps Amazon merchant and marketplace context for multi-account history", () => {
  const order = parseOrderDetails(
    AMAZON_ORDER_TEXT,
    "https://sellercentral.amazon.fr/orders-v3/order/111-2222222-3333333?mons_sel_mcid=amzn1.merchant.o.ACCOUNT123&mons_sel_mkid=amzn1.mp.o.A13V1IB3VIYZZH"
  );
  assert.equal(order.sellerAccountId, "amzn1.merchant.o.ACCOUNT123");
  assert.equal(order.marketplaceId, "amzn1.mp.o.A13V1IB3VIYZZH");
});

test("captures the current Seller Central account switcher name", () => {
  const header = { innerText: "CHRecycle", textContent: "CHRecycle" };
  const root = {
    querySelectorAll: () => [],
    querySelector: (selector) => selector === ".dropdown-account-switcher-header-label-global" ? header : null
  };
  const order = enrichSellerContext({
    sellerAccountId: "amzn1.merchant.o.ACCOUNT123",
    sellerAccountName: "Seller Central account"
  }, root, "https://sellercentral.amazon.fr/orders-v3/order/111-2222222-3333333");

  assert.equal(order.sellerAccountName, "CHRecycle");
});

test("extracts the French Amazon order date label", () => {
  const order = parseOrderDetails(`
Order details Order ID: # 444-5555555-6666666
Date de commande : 2 septembre 2026, 09:15 CEST
Tracking ID
CC000000001FR
  `);
  assert.equal(order.orderDate, "2 septembre 2026, 09:15 CEST");
});

test("fails closed when no tracking number is present", () => {
  assert.equal(parseOrderDetails("Order ID: # 123-1234567-1234567").trackingNumber, "");
});

test("extracts a tracking number from Amazon's edit-consignment label with a colon", () => {
  const order = parseOrderDetails(`
Order details Order ID: # 402-2797047-3010738
Carrier:
Chronopost
Delivery Service:
Chrono Classic
Tracking ID:
8U02230078613
  `);
  assert.equal(order.trackingNumber, "8U02230078613");
});

test("extracts Colissimo international orders with the COLISSIMOS alias", () => {
  const order = parseOrderDetails(`
Order details Order ID: # 444-5555555-6666666
Deliver by: Sat, 15 Aug 2026, 01:00 MEST to Wed, 19 Aug 2026, 00:59 MEST
Ship to
Mary Example
Main Street 1
Dublin
D02XY12
Ireland
Address Type: Residential
Example Wireless Headset
ASIN: B000000001
SKU: EXAMPLE-SKU-2
Item subtotal:
€162.98
Ship date
Mon, 10 Aug 2026
Shipping Carrier
COLISSIMOS
Tracking ID
CC000000001FR
Shipping service
Colissimo international Europe
  `);
  assert.equal(order.trackingNumber, "CC000000001FR");
  assert.equal(order.carrier, "COLISSIMOS");
  assert.equal(order.deliverBy, "Sat, 15 Aug 2026, 01:00 MEST to Wed, 19 Aug 2026, 00:59 MEST");
  assert.equal(order.recipientCountry, "Ireland");
});

test("extracts the address when Amazon omits the Address Type row", () => {
  const order = parseOrderDetails(`
Order details Order ID: # 444-5555555-6666666
Ship to
Mary Example
Main Street 1
Dublin
D02XY12
Ireland
Contact Buyer: Mary
Order contents
Shipping Carrier
COLISSIMOS
Tracking ID
CC000000001FR
  `);
  assert.equal(order.recipientName, "Mary Example");
  assert.equal(order.recipientAddress1, "Main Street 1");
  assert.equal(order.recipientCity, "Dublin");
  assert.equal(order.recipientPostalCode, "D02XY12");
  assert.equal(order.recipientCountry, "Ireland");
});
