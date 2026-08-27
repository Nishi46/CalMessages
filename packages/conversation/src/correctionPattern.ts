// Keyword/phrase list per Build Spec §4.3's correction examples ("that was",
// "actually", "undo", "delete that", "no it was") — same posture as
// onboardingAnswers.ts's goal keyword classifier: no NLU, and any ambiguous
// case is left to default to `meal_content` (09 §C step 9) so a real meal
// log is never misclassified as a correction.
const CORRECTION_PATTERNS: RegExp[] = [
  /\bthat was\b/i,
  /\bactually\b/i,
  /\bundo\b/i,
  /\bdelete that\b/i,
  /\bno,? it was\b/i,
];

export function isCorrectionText(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// "Delete that" with no replacement value resolves differently from a
// value-replacement correction — it calls softDeleteMealLog instead of
// writeCorrection (09 §E step 23). Checked before the general correction
// match, so callers must consult this first. "undo" is grouped here rather
// than under the general correction patterns above — it only makes sense as
// a request to remove the last entry, not to supply a replacement value.
const DELETE_PATTERNS: RegExp[] = [/\bdelete that\b/i, /\bundo\b/i];

export function isDeleteText(text: string): boolean {
  return DELETE_PATTERNS.some((pattern) => pattern.test(text));
}
