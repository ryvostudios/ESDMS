import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePrices } from "../src/modules/procurement/price-comparison.js";

test("price comparison is exact and never uses floating point", () => {
  assert.deepEqual(comparePrices({ estimatedUnitPrice: "112.50", previousUnitPrice: "100.00" }), {
    difference: "12.50",
    percentageDifference: "12.50",
    direction: "INCREASE",
  });

  assert.deepEqual(comparePrices({ estimatedUnitPrice: "85.00", previousUnitPrice: "100.00" }), {
    difference: "-15.00",
    percentageDifference: "-15.00",
    direction: "DECREASE",
  });

  assert.deepEqual(comparePrices({ estimatedUnitPrice: "100.00", previousUnitPrice: "100.00" }), {
    difference: "0.00",
    percentageDifference: "0.00",
    direction: "SAME",
  });

  // 0.1 + 0.2 style drift is impossible here: these are integer minor units.
  assert.equal(comparePrices({ estimatedUnitPrice: "0.30", previousUnitPrice: "0.10" }).difference, "0.20");

  // Repeating ratio, rounded half away from zero at two decimals.
  assert.equal(
    comparePrices({ estimatedUnitPrice: "10.00", previousUnitPrice: "3.00" }).percentageDifference,
    "233.33",
  );
  assert.equal(
    comparePrices({ estimatedUnitPrice: "2.00", previousUnitPrice: "3.00" }).percentageDifference,
    "-33.33",
  );

  // Large values stay exact where a float would already have lost precision.
  assert.equal(
    comparePrices({ estimatedUnitPrice: "999999999.99", previousUnitPrice: "999999999.98" }).difference,
    "0.01",
  );
});

test("no previous purchase is reported as absent, never as zero", () => {
  assert.equal(comparePrices({ estimatedUnitPrice: "100.00", previousUnitPrice: null }), null);
  assert.equal(comparePrices({ estimatedUnitPrice: "100.00", previousUnitPrice: undefined }), null);
  assert.equal(comparePrices({ estimatedUnitPrice: "100.00", previousUnitPrice: "0.00" }), null);
  assert.equal(comparePrices({ estimatedUnitPrice: null, previousUnitPrice: "100.00" }), null);
  assert.equal(comparePrices({ estimatedUnitPrice: "abc", previousUnitPrice: "100.00" }), null);
});
