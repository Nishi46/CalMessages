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
  // Minimal starter copy for the transitions 09 §C step 11-13 add — macros
  // only, no per-item breakdown or running daily total yet. 09 §F step 25
  // is where these get expanded to the full Build Spec §4.2/§4.3 replies.
  meal_logged: 'Logged: {calories} cal, {protein}g protein, {carbs}g carbs, {fat}g fat.',
  meal_clarifying_question: "Got a partial read — {confidenceNote} What was it, roughly?",
  correction_confirmed:
    'Updated — that entry is now {calories} cal, {protein}g protein, {carbs}g carbs, {fat}g fat.',
  correction_disambiguation: 'I found a few recent entries that could match — which one did you mean?',
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
