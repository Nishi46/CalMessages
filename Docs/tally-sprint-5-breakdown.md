# Tally — Sprint 5 Breakdown
### Technical Design Doc 10 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 5 (Scheduler) from 05 — Sprint Plan. Each step traces back to 04 — Technical Implementation §7.1–§7.3 and §14 — the sprint's own Ref column.

**Prepared:** 26 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

---

## Scope note

`apps/worker/src/index.ts` is currently an empty stub (`export {}`) — this sprint is the first real work in it. Sprint Plan Ref is `04 §7.1–7.3, §14` only; the weekly recap (§7.4) is explicitly P1 (Sprint 11) and out of scope here, even though it rides the same queue this sprint builds.

This sprint reuses Sprint 4's `computeLocalDate` timezone helper (§B step 5 below) rather than introducing a second timezone library — the scheduler's local-day-boundary logic and the meal-logging fast path's `local_date` bucketing need to agree, or a nudge could fire against the wrong day's "already logged" check.

## A. Infrastructure setup

1. Add BullMQ + a Redis client (e.g. `ioredis`) to `apps/worker`; wire a connection using the `REDIS_URL` secret Sprint 0 already reserved.
2. Create the `nudge` queue and its consumer/worker skeleton in `apps/worker/src/index.ts` — keep the "producer" (scheduler loop) and "consumer" (queue processor) as distinct functions in the same process for now, matching Architecture §3.3's framing of them as separate concerns sharing one queue.
3. Implement leader election for the scheduler loop via a Postgres advisory lock (`pg_try_advisory_lock`) against the existing consumer Postgres pool — reuses infrastructure already provisioned rather than adding a second leader-election mechanism (e.g. Redlock) for one boolean concern. A worker instance that doesn't hold the lock still runs its queue consumer — consumers scale horizontally per Architecture §6; only the evaluation loop needs a singleton.
4. Add a periodic tick (04 §7.1's example interval is 15 minutes) but keep the interval configurable/injectable rather than hardcoded — required for testability, since the simulated-clock tests in §F can't wait 15 real minutes.

## B. Time & timezone helpers

5. Reuse Sprint 4's `computeLocalDate` helper; add a companion `localTimeOfDay(nowUtc, timezone): { hour, minute }` for nudge-window and quiet-hours evaluation, backed by the same timezone library chosen in Sprint 4 rather than a second one.
6. Define the nudge window and quiet hours as named, tunable constants (default ~8pm local per 04 §7.2; quiet hours e.g. a late-night/early-morning band) — mark explicitly as placeholders pending the P1 per-user-learned timing from Build Spec open question 2, same pattern as flagging `computeDefaultGoal` as a placeholder in Sprint 2.

## C. Evaluation loop (04 §7.1)

7. Add `getActiveUsersForScheduling()` to `packages/db-consumer`: `opt_out_at IS NULL AND paused_at IS NULL AND conversation_state = 'idle'` — reuses the `idx_user_state` partial index (`WHERE opt_out_at IS NULL`) from Sprint 1.
8. Add `hasLoggedToday(userId, localDate)` — `EXISTS` against `meal_log` scoped by `local_date` and `soft_deleted_at IS NULL`, reusing `idx_meal_user_date`.
9. Add `countNudgesSentToday(userId, localDate)` — count `message_event` where `type='nudge' AND direction='outbound'` within the user's **local**-day boundary (not a UTC calendar day — this is exactly why §B's helper needs to exist), reusing `idx_msgevent_user_type_sent`.
10. Add `daysSinceLastLog(userId)` — `now() - max(logged_at)` (with a sentinel for "never logged") against `meal_log`, feeding the 5-day disengagement rule.
11. Implement the evaluation loop body per 04 §7.1's pseudocode, in order: skip if outside the nudge window; skip if already logged today; skip if in quiet hours; skip if today's nudge count ≥ the daily cap (default 1); apply the 5-day disengagement reduction (step 12) as a further chance to skip, never a chance to send extra; enqueue with idempotency key `nudge:${userId}:${localDate}`.
12. Implement the 5-day disengagement rule as an explicit, documented placeholder formula (Build Spec §5: "reduced further... rather than increased") — e.g. once `daysSinceLastLog >= 5`, only proceed to enqueue on every Nth eligible day rather than every one. Comment it the same way as `computeDefaultGoal`: a placeholder ratio, tunable later, that must never trend toward *more* frequent sends as disengagement grows.

## D. Frequency cap — enforced twice (04 §7.3, Architecture §7)

13. Scheduler-side pre-filter: step 11's cap check, cheap, based on `countNudgesSentToday` at evaluation time.
14. Queue-consumer-side authoritative check: immediately before calling `sendMessage()` inside the nudge job processor, re-run `countNudgesSentToday` against current data and abort the send (without erroring the job) if the cap is already met. This is what closes the race Architecture §7 describes — e.g. a leader-election glitch or an overlapping evaluation cycle scheduling a user twice.
15. Use BullMQ's job-id-based deduplication (the idempotency key from step 11 as the job ID) as the first layer, and the authoritative send-time check (step 14) as the second — two independent mechanisms, matching Architecture §7's "cheap to check twice; expensive to get wrong."

## E. Nudge send path

16. Add a `proactive_checkin` template (`packages/conversation/src/templates.ts`) matching Build Spec §4.4's tone ("How'd dinner go tonight?") — no streak counts, no "you missed," no cross-user comparison, per Build Spec §5's guardrail table. Note the constraint in a comment: this is the first template that rule actually applies to, and Sprint 7 (safety guardrail) treats template review as the enforcement mechanism for it.
17. Queue consumer job processor: run the authoritative check (step 14), then call the existing `sendMessage(client, userId, body, 'nudge')` from `packages/messaging` unchanged — nudges are "just another outbound message" per Architecture §3.1's one-send-path design.

## F. Tests — simulated clock (04 §14)

18. Inject a `now()`/clock dependency into the evaluation loop and every time-window/quiet-hours check, rather than calling `Date.now()` directly — the prerequisite for every test below.
19. Midnight rollover test: a user's local midnight passes mid-test; assert `hasLoggedToday` correctly buckets a log made at 11:59pm local as *not* covering a nudge evaluation at 12:01am local.
20. DST transition test: pick a real DST-transition date for a timezone that observes it; assert the nudge-window/quiet-hours check evaluates correctly on both sides of the transition — exactly why §B step 5 uses a real timezone library rather than fixed-offset math.
21. Frequency cap boundary tests: exactly at the daily cap (no send), one under (sends), one over (already shouldn't be reachable, but assert no send / no crash regardless).
22. Double-fire race test: simulate two overlapping evaluation cycles both attempting to enqueue the same user's nudge for the same local day; assert only one job actually results in a sent message (via the authoritative check + job-id dedup from steps 14–15), not just that only one job was enqueued.
23. 5-day disengagement test: a user with no log in 5+ days is skipped more often than an actively-logging user under otherwise-identical eligibility, and never more often — assert the rule never produces a *higher* effective send rate for a disengaged user than an engaged one.

## G. Sprint-close verification

24. Run the worker locally against a small set of seeded users with manipulated `logged_at`/timezone data spanning a full simulated day/night cycle (via the injected clock from step 18, not real wall-clock waiting) and confirm exactly the expected nudges fire.
25. Manual test: let the real 15-minute-interval loop run against the dev Twilio number for one eligible user, confirm a nudge SMS attempt is made — same Trial-tier caveat as prior sprints applies to what actually arrives at the phone.
26. Re-check A2P 10DLC status — Sprint 5 of 8, past the halfway point with, per Sprint 4's carried-forward note, still no filing on record as of the last check. If still unfiled, flag prominently: Sprint 8's close-out treats an uncleared registration as the thing that slips the calendar.

---
*Tally — Technical Design Doc 10 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown*
