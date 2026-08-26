# Tally — Sprint 2 Breakdown
### Technical Design Doc 07 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 2 (Conversation engine) from 05 — Sprint Plan. Each step traces back to 04 — Technical Implementation §6.1 (state machine) and §14 (testing strategy) — the sprint's own Ref column.

**Prepared:** 26 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

---

## Scope note

Sprint 2's Ref is `04 §6.1, §14` only — not §6.2 (timeout-driven transitions) or §6.3 (correction routing). Those ship later: §6.2's delayed-job mechanism rides on the queue infrastructure that Sprint 5 (Scheduler) builds, and §6.3 (correction routing) is explicitly listed under Sprint 4. This sprint also only wires the slice of the §6.1 state table the Sprint Plan names as this sprint's Ships: `new` → `onboarding_q1/q2/q3` → `idle`. The lookup table's *shape* covers the full state enum from `apps/api/src/lib/router.ts`'s existing seam so later sprints add rows instead of restructuring types, but `awaiting_clarification`, `awaiting_checkout`, `paused`, `care_pause`, and `deleted` get their transitions in Sprints 4, 6, 7 respectively — this sprint proves they fall through to the safe fallback, nothing more.

The Build Spec §4.1 edge case "user doesn't respond to question 2 or 3" (stall follow-up) is real product behavior but depends on the not-yet-built delayed-job mechanism — deferred to whichever sprint wires §6.2, not silently dropped.

---

## A. State machine types & lookup table (04 §6.1)

1. In `packages/conversation`, define the `ConversationState` union covering all eight §6.1 states (`new`, `onboarding_q1`, `onboarding_q2`, `onboarding_q3`, `idle`, `awaiting_clarification`, `awaiting_checkout`, `paused`, `care_pause`, `deleted`), even though only five are reachable this sprint.
2. Define a `Trigger` union scoped to what this sprint needs to classify: `first_contact`, `onboarding_answer`, plus one generic `unhandled` trigger used only to exercise the fallback path in tests.
3. Define a `SideEffect` discriminated union as pure data, not executed inline: `{ type: 'sendReply', template, vars }`, `{ type: 'mergeContext', patch }`, `{ type: 'createGoal', defaults }`. Keeping side effects as data (not functions) is what makes the lookup table itself unit-testable without mocking I/O.
4. Define the `Transition` shape (`{ toState: ConversationState, sideEffects: SideEffect[] }`) and build the lookup table keyed by `` `${fromState}:${trigger}` ``, seeded with exactly the four transitions this sprint ships: `new:first_contact`, `onboarding_q1:onboarding_answer`, `onboarding_q2:onboarding_answer`, `onboarding_q3:onboarding_answer`.
5. Implement `resolveTransition(fromState, trigger): Transition` — looks up the table and returns a defined `FALLBACK_TRANSITION` sentinel (same state, no side effects) on any miss. Must never throw on an unrecognized pair; that's the whole point of the safe-fallback contract in §14.

## B. Onboarding trigger classification

6. Classifier for state `new`: any inbound message (text or photo, don't care which) on a user whose `conversationState === 'new'` resolves to trigger `first_contact` — no NLU, just "is this the first message from this row."
7. Answer capture for `onboarding_q1` (goal): store the raw text verbatim in `conversationContext.rawGoalAnswer`; map to `goalType: 'lose' | 'maintain' | 'gain' | 'protein_only'` via a small keyword list (`lose`/`cut`/`glp1` → `lose`, `gain`/`bulk` → `gain`, `protein` → `protein_only`), defaulting to `maintain` on no match — mirrors the Build Spec §4.1 edge-case posture of never blocking on an unparseable answer.
8. Answer capture for `onboarding_q2` (starting point): store the raw text verbatim in `conversationContext.rawStartingPoint`. No weight/number parsing this sprint — the capture is just the string; `computeDefaultGoal` (step 12) consumes it as opaque input for now.
9. Answer capture for `onboarding_q3` (referral): store the raw text verbatim in `conversationContext.rawReferral`. Blank or unrecognized input is treated as organic signup, never a gate, per the Build Spec §4.1 edge case.

## C. Side effects & templates

10. Write the four reply templates (welcome+Q1, Q2, Q3, goal confirmation) as plain string templates matching the tone of the Build Spec §4.1 transcript. No i18n, no branching copy beyond the interpolated goal numbers in the confirmation message.
11. Implement `computeDefaultGoal(goalType, rawStartingPoint): { dailyCalories, dailyProtein }` as a pure function returning a fixed placeholder formula per goal type (e.g. flat calorie/protein defaults per `goalType`, ignoring `rawStartingPoint` for now). Mark clearly in a comment that this is a placeholder pending a real nutrition formula — the state machine ships without waiting on that formula, same pattern as the Sprint 1 router stub.
12. Implement the side-effect interpreter `applySideEffects(effects, deps)` where `deps` is an injected `{ sendReply, mergeContext, createGoal }` — each a thin wrapper the caller supplies, so the interpreter is testable against fakes without touching Twilio or Postgres.
13. Wire the `onboarding_q3:onboarding_answer` transition's side effects to include `createGoal` (using `computeDefaultGoal`) before `sendReply`, so the confirmation message can interpolate the numbers it just created.

## D. Wiring into the existing router seam

14. Replace the no-op body of `handleInboundMessage` in `apps/api/src/lib/router.ts` with: classify trigger from `payload.currentState` (+ text/photo presence) → `resolveTransition` → `applySideEffects`.
15. On a resolved transition, persist the new state via the existing `updateUserState(userId, conversationState, conversationContext)` from `packages/db-consumer` — merge the transition's `mergeContext` patch onto the user's existing `conversationContext` rather than overwriting it.
16. Inject the real `sendReply` dependency as a thin adapter over the existing `sendMessage()` from `packages/messaging`, and the real `createGoal` dependency as a new minimal `createGoal(userId, defaults)` query function in `packages/db-consumer` (insert into the already-migrated `goal` table, `source = 'self'`).
17. Update `TwilioInboundDeps`/route wiring in `apps/api/src/routes/twilio-inbound.ts` only if the new dependencies need threading through — confirm the existing `handleInboundMessage` injection point is sufficient before touching the route file.

## E. Tests (04 §14)

18. Table-driven test: iterate every `{state, trigger}` pair actually present in the lookup table, asserting the exact `{toState, sideEffects}` returned by `resolveTransition`.
19. Fallback test: assert `resolveTransition` returns `FALLBACK_TRANSITION` (never throws) for a representative sample of undefined pairs — at minimum one per not-yet-wired state (`idle:onboarding_answer`, `paused:first_contact`, `care_pause:first_contact`, `deleted:onboarding_answer`) plus a totally nonsense pair.
20. Unit tests for each onboarding classifier: q1 keyword matches for all four goal types plus the no-match default; q2/q3 verbatim capture; q3 blank-input organic-signup case.
21. Unit tests for `computeDefaultGoal` covering all four goal types.
22. Interpreter test: given a fake `deps` object, assert `applySideEffects` calls `mergeContext`, `createGoal`, and `sendReply` in the right order with the right arguments for the `onboarding_q3 → idle` transition specifically (the one with all three effect types).
23. End-to-end walk test against `handleInboundMessage` with faked `sendMessage`/db functions: four inbound messages in sequence (first contact, three answers) → assert the four expected outbound replies, final `conversationState === 'idle'`, and one `goal` row created with the placeholder numbers.

## F. Sprint-close verification

24. Manual test: text the dev Twilio number from a phone number with no existing `user` row, answer all three onboarding questions, confirm the four expected replies arrive in order ending with the photo invitation.
25. Check A2P 10DLC registration status (filed in Sprint 0, ~1–3 week window) — this is the sprint the Sprint Plan flags for that check-in; note whether it's cleared or still at risk of slipping Sprint 8.
26. Deploy to `staging` and repeat the manual cold-onboarding test there before calling the sprint done.

> **Status as of 26 Aug 2026 — all three blocked, Sprint 2 cannot be closed yet:**
> - **24** — Not run. Local API server + ngrok tunnel were prepared, but the Console webhook step needs a deliberate follow-up session; also see the caveat below.
> - **25** — Worse than "at risk": **no A2P registration has been filed.** The Twilio account is still Trial tier, and Twilio's A2P Brand Registration API explicitly refuses Trial accounts (`"not available on a Trial account. Please upgrade"`, error 20003). The Sprint 0 assumption that this was already filed was wrong.
> - **26** — No staging environment exists. `infra/README.md`'s "staging environment" step is unprovisioned — there is nowhere to deploy to yet.
> - **New finding, relevant to interpreting 24 once it runs:** confirmed live (both raw API and via the app's `twilio` SDK client) that this Trial-tier number silently overrides *any* outbound message body with a canned "Appointment Reminders" template — this is Twilio's trial anti-spam guardrail, separate from A2P. Until the account is upgraded and/or A2P-registered, the real onboarding reply copy will not reach a test phone even after the webhook is wired up — a "test passed" result would need to be read with that in mind.

---
*Tally — Technical Design Doc 07 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown*
