// ============================================================================
// NOT PRODUCT-REVIEWED. DO NOT SHIP WITHOUT SIGN-OFF.
// ============================================================================
// 12 §D step 12, verbatim from the sprint breakdown: "Needs sign-off, not an
// engineering guess... The actual keyword/phrase list is a product/clinical
// judgment call — flag explicitly that it needs review from whoever owns
// the product's safety posture before shipping." This file is the mechanism
// (a pattern list + a match function) so the rest of §D's wiring has
// something real to call — the list below is a conservative engineering
// placeholder, not a reviewed clinical instrument. Whoever owns Tally's
// safety posture needs to review/replace this list — including whether it's
// even the right *mechanism* (a static keyword list has real limits: it
// misses paraphrase and indirect language, and low-effort tests below show
// it also over-fires on hyperbole) — before this ships to real users.
//
// Tuned toward high false-positive tolerance per 04 §11: "the cost of a
// missed flag is categorically worse than an unnecessary care-toned reply."
// That means erring toward matching too much, not too little — the
// resulting false-positive rate on ordinary hyperbolic speech ("this diet
// is killing me") is an accepted, deliberate cost, not an oversight.
const FLAGGED_LANGUAGE_PATTERNS: RegExp[] = [
  /\b(kill|hurt|harm) myself\b/i,
  /\bsuicid(e|al)\b/i,
  /\b(want|going|plan) to die\b/i,
  /\bend(ing)? my (own )?life\b/i,
  /\bself[\s-]?harm(ing)?\b/i,
  /\bnot worth living\b/i,
  /\bbetter off dead\b/i,
  /\bno reason to (live|go on)\b/i,
];

export function isFlaggedLanguage(text: string): boolean {
  return FLAGGED_LANGUAGE_PATTERNS.some((pattern) => pattern.test(text));
}
