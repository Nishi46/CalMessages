# Tally — Sprint 8 Breakdown
### Technical Design Doc 13 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 8 (Metrics + hardening) from 05 — Sprint Plan. Each step traces back to 04 — Technical Implementation §12 and §14 — the sprint's own Ref column.

**Prepared:** 26 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown · 10 — Sprint 5 Breakdown · 11 — Sprint 6 Breakdown · 12 — Sprint 7 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

---

## Scope note

This is the last sprint before P0 launch, and the Sprint Plan names it explicitly as "where the calendar slips" if A2P 10DLC registration isn't cleared by now (§E below). Every prior sprint's close-out in this series (07 through 12) has carried forward the same open finding from Sprint 2: as of 2026-08-26, the dev Twilio account was still Trial-tier and no A2P registration had been filed, because Twilio's Brand Registration API refuses Trial accounts. Nothing in this plan can confirm whether that changed in the intervening sprints — §E treats it as the thing to check first, not last, precisely because if it's still true, upgrading the account and filing is itself now a blocking task inside this sprint, with its own 1–3 week clock starting from whenever that actually happens.

## A. Metric queries (04 §12)

1. Implement each of the 8 metric queries from 04 §12's table as concrete, tested functions (a new `packages/db-consumer/src/metrics.ts` or similar): time-to-first-log; D1/D7/D14/D30 retention cohorts; meals-logged-per-active-user/week; nudge-response-rate; correction-rate; free→paid conversion; coach-seat-attach-rate; message-deliverability-by-carrier.
2. Coach-seat-attach-rate legitimately returns 0/N-A at P0 — no `coach`/`client_link` rows exist until Sprint 9 (P1). Implement it anyway per the Sprint Plan's "every... metric" wording; note in a comment that it reads zero until P1 exists, so a zero here isn't a bug to chase.
3. Decide where these queries surface. The Sprint Plan says "wired to a concrete query," not "has a dashboard" — no UI is scheduled until Sprint 10 (P1 coach dashboard). Smallest viable surface: a scheduled report (daily log line, or a simple internal JSON endpoint) rather than any UI. Flag this as a scope decision rather than assuming a dashboard is implied.

## B. Deliverability alerting (04 §12, Build Spec §7)

4. Implement the deliverability metric's alerting path as an actual P0 incident mechanism, not dashboard-only, per 04 §12's explicit framing. Smallest viable version: a periodic check (reusing Sprint 5/6's worker scheduled-job infrastructure) comparing the recent `message_event.delivery_status` failure/undelivered rate against a threshold.
5. **Needs a decision the source docs don't make.** Firing the alert requires an actual destination — email, Slack webhook, PagerDuty, etc. — which isn't specified anywhere in 01–07. Flag this explicitly as needing a decision before this step is finished, rather than silently picking one.
6. Test the alerting threshold logic in isolation (given a synthetic delivery-status distribution, assert it fires/doesn't fire at the right boundary), separately from testing the notification-sending mechanism itself, which likely needs mocking regardless of which channel gets chosen.

## C. End-to-end scripted conversation tests (04 §14)

7. Build the full scripted conversation test: onboarding → log → correction → paywall → checkout, run "against a test Twilio number/sandbox" per 04 §14 — the first test in the whole build to exercise real Twilio infrastructure rather than mocked webhook payloads.
8. Confirm whether the account's Trial-tier restriction (noted since Sprint 2) blocks this kind of test the same way it blocks real SMS delivery — a Trial account's canned-template override could make this test pass on infrastructure grounds (webhook fired, state transitioned) while never proving the real copy is actually delivered. Don't let a green run here substitute for real verification if the account is still Trial-tier.
9. Stitch every prior sprint's individually-tested piece into one continuous script: state transitions from `new` through `idle` → `awaiting_clarification` (or skip, on high confidence) → a correction → `awaiting_checkout` → back to `idle` post-payment, asserting both conversation state at each step and actual message content sent.

## D. Staging soak

10. Confirm staging actually exists before attempting this. Per Sprint 2's close-out, `infra/README.md`'s staging step was unprovisioned as of 2026-08-26. Treat "provision staging" as a blocking prerequisite task here if it still hasn't happened in the intervening sprints — don't assume it landed silently.
11. Deploy the full system (api + worker + all packages) to staging; run the scripted conversation test (§C) against the staging Twilio number and staging Stripe test mode.
12. Let it soak long enough to observe at least one real nudge cycle and one real local-day-boundary rollover, not just an immediate smoke test — the scheduler's midnight/DST correctness (Sprint 5) is exactly the kind of thing an immediate smoke test won't catch.

## E. A2P 10DLC final confirmation

13. Confirm A2P 10DLC registration status — the Sprint Plan's own designated final check-in point ("Confirm A2P registration cleared; if not, this is where the calendar slips"). Given the trajectory carried forward across Sprints 2–7 (unfiled as of Sprint 2, filing blocked on a Trial-tier account upgrade, no indication of progress noted in any sprint since), treat this as very likely still the actual state entering Sprint 8. If so, upgrading the account and filing registration is now a blocking task inside this sprint, not a check against an already-in-flight external process — and the 1–3 week approval window starts from whenever that filing actually happens, not from Sprint 0 as originally planned.
14. If registration is confirmed cleared, run a final live-SMS smoke test end-to-end — a real onboarding text exchange with real copy, not the Trial-tier canned override — closing out the one piece of realistic verification every prior sprint's manual tests couldn't actually complete.

## F. Hardening pass

15. Review every transaction/side-effect-ordering assumption introduced across Sprints 4–6 (meal-log + metering atomicity, paywall-after-log-reply ordering, Stripe webhook idempotency) one more time under concurrent/repeated-delivery conditions, as its own dedicated pass — "hardening" is a named Sprint Plan deliverable here, not just leftover cleanup time.
16. Confirm the CI compliance-boundary lint rule from 04 §14 (no handler file imports both `db-consumer` and `db-clinic`) is actually wired into CI. `db-clinic` has been an empty stub through Sprint 7, so this rule has had nothing to violate yet — worth adding it now, before Sprint 14 (P2) ever touches that package, rather than waiting until there's something for it to catch.

## G. Sprint-close verification

17. Full regression run: every test suite from Sprints 1–8 green in CI.
18. Staging soak results reviewed — no unexplained failed sends, no incorrect local-day-boundary bucketing observed over the soak window.
19. Go/no-go call on P0 launch, gated explicitly on A2P status (step 13) per the Sprint Plan's own framing — this is the sprint where "the calendar slips" if it slips at all.

---
*Tally — Technical Design Doc 13 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown · 08 — Sprint 3 Breakdown · 09 — Sprint 4 Breakdown · 10 — Sprint 5 Breakdown · 11 — Sprint 6 Breakdown · 12 — Sprint 7 Breakdown*
