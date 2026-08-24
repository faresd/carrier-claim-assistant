"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOrderDetails, destinationLines } = require("../src/shared/order-parser.js");

const AMAZON_ORDER_TEXT = `
Order details  Order ID: # 111-2222222-3333333
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
      shipDate: "Fri, 17 Jul 2026",
      deliverBy: "",
      carrier: "Colissimo",
      shippingService: "COLISSIMO Livraison a domicile sans signature",
      itemValue: "€204.00",
      quantity: "1",
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

test("fails closed when no tracking number is present", () => {
  assert.equal(parseOrderDetails("Order ID: # 123-1234567-1234567").trackingNumber, "");
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
