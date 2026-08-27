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
