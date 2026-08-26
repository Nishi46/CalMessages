// Fallback for providers whose response doesn't directly expose dish category
// or portion-reference signals (08 §C step 9) — deriving these from real
// per-item classification is a per-vendor integration detail that can't be
// specified in the abstract from the source docs, so this is a deliberately
// conservative placeholder rather than a guess dressed up as a heuristic:
// neither default can push the confidence scorer's output higher than a
// provider that stays silent on these signals actually warrants.

export function fallbackDishCategory(): 'packaged' | 'home_cooked' | 'mixed' {
  return 'mixed';
}

export function fallbackHasPortionReference(): boolean {
  return false;
}
