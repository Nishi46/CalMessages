# Tally — Sprint 3 Breakdown
### Technical Design Doc 08 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 3 (Vision pipeline) from 05 — Sprint Plan. Each step traces back to 04 — Technical Implementation §5 (vision & parsing pipeline) — the sprint's own Ref column.

**Prepared:** 26 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown &nbsp;|&nbsp; **Status:** Pre-build

---

## Scope note

Sprint 3's Ref is `04 §5` only — the vision/parsing pipeline as a standalone package, with no wiring into the conversation router. That wiring (photo/text → candidate → confidence gate → `meal_log` write → reply) is explicitly Sprint 4's job. This sprint has no dependency on Sprints 1–2's state machine internals beyond the `MealCandidate` contract itself — the Sprint Plan's own parallelization note flags this as startable during Sprint 2 once that interface is agreed.

`packages/vision/src/index.ts` is currently an empty stub (`export {}`), and `packages/shared-types/src/index.ts` only exports `MessageEvent`-related types so far — this sprint is the first real work in either.

The Sprint Plan's Ships wording is "golden-set regression corpus **started**," not completed — §E below reflects that; a fuller corpus (more fixtures, more providers/prompt versions tracked over time) is expected to keep growing in later sprints, not to be finished here.

---

## A. `MealCandidate` contract & shared types (04 §5.1)

1. Add `MealCandidate` and its nested item type to `packages/shared-types` (new file, e.g. `mealCandidate.ts`, exported from `index.ts`) — this is the one type Sprint 4's router needs to import. Keeping it in `shared-types` rather than `packages/vision` matches the repo-layout comment in 04 §2 ("shared-types: MealCandidate, ConversationState, etc.") and means Sprint 4 never has to depend on the vision package's internals to consume its output.
2. Extend the type with one field the source interface doesn't literally include but Build Spec §4.2's edge cases require: a discriminant for *why* a candidate is terminal-but-unloggable. `isFood: false` alone conflates "this isn't food" (reply: "say so plainly and drop it") with "too blurry/dark to assess" (reply: "ask for a retake") — two different templates Sprint 4 needs to pick between. Add `rejectionReason?: 'non_food' | 'unassessable'`, set only when `isFood` is `false`. Called out explicitly since 04 §5.3 says both are terminal states without specifying how a caller tells them apart.
3. Define `VisionProvider` (`recognize(photoKey: string): Promise<MealCandidate>`) and `TextParser` (`parse(text: string): Promise<MealCandidate>`) interfaces inside `packages/vision/src` per 04 §5.1 — these stay in the vision package itself (implementation-facing), unlike the `MealCandidate` data shape.

## B. Confidence scorer — pure function (04 §5.2)

4. Define the scorer's input signal shape as its own exported type: `{ modelCertainty: number; itemCount: number; dishCategory: 'packaged' | 'home_cooked' | 'mixed'; hasPortionReference: boolean }` — kept separate from the adapters so Sprint 13's P1 threshold retuning can be unit-tested against the same signal shape without touching adapter code.
5. Implement `scoreConfidence(signals): 'high' | 'medium' | 'low'` per the 04 §5.2 table, applied as ordered rules (not a weighted score, for the same auditability reason the state machine is a lookup table, not free-form logic): packaged + visible labeling → `high`; home-cooked/mixed dish → capped at `medium` regardless of other signals; missing portion reference → drop one tier from whatever the other signals produced; higher item count (e.g. 4+ distinct items) → drop one tier.
6. Comment the exact tier thresholds as the placeholder pending real correction-rate data — 04 §5.2 is explicit that tuning these is a P1 activity (Build Spec §9 open question 3) and that the scorer is built as a pure function *specifically* so thresholds can move without a redeploy. Same pattern as Sprint 2's `computeDefaultGoal` placeholder-formula comment.
7. Unit tests, one per rule plus meaningful interactions: packaged+labeled+high-certainty → `high`; home-cooked+high-certainty → capped `medium`; missing portion reference on an otherwise-high case → drops to `medium`; 5-item plate → drops one tier; a case with two lowering signals stacked (note explicitly that 04 §5.2 doesn't specify multi-signal stacking behavior beyond "lowers" — pick "at most one tier per triggered rule, floor at `low`" and document it as a judgment call, not a spec-derived rule).

## C. Vision adapter — `recognize()` (04 §5.1, §5.3)

8. Implement the hosted-multimodal-model HTTP call: given a photo key, fetch the bytes (via a small injected `fetchByKey` function, not a hard dependency on `apps/api`'s S3 client — keeps `packages/vision` decoupled from the object-store implementation per 04 §2's package-boundary intent) and send to the provider; parse its response into a raw items list + per-item certainty.
9. Wire the confidence scorer (step 5) into `recognize()`: derive `dishCategory` and `hasPortionReference` from whatever fields the chosen provider's response actually exposes, or from a lightweight secondary heuristic pass if it doesn't expose them directly — this is a real per-vendor integration detail to resolve against whichever provider gets picked, not something specifiable in the abstract from the source docs.
10. Handle the non-food and unassessable-photo paths (04 §5.3) before the scorer ever runs — there's nothing to score: if the provider signals no food detected, return `{ isFood: false, rejectionReason: 'non_food', items: [], calories: 0, protein: 0, carbs: 0, fat: 0, confidence: 'low' }`; if the photo is too dark/blurry to assess (provider-reported low-quality signal, or a cheap pre-check before the full recognition call), return the same shape with `rejectionReason: 'unassessable'`.

## D. Text parser adapter — `parse()` (04 §5.1)

11. Implement `TextParser.parse()` against the same or a lighter hosted model (text-only prompt), returning the identical `MealCandidate` shape. `rejectionReason: 'unassessable'` never applies on this path — there's no photo-quality failure mode for text; non-food text degrades to `rejectionReason: 'non_food'` the same way an unparseable onboarding answer degraded to a default in Sprint 2.
12. Reuse `scoreConfidence()` (step 5) for the text path too: default `hasPortionReference` to `false` unless a portion is stated explicitly ("a cup of rice"), and derive `dishCategory` from simple food-name heuristics or the model's own classification — one scorer, two callers, per 04 §5.2's "confidence scoring is a separate step from recognition" framing (Architecture §3.2).

## E. Golden-set regression corpus — started, not complete (04 §14)

13. Create a small fixture set (5–10 entries) of text descriptions with hand-labeled expected macros (as a tolerance band, not exact numbers — model output isn't deterministic) and expected confidence tier, stored as a JSON/TS fixture file in `packages/vision`.
14. Write a golden-set test runner that calls `TextParser.parse()` against each fixture and asserts the confidence tier matches and macros fall within tolerance — this is the mechanism 04 §14 describes for tracking confidence-tier drift across provider/prompt changes, not a strict pass/fail gate on exact numbers.
15. Add 2–3 photo fixtures if sample images are available; if not, note explicitly that photo-fixture growth is deferred rather than silently skipped — the Sprint Plan's own "corpus started" wording anticipates this isn't complete in one sprint.

## F. Tests

16. Unit tests for `scoreConfidence()` covering the full rule table (step 7).
17. Unit tests asserting the non-food/unassessable paths never populate `items`/macros with non-zero values — a fabricated-looking number here would violate Build Spec principle 3 ("never returns a precise-looking number for a guess").
18. Integration-style tests for both `recognize()` and `parse()` with the provider's HTTP call mocked at the fetch/client boundary (fixed fake response) — asserts the full internal pipeline (raw call → signal derivation → scorer → final `MealCandidate`) wires together without hitting a real API in CI.

## G. Sprint-close verification

19. Manual test: call `recognize()` against 2–3 real photos through the actual hosted provider (using the vision-provider API key slot Sprint 0 reserved and now fills in) and eyeball results — the one sprint task that costs real API money, so do it deliberately rather than in a loop or in CI.
20. Carried forward from Sprint 2's close-out: the dev Twilio number is still Trial-tier (silently overrides outbound message bodies with a canned template) and A2P registration had not been filed as of 2026-08-26. Neither blocks this sprint's work — vision has no Twilio dependency — but both remain open before Sprint 4's end-to-end manual verification can mean anything.

---
*Tally — Technical Design Doc 08 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan · 06 — Sprint 0 & 1 Breakdown · 07 — Sprint 2 Breakdown*
