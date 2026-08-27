// Plain string templates matching the tone of the Build Spec §4.1 sample
// transcript. No i18n, no copy branching beyond the interpolated goal
// numbers in the confirmation message.
export const TEMPLATES = {
  onboarding_welcome_q1:
    "Hey — I'm Tally. Text me a photo of what you eat and I'll text back the calories and macros. Three quick questions to set your target, then you're logging. What's the goal — lose weight, maintain, gain, or just hit a protein number?",
  onboarding_q2:
    "Got it. Roughly what's your current weight, and do you have a protein target from your provider, or should I suggest one?",
  onboarding_q3: 'Last one — did a coach or clinic refer you? If not, just say no.',
  onboarding_goal_confirmation:
    'I\'ll set you at {dailyCalories} cal and {dailyProtein}g protein a day — easy to change anytime, just text "change my goal." Send me a photo of your next meal whenever you\'re ready.',
  // Macros, an optional per-item breakdown ('' when there's only one item —
  // 09 §D step 17, Build Spec §4.2: "break the reply out by item... so a
  // later correction can target one item"), and the running daily total
  // against the user's goal (09 §A step 2's own forward reference to this
  // exact line).
  meal_logged:
    'Logged: {calories} cal, {protein}g protein, {carbs}g carbs, {fat}g fat.{itemBreakdown}\n\nToday: {todayCalories}/{goalCalories} cal so far.',
  // Never both a guess and a hedge in the same reply (Build Spec §4.2) — no
  // macros here, just the one clarifying question.
  meal_clarifying_question: 'Got a partial read — {confidenceNote} What was it, roughly?',
  meal_non_food: "That doesn't look like food to me, so I didn't log anything. Send a photo whenever you're ready.",
  meal_unassessable:
    "Couldn't quite make that out — mind sending a clearer photo, or just describing what it was?",
  // Sent immediately when the recognize()/parse() call is slow or fails
  // outright (09 §D step 20, Architecture §7's "never silently drop an
  // inbound photo") — the log itself completes once the call actually
  // resolves.
  meal_holding_reply_photo: "Got your photo, one sec...",
  meal_holding_reply_text: 'Got it, one sec...',
  // "Total for that day" (dayCalories) is the corrected entry's own date,
  // not today's — they only differ when the correction referenced a prior
  // day (09 §E step 24, Build Spec §4.3).
  correction_confirmed:
    'Updated — that entry is now {calories} cal, {protein}g protein, {carbs}g carbs, {fat}g fat. Total for that day is now {dayCalories} cal.',
  delete_confirmed: 'Deleted. Total for that day is now {dayCalories} cal.',
  correction_disambiguation: 'I found a few recent entries that could match — which one did you mean?',
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
