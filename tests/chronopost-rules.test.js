"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  objectForReason,
  motiveTermsForReason,
  matchingOptionValue,
  productFamily
} = require("../src/shared/chronopost-rules.js");

test("maps claim reasons to the live Chronopost Pro object taxonomy", () => {
  assert.equal(objectForReason("delivered_missing"), "CL");
  assert.equal(objectForReason("lost"), "PC");
  assert.equal(objectForReason("damaged"), "LP");
  assert.equal(objectForReason("returned"), "RE");
});

test("selects a matching dynamic Chronopost motive", () => {
  const options = [
    { value: "", textContent: "Sélectionnez un motif..." },
    { value: "M1", textContent: "Colis non livré / introuvable" }
  ];
  assert.equal(matchingOptionValue(options, motiveTermsForReason("lost")), "M1");
});

test("maps common Amazon products to Chronopost product families", () => {
  assert.equal(productFamily("Lenovo ThinkPad USB-C Dockingstation"), "F2");
  assert.equal(productFamily("iPhone 15"), "F5");
  assert.equal(productFamily("Unclassified merchandise"), "F1");
});
