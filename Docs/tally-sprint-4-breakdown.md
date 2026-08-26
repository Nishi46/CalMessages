# Tally — Sprint 4 Breakdown
### Technical Design Doc 09 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 4 (Meal logging fast path) from 05 — Sprint Plan. Each step traces back to 04 — Technical Implementation §5.3 & §6.3 and Architecture §4.1 — the sprint's own Ref column.

**Prepared:** 26 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

---

## Scope note

This sprint assumes Sprint 3's `MealCandidate` / `VisionProvider` / `TextParser` are complete, and builds directly on Sprint 2's state machine plumbing (`packages/conversation`) and Sprint 1's `meal_log` migration (table exists; no query functions against it exist yet). It's the sprint that turns two previously-independent pieces (vision pipeline, conversation router) into one working end-to-end path — expect more cross-file wiring here than in Sprints 2 or 3, including two changes to already-shipped code (§D step 19, and the transaction shape §C step 11 flags).

The lookup table built in Sprint 2 (`transitions.ts`) assumed exactly one `Transition` per `{state, trigger}` key. This sprint introduces the first case where the outcome depends on runtime data — the `MealCandidate.confidence` tier — not just the key. §C step 11 calls out the shape change this requires.

## A. `meal_log` query layer (04 §3.1 — table exists, no queries yet)

1. Add `packages/db-consumer/src/mealLogs.ts`: `createMealLog(userId, candidate, source, localDate)` — inserts `items` (JSONB), `calories`/`protein`/`carbs`/`fat`, `confidence`, `source`, `logged_at`, `local_date`.
2. Add `getRecentMealLogsForUser(userId, { sinceDate })` and `getDailyTotals(userId, localDate)` (sums calories/protein/carbs/fat for `meal_log` where `local_date = X AND soft_deleted_at IS NULL`) — needed for the "Today: 1,180/1,650 cal" line in every full-confidence reply (Build Spec §4.2 example).
3. Add `createCorrection(originalLogId, userId, candidate)` — inserts a new `meal_log` row with `corrected_from_id = originalLogId` and `local_date` copied from the **original** log's date, not today's (Build Spec §4.3 edge case: "recalculates the total for that day, not the current one").
4. Add `softDeleteMealLog(id)` — sets `soft_deleted_at`, backing the "delete that" edge case (Build Spec §4.3).
5. Every new query excludes `soft_deleted_at IS NOT NULL` rows, consistent with the existing `idx_meal_user_date ... WHERE soft_deleted_at IS NULL` partial index from Sprint 1.

## B. Local-date computation

6. Implement `computeLocalDate(nowUtc, timezone): string` using a real timezone library (e.g. `date-fns-tz` or `luxon`) rather than manual offset math — this is the first place the system needs real timezone conversion. Give it a shared home (e.g. a small `packages/time` package, or `packages/shared-types` if that's a better fit once written) rather than duplicating it, since Sprint 5's scheduler needs the identical local-day-boundary logic for midnight rollover and quiet-hours checks.

## C. Conversation package — new triggers, states, side effects (04 §6.1, §6.3)

7. Extend the `Trigger` union (`packages/conversation/src/trigger.ts`) with `meal_content` (photo or food-describing text while `idle`), `clarification_answer` (any inbound while `awaiting_clarification`), and `correction` (idle-state text matching a correction pattern).
8. Extend `classifyTrigger()`: `idle` + (photo or text present) → `meal_content` by default, unless the text matches the correction-pattern check (step 9), in which case → `correction`. `awaiting_clarification` + anything → `clarification_answer`.
9. Implement a lightweight correction-pattern matcher — keyword/phrase list per Build Spec §4.3's examples ("that was", "actually", "undo", "delete that", "no it was"), same posture as Sprint 2's onboarding-goal keyword classifier: no NLU, default to `meal_content` on any ambiguity so a real log is never misclassified as a correction.
10. Add new `SideEffect` variants (`packages/conversation/src/sideEffect.ts`): `{ type: 'writeMealLog' }`, `{ type: 'holdCandidate'; candidate: MealCandidate }`, `{ type: 'writeCorrection'; targetLogId: string }` — kept distinct from the existing `mergeContext`/`sendReply` variants since the interpreter needs to special-case what actually gets persisted.
11. Add lookup-table rows to `transitions.ts` for `idle:meal_content`: on high/medium confidence, stays `idle` (`writeMealLog` + `sendReply`); on low confidence, → `awaiting_clarification` (`holdCandidate` + `sendReply` with the clarifying question). **This is the first transition whose outcome depends on runtime data, not just the `{state, trigger}` key** — the static lookup table can't express the branch by itself. The router (§D) needs to resolve the `MealCandidate` first, then pick between two candidate transitions before calling `applySideEffects`. Flag this as a real shape change to how `resolveTransition`'s result gets consumed, not just new rows.
12. Add `awaiting_clarification:clarification_answer` → `idle` (writes the resolved meal log from the held candidate + the clarifying answer, then replies with the completed log).
13. Add `idle:correction` → stays `idle` (`writeCorrection` + `sendReply` with updated totals) for the single-match case. When more than one plausible target log exists, route to the same low-confidence-style branch as step 11 instead: a disambiguation reply, holding state. This reuses `awaiting_clarification` rather than adding a tenth state — 04 §6.1 doesn't define a distinct "awaiting correction target" state, and its stated purpose ("held a low-confidence candidate, asked one question") generalizes to "asked one question, waiting on the answer." Call this out explicitly as an interpretation of the source doc's state table, not a literal instruction in it.
14. Because step 13 reuses `awaiting_clarification` for two different held-context shapes, tag the held context with a discriminant (e.g. `conversationContext.pendingKind: 'meal_candidate' | 'correction_target'`) so the `clarification_answer` handler (step 12) knows which resolution path to run.

## D. Router wiring — fast path (Architecture §4.1)

15. In `apps/api/src/lib/router.ts`, add the `meal_content` branch: call `TextParser.parse()` or `VisionProvider.recognize()` depending on whether `payload.photoKey` or `payload.text` is set (photo takes precedence if both present).
16. Branch on the resulting `MealCandidate`: `isFood === false` → terminal reply (non-food or unassessable copy, keyed by `rejectionReason`), no state change, no log write, no held context (04 §5.3) — handled as its own path, distinct from step 11's confidence-gated branch, since it never reaches the scorer's output at all.
17. `confidence: 'high' | 'medium'` → write the meal log (step 1), compute daily totals (step 2), compose the full reply — macros plus a per-item breakdown when `items.length > 1` (Build Spec §4.2: "break the reply out by item... so a later correction can target one item").
18. `confidence: 'low'` → hold the candidate (`holdCandidate`/`mergeContext`), transition to `awaiting_clarification`, send the single clarifying question — never both a guess and a hedge in the same reply (Build Spec §4.2 principle).
19. **Touches already-shipped Sprint 1 code.** Decide whether `handleInboundMessage` should still be awaited synchronously by `POST /webhooks/twilio/inbound` before returning TwiML, now that this path can block on a multi-second vision call. A retry from Twilio mid-vision-call risks double-processing the same inbound message. Recommended: stop awaiting it in `apps/api/src/routes/twilio-inbound.ts` — return the empty TwiML immediately (valid per 04 §4.1 step 6: replies go out async via the REST API, not the webhook response) and let `handleInboundMessage` run detached, with its own error logging so a rejected promise doesn't disappear silently.
20. Add the reliability fallback Architecture §7 calls for on exactly this path ("Vision model API down or slow... fall back to holding reply + async completion... never silently drop an inbound photo"): wrap the `recognize()`/`parse()` call with a timeout; on timeout or provider error, send an immediate holding reply ("Got your photo, one sec...") and complete the log asynchronously once the call resolves, rather than leaving the user with no response. In scope here (not deferred to Sprint 8) because it's the direct failure mode of the exact call this sprint introduces into the fast path.

## E. Correction/edit resolution (04 §6.3, Build Spec §4.3)

21. Implement `resolveCorrectionTarget(userId, text)`: parse an explicit day reference from the text if present ("yesterday", a weekday name) via simple keyword matching — no date-parsing library needed at this scope, same posture as the onboarding classifiers. Default lookback is same-day; extend to prior days only when a day reference is explicit.
22. Query candidates via `getRecentMealLogsForUser` scoped to the resolved day (or "most recent" with no day reference). Exactly one plausible match → that's the target. More than one → return the disambiguation set for the router (step 13/14) to ask about. Zero → reply that nothing recent was found, rather than silently no-op'ing.
23. "Delete that" with no replacement candidate resolves the same way, but calls `softDeleteMealLog` (step 4) instead of `writeCorrection` — add a distinct delete-keyword check inside the `correction` trigger's text classification, checked before the general correction match.
24. The reply after a correction/delete states the total for the corrected entry's **original** date, not today's, when they differ (Build Spec §4.3 edge case) — only matters when the correction references a prior day; same-day corrections need no special-casing since the two dates coincide.

## F. Templates

25. Add reply templates: non-food terminal reply; unassessable/blurry terminal reply (offers a retake or a one-line description, per Build Spec §4.2); the clarifying-question template (interpolates a specific ambiguity note from `confidenceNote` where available); the full log reply (macros + per-item breakdown + running daily total); the correction-confirmation reply; the delete-confirmation reply; the correction-target disambiguation question.
26. Keep composition as plain string interpolation — no i18n, no generated copy — consistent with Sprint 2's posture, and directly relevant to Sprint 7's safety-guardrail requirement that reply copy stay in a reviewed template set rather than freely generated text.

## G. Tests (04 §14)

27. Table-driven tests for every new `{state, trigger}` pair added in §C, including the confidence-branch cases (high/medium/low) as their own asserted outcomes, since one `{state, trigger}` key now yields different transitions depending on runtime data.
28. Unit tests for `resolveCorrectionTarget`: same-day single match; explicit-prior-day match; multiple plausible matches → disambiguation; zero matches → not-found reply.
29. Unit tests for `computeLocalDate` across a midnight boundary in at least one non-UTC timezone (exercised more thoroughly by Sprint 5's simulated-clock tests, but needs its own coverage here since it's introduced in this sprint).
30. End-to-end scripted test against `handleInboundMessage` with faked vision/db functions: photo → high-confidence log reply; photo → low-confidence clarifying question → answer → completed log; text correction referencing "yesterday's lunch" → corrected entry with the right date's total; "delete that" → soft-deleted entry, totals updated.
31. Test asserting the detached-handler change (step 19) doesn't swallow errors silently — a rejected `handleInboundMessage` promise gets logged, not lost.

## H. Sprint-close verification

32. Manual test: text a real photo to the dev number, confirm a macro reply arrives; send a correction ("that was actually 2 eggs not 3") and confirm the updated total. Same known blocker as prior sprints applies — the Trial-tier Twilio number rewrites outbound bodies, so this test's real signal is limited to "did processing complete without erroring," not "did the right text arrive," until the account/A2P situation from Sprint 2's close-out is resolved.
33. Re-check A2P 10DLC status — this is now two sprints past the original filing-status check-in with, per Sprint 3's close-out, no filing yet on record. Flag explicitly if still unfiled: Sprint 8 is the last sprint before the Sprint Plan treats this as a launch blocker.

---
*Tally — Technical Design Doc 09 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown*
