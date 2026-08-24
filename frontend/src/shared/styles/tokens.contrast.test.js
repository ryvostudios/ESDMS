import { describe, test, expect } from "vitest";

// ADV-P2-01 (round 2): #eef2f5 (--eset-light, the actual page/card
// background these tokens sit on in Governance rows, KPI cards, etc.) is a
// real surface, not just white — a token that only clears WCAG against
// white can still fail in practice. This is deliberately the smallest
// possible check: one inline luminance function, three token values, no
// framework.
function relativeLuminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
  const linear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(hexA, hexB) {
  const [l1, l2] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

const WHITE = "#ffffff";
const PAGE_BG = "#eef2f5"; // --eset-light / --color-bg

describe("ADV-P2-01: accessible token contrast against both white and the page background", () => {
  test("--eset-cyan-accessible (--color-focus-ring) clears 3:1 non-text contrast against white and #eef2f5", () => {
    const focusRing = "#008eb2";
    expect(contrast(focusRing, WHITE)).toBeGreaterThanOrEqual(3);
    expect(contrast(focusRing, PAGE_BG)).toBeGreaterThanOrEqual(3);
  });

  test("--eset-grey (--color-text-muted) clears 4.5:1 normal-text contrast against white and #eef2f5", () => {
    const mutedText = "#616a74";
    expect(contrast(mutedText, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mutedText, PAGE_BG)).toBeGreaterThanOrEqual(4.5);
  });

  test("--eset-blue-ink (--color-primary / links) clears 4.5:1 normal-text contrast against white and #eef2f5", () => {
    const primary = "#0673a0";
    expect(contrast(primary, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(primary, PAGE_BG)).toBeGreaterThanOrEqual(4.5);
  });
});
