// Plain string templates matching the tone of the Build Spec §4.1 sample
// transcript (09 §F step 26). No i18n, no copy branching beyond var
// interpolation, no freely generated reply text anywhere in the codebase —
// every outbound message renders through one of these, which is what lets
// Sprint 7's safety-guardrail requirement (a reviewed template set) hold.
export const TEMPLATES = {
  // --- Onboarding (Sprint 2) ---
  onboarding_welcome_q1:
    "Hey — I'm Tally. Text me a photo of what you eat and I'll text back the calories and macros. Three quick questions to set your target, then you're logging. What's the goal — lose weight, maintain, gain, or just hit a protein number?",
  onboarding_q2:
    "Got it. Roughly what's your current weight, and do you have a protein target from your provider, or should I suggest one?",
  onboarding_q3: 'Last one — did a coach or clinic refer you? If not, just say no.',
  onboarding_goal_confirmation:
    'I\'ll set you at {dailyCalories} cal and {dailyProtein}g protein a day — easy to change anytime, just text "change my goal." Send me a photo of your next meal whenever you\'re ready.',

  // --- Meal logging fast path (Sprint 4 §D) ---
  // Macros, an optional per-item breakdown ('' when there's only one item —
  // step 17, Build Spec §4.2: "break the reply out by item... so a later
  // correction can target one item"), and the running daily total against
  // the user's goal (09 §A step 2's own forward reference to this exact
  // line).
  meal_logged:
    'Logged: {calories} cal, {protein}g protein, {carbs}g carbs, {fat}g fat.{itemBreakdown}\n\nToday: {todayCalories}/{goalCalories} cal so far.',
  // Never both a guess and a hedge in the same reply (Build Spec §4.2) — no
  // macros here, just the one clarifying question. {confidenceNote} carries
  // its own leading " — " when a specific note is available (step 25); the
  // caller passes '' otherwise (no producer sets MealCandidate.confidenceNote
  // yet), so this still reads as one clean sentence either way.
  meal_clarifying_question: 'Got a partial read{confidenceNote}. What was it, roughly?',
  // Terminal — isFood: false never reaches the confidence scorer, so these
  // two are the reply, not a transition (step 16). unassessable offers a
  // retake or a one-line description, per Build Spec §4.2; non_food doesn't,
  // since there's nothing to retake.
  meal_non_food: "That doesn't look like food to me, so I didn't log anything. Send a photo whenever you're ready.",
  meal_unassessable:
    "Couldn't quite make that out — mind sending a clearer photo, or just describing what it was?",
  // Sent immediately when the recognize()/parse() call is slow or fails
  // outright (step 20, Architecture §7's "never silently drop an inbound
  // photo") — the log itself completes once the call actually resolves.
  meal_holding_reply_photo: 'Got your photo, one sec...',
  meal_holding_reply_text: 'Got it, one sec...',

  // --- Correction / edit resolution (Sprint 4 §E) ---
  // "Total for that day" (dayCalories) is the corrected/deleted entry's own
  // date, not today's — they only differ when the correction referenced a
  // prior day (step 24, Build Spec §4.3).
  correction_confirmed:
    'Updated — that entry is now {calories} cal, {protein}g protein, {carbs}g carbs, {fat}g fat. Total for that day is now {dayCalories} cal.',
  delete_confirmed: 'Deleted. Total for that day is now {dayCalories} cal.',
  correction_disambiguation: 'I found a few recent entries that could match — which one did you mean?',
  // resolveCorrectionTarget finding zero plausible matches (§E step 22) is
  // itself terminal, same shape as meal_content's isFood: false path — a
  // reply, not a transition, so there's nothing to hold or ask next.
  correction_not_found: "I couldn't find anything recent to correct.",
} as const satisfies Record<string, string>;

export type TemplateId = keyof typeof TEMPLATES;

// Missing vars leave the {placeholder} untouched rather than throwing — a
// malformed confirmation message is a more debuggable failure than a crashed
// onboarding reply.
export function renderTemplate(
  templateId: TemplateId,
  vars: Record<string, string | number> = {},
): string {
  return TEMPLATES[templateId].replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
