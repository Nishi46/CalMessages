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

  // --- Proactive check-in (Sprint 5 §E) ---
  // Build Spec §4.4's sample transcript, verbatim — short, specific, easily
  // ignored. No streak count, no "you missed," no cross-user comparison, per
  // §5's guardrail table: "No streaks framed as something lost, no guilt
  // language, no comparison to other users. A skipped day is never
  // referenced as a failure." This is the first template that rule actually
  // applies to — Sprint 7's safety guardrail treats template review as the
  // enforcement mechanism for it, so any future edit here needs the same
  // scrutiny, not just a tone pass.
  proactive_checkin: "How'd dinner go tonight?",

  // --- Free-tier paywall (Sprint 6 §B step 9, §C step 11) ---
  // Build Spec §4.6's example transcript, minus the "you've been at this for
  // N days" personalization — that needs a days-since-signup computation
  // that isn't otherwise needed anywhere in the checkout flow, so it's left
  // for a later copy pass rather than added just for this line.
  paywall: "You've used all your free logs. $9.99/mo keeps it going, no app required: {checkoutLink}",
  // --- Checkout confirmation (Sprint 6 §C step 13) ---
  // Build Spec §4.6 step 3: "resume exactly where the thread left off — no
  // re-onboarding, no re-confirmation [beyond this one text]." Deliberately
  // says nothing else — the very next meal photo should just work.
  checkout_confirmed: "You're all set — logging is back on. Send your next meal whenever you're ready.",

  // --- Pause/resume (Sprint 7 §A step 1, Build Spec §4.7) ---
  // A statement, not a question — same posture Build Spec §4.7 requires for
  // the delete confirmation. Logging still works while paused (step 2), so
  // this says so rather than implying the thread goes silent.
  pause_confirmed:
    "Nudges are paused — I won't check in until you text \"resume.\" Logging still works anytime you text in.",
  resume_confirmed: "Nudges are back on. Send your next meal whenever you're ready.",

  // --- Delete (Sprint 7 §B step 6, Build Spec §4.7 step 3) ---
  // A statement, confirmed once — "never re-prompted or talked out of" rules
  // out a confirmation question ("are you sure?") entirely, not just a
  // second one.
  delete_account_confirmed:
    "Got it — your data will be permanently deleted within 30 days, and I won't text you again after this.",

  // --- Safety guardrail (Sprint 7 §D step 12, §E step 15) ---
  // NOT PRODUCT-REVIEWED. The exact copy here — tone, phrasing, which
  // resource(s) to list, whether 988 (the real US 988 Suicide & Crisis
  // Lifeline, call or text) is the right/only resource for this product's
  // audience — is exactly the "real decision the source docs don't make for
  // you" that §E step 15 flags, same posture as step 12's keyword-list
  // disclaimer in safetyGuardrailPattern.ts. This exists so §D's transition
  // has a real reply to send rather than shipping silence on a safety flag,
  // not because the copy itself has been reviewed. Deliberately no macros,
  // no meal-logging language, no question — a caring statement, same "never
  // re-prompted or talked out of" posture as delete_account_confirmed.
  care_pause_entered:
    "I noticed something in your last message that concerned me, so I've paused check-ins for now. " +
    "If you're struggling, the 988 Suicide & Crisis Lifeline (call or text 988) is available 24/7. " +
    "You can still text me anytime.",
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
