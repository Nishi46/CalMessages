# Tally — Sprint 6 Breakdown
### Technical Design Doc 11 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 6 (Billing) from 05 — Sprint Plan. Each step traces back to 04 — Technical Implementation §8 — the sprint's own Ref column.

**Prepared:** 26 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown · 10 — Sprint 5 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

---

## Scope note

`packages/billing/src/index.ts` is currently an empty stub (`export {}`) — this sprint is the first real work in it. The `subscription` table was migrated back in Sprint 1 (step 6 of 06 — Sprint 0 & 1 Breakdown) but nothing has read or written it since.

Unlike Sprints 3 and 5, this sprint isn't purely additive package work: the free-tier metering requirement (04 §8.1 — increment in the *same transaction* as the `meal_log` insert) means modifying the meal-logging write Sprint 4 introduced, not just adding new files. §A steps 3–4 call this out explicitly.

## A. Schema/query layer

1. Add `packages/db-consumer/src/subscriptions.ts`: `getOrCreateSubscriptionForUser(userId)` — the `subscription` table exists from Sprint 1, but nothing has needed insert-on-first-use until now. Defaults per the table's own schema: `plan='free'`, `free_analyses_used=0`, `free_analyses_limit=20`.
2. Add `incrementFreeAnalysesUsed(client, userId)` designed to run against an already-open transaction client, not a fresh pool connection — the one piece of this sprint that has to compose with Sprint 4's meal-log write rather than stand alone.
3. Add a `withTransaction<T>(fn: (client) => Promise<T>): Promise<T>` helper to `packages/db-consumer/src/pool.ts` — none exists yet; every query function added in Sprints 1–5 calls `getPool().query()` directly with no multi-statement transaction wrapper. Needed so the `meal_log` insert and the metering increment commit atomically.
4. **Modifies already-shipped Sprint 4 code.** Wrap Sprint 4's `createMealLog` call site (the fast-path log write in `apps/api/src/lib/router.ts`) in `withTransaction`, calling `incrementFreeAnalysesUsed` inside the same transaction — call this out the same way Sprint 4 itself flagged touching Sprint 1's webhook route.
5. Add `getSubscriptionStatus(userId)` and `upsertSubscriptionFromCheckout(userId, stripeCustomerId, stripeSubscriptionId)` for the checkout webhook handler (§C).
6. Add a `processed_stripe_event` migration (id = Stripe event ID, primary key) — 04 §8.3 calls for this explicitly ("short-lived dedup table or a unique constraint"). A small dedicated table is simplest given nothing in the schema tracks per-event processing yet.

## B. Free-tier metering & paywall trigger (04 §8.1)

7. After the transactional increment (steps 2/4), check whether `free_analyses_used` just crossed `free_analyses_limit` for the first time (previous value was under the limit, new value meets/exceeds it) — only the crossing, not every subsequent log once already over, triggers the paywall message.
8. Enqueue the paywall message *after* the log reply has already been sent — Build Spec §4.6 step 1: "the log that crosses the threshold is still delivered in full." Implement as a second `sendMessage()` call issued once the fast-path log reply's `sendMessage()` call has resolved, not concurrently with it, so the ordering is guaranteed rather than incidental.
9. On crossing, transition `conversation_state` to `awaiting_checkout`. The paywall trigger fires from billing logic wrapping the meal-log write, not from the router's normal `{state, trigger}` lookup path — decide whether this goes through `resolveTransition`/`applySideEffects` (via a synthetic `limit_crossed` trigger) or is set directly via `updateUserState` from the billing code. **Recommended: the synthetic-trigger route**, so every state transition in the system keeps flowing through one auditable mechanism, consistent with 04 §6.1's stated design goal, rather than introducing a second way to change `conversation_state`.

## C. Stripe Checkout flow (04 §8.2)

10. Implement `createCheckoutLink(userId)` in `packages/billing`: `stripe.checkout.sessions.create` with `client_reference_id = userId`, success/cancel URLs pointing at a minimal confirmation page (no account creation — this is new surface area with no existing route to build on; the smallest viable version is a static response, not a page app).
11. Add the paywall template (`packages/conversation/src/templates.ts`) matching Build Spec §4.6's example copy, interpolating the checkout link URL.
12. Add `POST /webhooks/stripe` in `apps/api` (new route file, following the existing `twilio-inbound.ts` / `twilio-status.ts` pattern) — verify the Stripe webhook signature against the webhook secret before any processing, mirroring the existing signature-first posture.
13. Handle `checkout.session.completed`: look up `userId` from `client_reference_id`, call `upsertSubscriptionFromCheckout` (`status='active'`), transition `conversation_state` from `awaiting_checkout` back to `idle` (same synthetic-trigger-vs-direct-write choice as step 9 — stay consistent with it), send one confirmation text, resume with no re-onboarding (Build Spec §4.6 step 3 — falls out for free once state returns to `idle`, the same state normal logging resumes from).

## D. Webhook idempotency (04 §8.3)

14. Every Stripe webhook handler checks the `processed_stripe_event` table (step 6) for the incoming event ID before doing anything else. If already present, return 200 immediately without reprocessing. If not, process the event and insert the ID **in the same transaction** as the event's side effects — not after, since a crash between processing and recording the ID would otherwise permit a duplicate-processing replay on retry.

## E. Subscription lifecycle backstop (04 §8.4)

15. Handle `customer.subscription.updated` / `customer.subscription.deleted` webhooks, updating `Subscription.status` to `past_due`/`canceled` — same idempotency treatment as step 14.
16. Add a daily reconciliation job that re-fetches subscription status from Stripe's API for any account whose local `Subscription` row hasn't been touched by a webhook in an unexpectedly long window, per Architecture §7's "not the webhook as the sole source of truth." Decide whether this reuses Sprint 5's worker/leader-election mechanism or a simpler standalone scheduled task — one daily job may not warrant the same infrastructure as the 15-minute nudge loop; note the choice either way.

## F. Tests (04 §14)

17. Free-tier boundary tests at exactly `limit - 1`, `limit`, `limit + 1` free analyses used — assert the paywall message fires only on the exact crossing (`limit - 1 → limit`), not before, and not again on every log after.
18. Transaction test: assert the meal-log write and the metering increment either both commit or both roll back (simulate a failure between them and confirm no partial state).
19. Stripe webhook fixture-replay tests: replay the same `checkout.session.completed` fixture twice, assert the subscription is upserted only once and no duplicate confirmation text is sent on the second delivery.
20. End-to-end test of the `awaiting_checkout → idle` round trip: a user hits the limit, receives the paywall message, "completes checkout" (fixture webhook), returns to `idle`, and their very next meal photo logs normally with no re-onboarding prompt.

## G. Sprint-close verification

21. Manual test against Stripe's test mode: trigger a real free-tier exhaustion for a test user, click through an actual Stripe test Checkout session, confirm the webhook fires and the thread would resume correctly (subject to the same Twilio Trial-tier caveat noted in prior sprints).
22. Re-check A2P 10DLC status — Sprint 6 of 8. Flag prominently if still unresolved: only two sprints remain before the Sprint Plan's own Sprint 8 slip-point.

---
*Tally — Technical Design Doc 11 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown · 10 — Sprint 5 Breakdown*
