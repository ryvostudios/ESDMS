// Exact decimal price comparison. Money never touches JavaScript floats
// (spec §31): both prices arrive as PostgreSQL numeric strings with two
// decimal places, are converted to integer minor units (BigInt), compared
// exactly, and are formatted back to fixed-point strings.
//
// The percentage is the one value that cannot be exact — it is a ratio — so
// it is computed at 2 decimal places with explicit half-away-from-zero
// rounding rather than whatever a float would have produced.

function toMinorUnits(value) {
  const text = String(value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;

  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -minor : minor;
}

function fromMinorUnits(minor) {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? "-" : ""}${whole}.${String(fraction).padStart(2, "0")}`;
}

// numerator/denominator, scaled by `scale`, rounded half away from zero.
function divideRounded(numerator, denominator, scale) {
  if (denominator === 0n) return null;

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = (numerator < 0n ? -numerator : numerator) * scale * 2n;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const doubled = absNumerator / absDenominator;
  const rounded = (doubled + 1n) / 2n;
  return negative ? -rounded : rounded;
}

// Returns null when there is genuinely no prior purchase. Callers must render
// that as "no previous purchase history" — never as a zero price or a 0%
// change, which would falsely assert that the price did not move.
export function comparePrices({ estimatedUnitPrice, previousUnitPrice }) {
  const estimated = toMinorUnits(estimatedUnitPrice);
  const previous = toMinorUnits(previousUnitPrice);

  if (estimated === null || previous === null || previous === 0n) return null;

  const difference = estimated - previous;
  // percentScaled is percent * 100, so 1250n means +12.50%.
  const percentScaled = divideRounded(difference * 100n, previous, 100n);

  return {
    difference: fromMinorUnits(difference),
    percentageDifference: percentScaled === null ? null : fromMinorUnits(percentScaled),
    direction: difference === 0n ? "SAME" : difference > 0n ? "INCREASE" : "DECREASE",
  };
}
