# Tally — Sprint 7 Breakdown
### Technical Design Doc 12 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 7 (Opt-out + safety) from 05 — Sprint Plan. Each step traces back to 04 — Technical Implementation §6.1, §4.3, and §11 — the sprint's own Ref column.

**Prepared:** 26 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown · 10 — Sprint 5 Breakdown · 11 — Sprint 6 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

---

## Scope note

The Sprint Plan is explicit that this sprint is launch-blocking, not a fast-follow (Build Spec §5's own framing) — it lands late in the P0 sequence for build reasons only: it needs the conversation router (Sprint 2/4) and message templates (Sprint 4/5) already in place to hook into, not because it's lower priority. Treat §D–§E below as the sprint's actual center of gravity, not the pause/delete/opt-out plumbing around it.

Two steps below (§D step 12, §E step 15) are flagged as needing a real product/clinical decision the source docs don't make for you — don't ship a guessed keyword list or an unreviewed data-retention choice without sign-off.

## A. Pause/resume (04 §6.1, Build Spec §4.7)

1. Add `pause`/`resume` triggers to `packages/conversation`'s `Trigger` union, classified from `idle` (and other logging-capable states) via keyword match ("pause", "stop nudges" — see step 9 for why this must stay distinct from carrier-level STOP) → transitions to `paused`; `resume` from `paused` → back to `idle`.
2. `paused` still accepts and processes meal-logging triggers normally (Build Spec §4.7: "logging still works if the user texts in"). This means `paused` needs its own copies of the `meal_content`/`correction` lookup-table rows from Sprint 4's `idle` transitions — the lookup table has no inheritance mechanism, so this is real duplication to add, not something that falls out automatically.
3. Confirm Sprint 5's `getActiveUsersForScheduling` filter (`paused_at IS NULL`) still holds once `user.paused_at` starts actually being set — that filter was built defensively before any code path set the column.
4. Wire `paused_at` writes into the `pause`/`resume` transitions' `updateUserState` calls — reuses the existing column from the Sprint 1 migration, previously unwritten.

## B. Delete (04 §6.1, Build Spec §4.7)

5. Add a `delete` trigger, classified from any state via keyword match ("delete my data" and close variants) → transitions to `deleted`, terminal (04 §6.1: "Terminal" — no further transitions defined out of it). Confirm `resolveTransition` falls through to the safe fallback for every trigger once a user is `deleted`, same posture as the not-yet-wired states from Sprint 2.
6. The transition's `sendReply` side effect sends the one confirmation message Build Spec §4.7 step 3 requires ("confirmed once in writing, never re-prompted or talked out of") — a statement, not a confirmation *question*, since re-prompting is explicitly disallowed.
7. Implement the actual 30-day purge as a scheduled action, not an immediate one. No existing column captures "when did this user enter `deleted`" — `opt_out_at`/`paused_at` exist for their own states, but there's no equivalent for this one. Add a `deleted_requested_at` column via a new migration, mirroring that existing per-state-timestamp pattern, rather than overloading `conversation_context` for something that needs to be queried against directly. Recommend a periodic sweep job (`conversation_state = 'deleted' AND deleted_requested_at < now() - 30 days`) over a per-user delayed job scheduled 30 days out — simpler to reason about and doesn't depend on the queue infrastructure surviving unchanged for a month.
8. The purge job deletes `meal_log` rows — including photos from object storage, which needs a new `ObjectStore.deleteObject(key)` method (the existing interface only has `putObject`) — and scrubs/deletes the `user` row's PII for any user past the 30-day mark.

## C. Twilio STOP/START wiring (04 §4.3, §6.1)

9. Twilio suppresses STOP at the carrier level automatically — no application code decides whether to honor it (04 §4.3). Confirm the existing `/webhooks/twilio/status` route (`apps/api/src/routes/twilio-status.ts`) is **not** where opt-out status arrives — Twilio delivers STOP/START as a distinct notification from delivery-status callbacks. Check Twilio's docs against this account's actual Messaging Service configuration rather than assuming the existing route's payload shape covers it.
10. Add a `POST /webhooks/twilio/optout` route (or extend the existing status route if the account's actual payload shape allows distinguishing an opt-out event inline) — on STOP, set `user.opt_out_at`; on START, clear it (04 §4.3: "symmetrically").
11. Confirm `sendMessage()`'s existing `opt_out_at IS NULL` guard (already implemented in `packages/messaging/src/sendMessage.ts`, Sprint 1) and Sprint 5's scheduler filter both correctly stop attempting sends the moment `opt_out_at` is set. This is largely already-built defense-in-depth from earlier sprints — this sprint's job is making the column actually get set from a real Twilio event, not building the guard itself.

## D. Safety guardrail classifier (04 §11, Build Spec §5)

12. **Needs sign-off, not an engineering guess.** Implement a keyword/pattern classifier on inbound text, tuned toward high false-positive tolerance per 04 §11 ("the cost of a missed flag is categorically worse than an unnecessary care-toned reply"). The actual keyword/phrase list is a product/clinical judgment call — flag explicitly that it needs review from whoever owns the product's safety posture before shipping.
13. On a match, from **any** state (04 §6.1: "Any state, on flagged language") transition to `care_pause`. Wire this as a check that runs *before* `classifyTrigger`'s normal state-based logic, pre-empting every other trigger for that inbound message — not as another lookup-table row keyed per state, since a single keyword list duplicated across nine states' worth of rows risks missing one.

## E. `care_pause` behavior (04 §11, §6.1)

14. Extend Sprint 5's `getActiveUsersForScheduling` filter to also exclude `conversation_state = 'care_pause'`, alongside the existing `paused_at`/`opt_out_at` filters — suppresses scheduler eligibility immediately.
15. **Needs a real decision the source docs don't make.** Add a care-oriented, non-macro reply template with a resource contact (04 §11); meal-logging triggers received while in `care_pause` get this template instead of the normal macro reply. 04 §11 doesn't specify whether the underlying meal data still gets recorded, only that the *reply* tone changes. Recommended: keep logging silently (never discard real user input) while never surfacing macros — full data loss is a bigger risk than an unused row, and nothing in the source docs requires discarding it.
16. `care_pause` is explicitly not auto-exited by any timer or keyword (04 §11: "not a bug to auto-heal"). Confirm no lookup-table row transitions *out* of `care_pause` automatically — the only way out is a manual/deliberate action, which this sprint doesn't build tooling for (no dashboard or admin surface exists yet at this point in the build sequence). Note this as a known, intentional gap: a flagged user currently has no product-level path back to normal state at all.

## F. Guardrail template review (04 §11)

17. Audit every reply/proactive template shipped so far (onboarding confirmation, meal-log replies, the Sprint 5 nudge, the Sprint 6 paywall) against Build Spec §5's copy constraints (no streak counts, no "you missed," no cross-user comparison) — a review pass over already-shipped copy, not new template-writing. This is exactly why 04 §11 frames templates as "a reviewed template set... enforceable by review" rather than a runtime check.

## G. Tests (04 §14)

18. Table-driven tests for the new `pause`/`resume`/`delete` transitions, including `paused`'s duplicated meal-logging rows (step 2).
19. Classifier tests: a representative set of flagged-language examples (from whatever list step 12 settles on) correctly transition to `care_pause` from a range of starting states, not just `idle`; a representative set of clearly-unflagged normal logging text does not false-positive into it.
20. Test that `care_pause` never auto-exits: run every other trigger type against `care_pause` as the starting state and confirm none of them transition out.
21. Test the STOP/START round trip against the real webhook route (mocked Twilio payload): `opt_out_at` set then cleared, and confirm both `sendMessage()` and the scheduler skip the user while opted out.
22. Test the 30-day purge sweep: a user with `deleted_requested_at` more than 30 days in the past has meal logs and object-storage photos removed; a user under 30 days is untouched.

## H. Sprint-close verification

23. Manual test: text "pause" to the dev number, confirm proactive nudges stop while a direct meal photo still logs; text "resume," confirm nudges become eligible again.
24. Manual test: text a flagged-language example, confirm the care-toned reply (not macros) and that no nudge fires afterward.
25. Re-check A2P 10DLC status — Sprint 7 of 8, one sprint before the Sprint Plan's designated final check. If still unfiled at this point, this is very likely the thing that slips the calendar per the Sprint Plan's own framing — worth escalating outside the engineering loop rather than just re-noting it again in the next breakdown.

---
*Tally — Technical Design Doc 12 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown · 10 — Sprint 5 Breakdown · 11 — Sprint 6 Breakdown*
