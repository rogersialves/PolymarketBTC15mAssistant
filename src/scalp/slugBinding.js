import { btcUpDownSlugFamily } from "../data/polymarket.js";
import { SLUG_FAMILY_BTC_UPDOWN_5M, SLUG_FAMILY_BTC_UPDOWN_15M } from "./strategyGraph.js";

const SCALP_15M_NAME = "Scalp Force 15m";

export function defaultSlugFamiliesForIndicator(indicatorName) {
  return indicatorName === SCALP_15M_NAME
    ? [SLUG_FAMILY_BTC_UPDOWN_15M]
    : [SLUG_FAMILY_BTC_UPDOWN_5M];
}

export function normalizeSlugFamilies(arr, indicatorName) {
  const allowed = new Set([SLUG_FAMILY_BTC_UPDOWN_5M, SLUG_FAMILY_BTC_UPDOWN_15M]);
  if (!Array.isArray(arr) || arr.length === 0) return defaultSlugFamiliesForIndicator(indicatorName);
  const out = [...new Set(arr.map(String).filter(x => allowed.has(x)))];
  return out.length ? out : defaultSlugFamiliesForIndicator(indicatorName);
}

/** Scalp Force 5m ↔ apenas `btc-updown-5m`; Scalp Force 15m ↔ apenas `btc-updown-15m`. */
export function coerceScalpBindingFamilies(indicatorName) {
  return indicatorName === SCALP_15M_NAME
    ? [SLUG_FAMILY_BTC_UPDOWN_15M]
    : [SLUG_FAMILY_BTC_UPDOWN_5M];
}

/** Non–BTC-window slugs are not gated (legacy behaviour). */
export function marketSlugAllowedForScalpBinding(marketSlug, indicatorName) {
  const fam = btcUpDownSlugFamily(marketSlug);
  if (fam === null) return true;
  const families = coerceScalpBindingFamilies(indicatorName);
  return families.includes(fam);
}
