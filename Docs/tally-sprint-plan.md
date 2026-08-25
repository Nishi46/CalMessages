# Tally — Sprint Plan
### Technical Design Doc 05 — Sprint Plan

> Turns the build sequencing in 04 §15 into week-by-week sprints. Assumes a 1–2 person engineering team and 1-week sprints — sequential by necessity, not by choice; where two people genuinely unblock parallel work, it's called out.

**Prepared:** 25 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 06 — Sprint 0 & 1 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

## Reality check against "launch this month"

Vision Brief §(go-to-market) frames P0 as a this-month launch. At 1–2 engineers working through the full schema, state machine, vision pipeline, scheduler, billing, and the launch-blocking safety guardrail (Build Spec §5 — explicitly not a fast-follow), that's roughly **9 sprints, ~9 weeks**, not 4. The compressed version — cutting straight to a working fast path with thinner scheduler/billing — is called out below as an alternative if the calendar is fixed and scope has to give instead.

The A2P 10DLC registration (Build Spec §4.3, 1–3 week approval) is on the critical path for *production* SMS but not for development — it's filed in Sprint 0 so it clears in parallel with the first few sprints of build work, per Vision Brief §(test plan) ("not a technical blocker").

---

## Sprint 0 — Setup (parallel to Sprint 1, not sequential)

**Goal:** everything downstream sprints assume already exists.

- Repo scaffold per 04 §2 (`apps/`, `packages/`, `infra/`), CI skeleton (test → build → deploy).
- `dev` / `staging` / `production` environments; managed Postgres × 2 instances, Redis, S3-compatible bucket provisioned (04 §13).
- Secrets store wired (Twilio, Stripe, vision provider, DB credentials); field-level encryption keys for the future clinic store scoped separately from day one, even though that store doesn't exist yet.
- **File A2P 10DLC brand + campaign registration now** — this is the one item on the whole plan with external lead time outside engineering's control.

---

## P0 — SMS launch (Sprints 1–8)

| Sprint | Focus | Ships | Ref |
|---|---|---|---|
| **1** | Data + transport foundation | Consumer schema (`user`, `goal`, `meal_log`, `message_event`, `subscription`) + migrations. Twilio inbound webhook with signature verification, outbound `sendMessage()`, media fetch-before-anything-else. TwiML stub reply. | 04 §3.1, §4.1–4.2 |
| **2** | Conversation engine | State machine as a `{fromState, trigger} → {toState, sideEffect}` lookup table in the `conversation` package. `new` → `onboarding_q1/q2/q3` → `idle`. Table-driven unit tests for every defined transition + a safe-fallback test for undefined ones. | 04 §6.1, §14 |
| **3** | Vision pipeline | `VisionProvider.recognize()` + `TextParser.parse()` adapters behind the `MealCandidate` interface. Confidence scorer as a pure function (model certainty, item count, dish category, portion reference). Golden-set regression corpus started. | 04 §5 |
| **4** | Meal logging fast path | Photo/text → candidate → confidence gate → `meal_log` write → reply, end-to-end. Low-confidence → single clarifying question, held in `conversation_context`, `awaiting_clarification` state. Non-food / too-blurry terminal replies (no held state). Correction/edit flow resolving the target log by recency + explicit day reference. | 04 §5.3, §6.3, Architecture §4.1 |
| **5** | Scheduler | Leader-elected evaluation loop: nudge window, quiet hours, already-logged-today skip, daily frequency cap (scheduler pre-filter + queue-consumer authoritative check), 5-day disengagement de-escalation. Simulated-clock tests: midnight rollover, DST, cap boundaries, the double-fire race. | 04 §7.1–7.3, §14 |
| **6** | Billing | Free-tier metering incrementing in the same transaction as the `meal_log` insert; paywall message *after* the log reply per Build Spec §4.6 step 1. Stripe Checkout link generation, `checkout.session.completed` handling, webhook idempotency via event-ID dedup. Stripe fixture-replay tests. | 04 §8 |
| **7** | Opt-out + safety | `paused`/`deleted` states, Twilio STOP/START status-callback wiring. Safety guardrail: keyword/pattern classifier on inbound text tuned toward false-positive tolerance, `care_pause` transition (suppresses scheduler eligibility, swaps reply templates, no auto-exit). Treated as launch-blocking per Build Spec §5. | 04 §6.1, §4.3, §11 |
| **8** | Metrics + hardening | Every Build Spec §7 metric wired to a concrete query (04 §12), deliverability drop alerting as a P0 incident path, not dashboard-only. End-to-end scripted conversation tests (onboarding → log → correction → paywall → checkout) against a Twilio sandbox. Staging soak. Confirm A2P registration cleared; if not, this is where the calendar slips. | 04 §12, §14 |

**If the calendar is fixed instead of scope:** the compressible sprints are 6 (billing can launch with metering + checkout but skip the reconciliation backstop) and 8 (metrics can go live with the four headline numbers — time-to-first-log, D14 retention, nudge response, deliverability — rather than all eight). Sprint 7's guardrail is explicitly *not* a candidate for cutting, per Build Spec §5's own framing.

**Two-person parallelization, if applicable:** Sprint 3 (vision pipeline) has no dependency on Sprints 1–2's state machine internals beyond the `MealCandidate` contract — a second engineer can start it during Sprint 2 once the interface (04 §5.1) is agreed, pulling P0 in by roughly one sprint.

---

Sprint 0 and Sprint 1 are broken down into task-level steps in **06 — Sprint 0 & 1 Breakdown**.

---

## P1 — Professional layer (Sprints 9–13)

Starts once P0 is in market and the first cohort is producing correction-rate data (Sprint 13 depends on it).

| Sprint | Focus | Ships | Ref |
|---|---|---|---|
| **9** | Coach identity | `coach` / `client_link` schema, session-based dashboard auth, disjoint from phone-based consumer auth. | 04 §9.1 |
| **10** | Coach API + dashboard | `GET /api/coach/clients`, `GET /api/coach/clients/:id/logs` (404-not-403), `POST /api/coach/invite`, `POST /api/coach/clients/:id/unlink`. No route registered that writes `meal_log`/`goal` from the coach side — a route-table guarantee, not a permission check. Next.js dashboard pages against this API. | 04 §9.2 |
| **11** | Weekly recap | Second scheduler producer: once-weekly per-user job (default Sunday evening local time), aggregates trailing-7-day `meal_log`/`goal`, composes the Build Spec §4.5 summary on the existing queue pipeline. | 04 §7.4 |
| **12** | Consent onboarding + voice | Consent-linked onboarding template variant selected by enrollment path at `new` → `onboarding_q1` (not a later screen). `TextParser` extended to accept transcribed audio under the same `MealCandidate` contract. | 04 §10, P1 item 4 |
| **13** | Confidence retuning | Adjust confidence-tier thresholds against accumulated P0 correction-rate data — the scorer was built pure-function specifically so this doesn't require a redeploy of the vision integration itself. | 04 §5.2 |

---

## P2 — The rail (parallel track, legal-gated)

Build Spec §8 calls for starting this in parallel with P1, since BAA/legal approval timelines run long and shouldn't gate consumer growth. The sales/legal lead time (BAA negotiation) starts as early as a clinic prospect exists — independent of the sprint numbering below, which is engineering effort once a BAA is in hand.

| Sprint | Focus | Ships | Ref |
|---|---|---|---|
| **14** | Clinic store | `db-clinic` package (separate package, not just separate schema) stood up: `clinic`, `clinic_patient`, `clinic_staff`, `audit_log`. Mandatory audit-log write wrapping every read/write, in the same transaction, at the query-layer level. No patient rows writable without `clinic.baa_signed_at` set. | 04 §3.2, §10 |
| **15** | Clinic enrollment | Clinic-specific consent/disclosure block up front (not a later add-on). Panel-scoped staff access (`clinic_staff.panel_scope`) filtered at the query layer. CI lint rule: no handler file imports both `db-consumer` and `db-clinic`. | 04 §10, §14 |
| **16** | Second channel | Apple Messages for Business adapter as a second `messaging` package implementation behind the existing channel-agnostic interface — orchestration core untouched. | 04 §2, P2 item 3 |
| **17** | Clinic analytics | Adherence trends, flagged-client views — additive read endpoints over existing data, no new write paths. | 04 §9.3, P2 item 4 |

---

## Dependency notes that shape ordering

- **Sprint 7 (safety guardrail) before any real cohort**, not after — it's launch-blocking by Build Spec §5's own framing, not a P1 item, even though it's late in the P0 sequence for build reasons (needs the conversation router and message templates from earlier sprints to hook into).
- **Sprint 13 depends on real usage data** — it can't be pulled earlier than P0 having run long enough to accumulate a correction-rate sample.
- **P2 Sprint 14 can start engineering-wise before a BAA is signed** (schema, audit-log plumbing, the package boundary itself don't touch real patient data), but no patient rows are writable until it is — so the *sales/legal* clock, not the sprint clock, usually gates when P2 actually starts.

---
*Tally — Technical Design Doc 05 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 06 — Sprint 0 & 1 Breakdown*
