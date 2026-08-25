# Tally — Build Spec
### Product Design Brief 02 — Build Specification

> Architecture, data model, conversation flows, safety rules, and phased scope for a texting-native calorie tracker. Written for whoever builds this next.

**Prepared:** 25 Aug 2026 &nbsp;|&nbsp; **Companion doc:** 01 — Vision Brief &nbsp;|&nbsp; **Launch surface:** SMS (A2P 10DLC) &nbsp;|&nbsp; **Status:** Pre-build

## At a glance

| | |
|---|---|
| **9** | conversation flows specified below, including edge cases |
| **7** | core data entities in the P0 schema |
| **2–3 wk** | typical A2P 10DLC campaign approval time |
| **~$3** | estimated monthly messaging cost per active user |

---

## 1. Design principles

Four rules everything below should be checked against. When a flow decision is ambiguous, these are the tiebreaker.

1. **One thread, one job.** No menus, no settings screen, no feature the user has to be taught. If it can't be done by texting a sentence, it doesn't belong in the consumer product.
2. **Silent unless it earns the send.** Every proactive message must clear a bar: timely, skippable, and clearly worth the interruption. Default to fewer, better-timed messages over more, generic ones.
3. **Confidence is shown, not assumed.** A low-confidence read says so and asks one clarifying question. It never returns a precise-looking number for a guess — false precision is worse than a visible estimate.
4. **The professional layer changes nothing for the end user.** Coaches and clinics buy visibility into an unchanged experience, not a different product. If a client can tell they're "on a coach's plan" from how the thread behaves, that's a bug.

## 2. System architecture

Six components, one shared data store, one explicit compliance boundary. Nothing here is exotic — the interesting decisions are in the flows and guardrails, not the stack.

| Layer | Component | Responsibility |
|---|---|---|
| **Messaging** | Twilio SMS/MMS, A2P 10DLC campaign | Inbound/outbound transport; carrier registration and throughput; opt-in/opt-out (STOP/START) handling at the carrier level. |
| **Vision & parsing** | Food recognition model + text/voice parser | Turns a photo, a sentence, or (later) a voice note into a structured meal candidate — items, portions, a confidence score. |
| **Orchestration** | Conversation state machine + scheduler | Tracks each user's position in a flow (mid-onboarding, awaiting a correction, etc.); fires proactive sends against quiet hours, frequency caps, and per-user timezone. |
| **Data store** | User, goal, meal log, message event, subscription | System of record. Same store backs both the thread history a user scrolls and the dashboard a coach views. |
| **Billing** | Stripe Checkout + webhooks | Meters free-tier analyses; generates an in-thread checkout link on exhaustion; owns subscription state. |
| **Professional layer** | Authenticated web dashboard | Reads the same store, scoped to a coach's or clinic's linked clients. Write access limited to client management — never edits a client's meal data directly. |

> **Compliance boundary.** Consumer data and clinic-tier data are architecturally separate from the start, not split later under pressure. Clinic records carry PHI; they sit behind stricter encryption at rest, scoped access controls, and an audit log from day one. See §6.

## 3. Data model

Seven entities cover the P0 product. Field lists are indicative, not exhaustive — precise enough to size the build, loose enough to leave implementation detail to whoever writes the schema.

| Entity | Key fields | Notes |
|---|---|---|
| **User** | phone (E.164), timezone, goal, target macros, created_at, plan_status, opt_out_at | One row per phone number. No password, no email required at signup. |
| **MealLog** | user_id, photo_url, items[], calories, protein, carbs, fat, confidence, logged_at, source (photo/text/voice), corrected_from_id | `corrected_from_id` links an edit to the entry it replaced, so history stays honest. |
| **Goal** | user_id, type (lose/maintain/gain/protein-only), daily_calories, daily_protein, set_at, source (self/coach/clinic) | A goal set by a coach or clinic is flagged as such; the end user can still see and question it. |
| **MessageEvent** | user_id, direction, type (nudge/recap/paywall/system), sent_at, responded_at | Backs the frequency cap, the nudge-response metric, and the deliverability audit. |
| **Subscription** | user_id, plan, status, stripe_customer_id, free_analyses_used, renews_at | `free_analyses_used` is the paywall trigger, not a day count. |
| **Coach** | coach_id, name, org, dashboard_login, seat_status | Separate auth from the consumer product — dashboard login, not a phone-based session. |
| **ClientLink** | coach_id, user_id, linked_at, unlinked_at, consent_confirmed | A user must explicitly consent before a coach or clinic can see their log — this table is the consent record, not just a join table. |

## 4. Conversation flows

Every flow below states its trigger, its steps, its edge cases, and — where the shape of the exchange matters more than the description of it — a written example of the actual texts.

### 4.1 Onboarding
**Trigger:** first inbound message ever received from a phone number

1. Reply immediately with a one-line explanation of what the number does and what happens next.
2. Ask three questions, one at a time, each answerable in a few words: goal (lose / maintain / gain / hit a protein target), rough starting point, whether a coach or clinic referred them.
3. Confirm the goal back in plain numbers (calories and protein), and say explicitly that it can be changed anytime by texting "change my goal."
4. Invite the first photo. Do not ask for anything else — no name, no email, no password.

**Edge cases**
- *User sends a photo before answering the questions* — Log the meal anyway with a default goal, then finish onboarding after. Never block the first "aha" moment behind a form.
- *User doesn't respond to question 2 or 3* — One follow-up after a few hours, then proceed with sensible defaults rather than stalling the whole product on an unanswered text.
- *Message arrives outside a recognized referral (coach/clinic code)* — Treat as organic signup; referral attribution is best-effort, never a gate.

```
IN >    hi
TALLY > Hey — I'm Tally. Text me a photo of what you eat and I'll text
        back the calories and macros. Three quick questions to set your
        target, then you're logging. What's the goal — lose weight,
        maintain, gain, or just hit a protein number?
IN >    lose weight, on a glp1
TALLY > Got it. Roughly what's your current weight, and do you have a
        protein target from your provider, or should I suggest one?
IN >    190lbs, no target given
TALLY > I'll set you at 1,650 cal and 120g protein a day — easy to
        change anytime, just tell me. Send me a photo of your next meal
        whenever you're ready.
```

### 4.2 Meal logging
**Trigger:** inbound photo, or a text description of food

1. Identify items and estimate portions from the photo (or parse the text description).
2. Score confidence. Above threshold: reply with calories, protein, carbs, fat, and a one-line note, inside about ten seconds.
3. Below threshold: ask exactly one clarifying question rather than guessing — never both guess and hedge in the same reply.
4. Log the entry against the day's running total and store the photo with the entry, timestamped in the user's timezone.

**Edge cases**
- *Blurry or poorly lit photo* — Ask for a retake or a one-line description; don't return a number built on a guess about the photo itself.
- *Multiple distinct items on one plate* — Break the reply out by item, not just a single combined number, so a later correction can target one item.
- *Home-cooked / mixed dish (casserole, stir-fry)* — Return a wider confidence band explicitly ("~450–550 cal — home-cooked dishes are harder to pin exactly") rather than false precision.
- *Text-only entry, no photo* ("just had a protein shake") — Fully supported from P0 — parse the sentence the same way, log it as source: text.
- *Non-food photo sent by mistake* — Say so plainly and drop it — no log created, no guess offered.

```
IN >    [photo: bowl of stir-fry]
TALLY > ~520 cal · 34g protein · 48g carbs · 22g fat. Looks like
        chicken, rice, and mixed veg — confidence: medium, home-cooked
        dishes vary. Today: 1,180 / 1,650 cal, 78 / 120g protein.
```

### 4.3 Correction & edit
**Trigger:** a reply referencing a recent log ("that was 2 eggs not 3", "undo that")

1. Match the correction to the most recent relevant log (or ask which one, if ambiguous).
2. Recalculate and reply with the updated numbers and the new daily total.
3. Store the original entry with a link to its correction — never silently overwrite history.

**Edge cases**
- *Correction sent hours or days later* — Still honored; recalculates the total for that day, not the current one.
- *"Delete that" with no replacement* — Removes the entry from totals but keeps a soft-deleted record for the user's own history if they scroll back.

### 4.4 Proactive check-in
**Trigger:** scheduler, evaluated per user against quiet hours and caps

1. Check whether the user has already logged a meal in the relevant window; skip entirely if they have.
2. Check the frequency cap (see §5) and the user's quiet hours before considering a send.
3. Send a short, specific, easily-ignored message — never a streak count, never a guilt frame.
4. Log the send as a MessageEvent; a reply (or lack of one) feeds both the nudge-response metric and future timing.

**Edge cases**
- *User hasn't logged anything in 5+ days* — Reduce frequency automatically rather than escalating tone or volume — see §5, nagging cap.
- *User replies "stop" or any opt-out language* — Immediate and total; see §5.

```
TALLY > How'd dinner go tonight?
```
*(no photo required in the reply — a one-word answer is a valid, complete interaction)*

### 4.5 Weekly recap
**Trigger:** scheduler, once per week on a day the user picks (default: Sunday evening)

1. Summarize days logged, average calories/protein against goal, and one specific observation — not a wall of stats.
2. Close with a light, optional prompt ("want me to adjust anything for next week?") rather than a mandatory action.

### 4.6 Paywall & upgrade
**Trigger:** free-tier analysis count reaches the limit (15–20)

1. The log that crosses the threshold is still delivered in full — the wall never interrupts a meal in progress.
2. Follow with a short message explaining the free tier is used up, and a Stripe checkout link, in-thread.
3. On successful checkout, resume exactly where the thread left off — no re-onboarding, no re-confirmation.

```
TALLY > That's your 20 free logs used — you've been at this for 9 days.
        $9.99/mo keeps it going, no app required: [checkout link]
```

### 4.7 Opt-out, pause & delete
**Trigger:** STOP, "pause," "delete my data," or equivalent, in any tone

1. **STOP** is handled at the carrier level and is instant and unconditional — no confirmation message required or sent.
2. **"Pause"** stops proactive messages only; logging still works if the user texts in. Reversible by texting "resume."
3. **"Delete my data"** triggers full deletion of logs and photos within 30 days, confirmed once in writing, never re-prompted or talked out of.

### 4.8 Coach onboarding & client link
**Trigger:** a coach signs up on the web dashboard; a client texts in with a coach's referral code

1. Coach creates a dashboard account (email/password or SSO) — entirely separate from any consumer phone flow.
2. Coach shares a referral code or link; a client who texts in with it goes through the identical onboarding in §4.1, plus one added consent question: "share your logs with [coach name]? yes/no."
3. On consent, a ClientLink is created; the coach's dashboard shows that client's logs going forward, never retroactively without separate consent.
4. The client's experience is otherwise unchanged — same number, same flow, same tone.

### 4.9 Clinic enrollment
**Trigger:** a clinic or telehealth provider signs a licence agreement

1. Clinic enrolls patients in bulk via their existing intake process, not a Tally-specific form.
2. Each patient gets the same first-text onboarding, with clinic-specific consent and disclosure language (data shared with their care team, accuracy caveats, opt-out rights) added up front, not buried later.
3. Patient data for clinic-linked accounts is written to the compliance-boundary store described in §2 and §6, not the general consumer store.

## 5. Safety & guardrails

This is the most consequential section in the document. An agent that proactively texts someone about food at 8pm is operating on a genuinely sensitive surface, and getting it wrong is a brand-ending mistake, not a bad review.

| Situation | Rule |
|---|---|
| **Language suggesting restriction, purging, or compulsive logging patterns** | Never reinforce. Pause proactive check-ins for that user, respond with care rather than macros, and surface a resource contact — do not attempt to diagnose or continue logging as normal. |
| **Any nudge or recap copy** | No streaks framed as something lost, no guilt language, no comparison to other users. A skipped day is never referenced as a failure. |
| **Opt-out (STOP or plain language)** | Works on the first attempt, every time, with no retention flow, no "are you sure," no discount offer in the same message. |
| **Frequency** | Hard cap on proactive sends per day (default: one), reduced further for users who haven't engaged in 5+ days rather than increased. |
| **Accuracy claims** | Stated as an estimate, always, with confidence shown per §4.2. Onboarding states plainly that numbers are estimates, not lab measurements. |

## 6. Compliance & data handling

1. **Consumer tier:** disclose plainly, in onboarding, that SMS is not end-to-end encrypted. This is an acceptable tradeoff for a habit-tracking product and should be stated, not hidden.
2. **Clinic tier:** the moment a clinic or telehealth partner is involved, data becomes PHI-adjacent. Requires a signed BAA, encryption at rest for the clinic-scoped store, role-based dashboard access, and an audit log of every access — not optional, and not retrofitted after a first clinic contract is signed.
3. **A2P 10DLC registration:** brand and campaign registration (~$48 brand vetting + ~$15/campaign + $1.50–$10/mo), filed with an accurate use-case description, one to three weeks for approval. Get the opt-in and consent language right in this filing — a badly classified campaign silently kills deliverability, and deliverability is the retention mechanic.
4. **Retention:** a user who deletes their data gets full deletion, including photos, within 30 days — see §4.7, opt-out flow.

## 7. Metrics & instrumentation

| Metric | Definition |
|---|---|
| **Time to first log** | Minutes from first inbound message to first completed MealLog. Target: under 1. |
| **D1 / D7 / D14 / D30 retention** | Share of users who log at least once in each window after signup. D14 is the headline number — the industry's two-week cliff. |
| **Meals logged per active user per week** | Engagement depth, and a rough proxy for messaging cost per user. |
| **Nudge response rate** | Share of proactive check-ins that get any reply within an hour. Leading indicator that the psychology thesis holds. |
| **Correction rate** | Share of logs edited within 24 hours — a direct read on recognition accuracy in the field, not just in testing. |
| **Free → paid conversion** | Share of users who hit the free-tier limit and complete checkout within 7 days. |
| **Coach seat attach rate** | Average linked clients per coach seat — the number that makes coach acquisition cheaper than consumer acquisition. |
| **Message deliverability** | Share of outbound messages that land, by carrier. Falling deliverability is treated as a P0 incident, not a metrics footnote. |

## 8. Phased scope

**P0 — SMS launch**
Photo and text meal logging, three-question onboarding, one daily proactive check-in, free tier (15–20 analyses) with in-thread Stripe checkout, corrections, and full opt-out/delete. This alone has to prove the retention thesis.
*Excludes: weekly recap, coach dashboard, voice notes, iMessage.*

**P1 — Professional layer**
Weekly recap, coach dashboard v1 (client list, per-client logs, consent-linked onboarding), voice note logging, refined confidence handling based on P0 correction-rate data.
*Excludes: clinic/PHI compliance layer, Apple Messages for Business.*

**P2 — The rail**
Apple Messages for Business application and integration (verified live human support, AI disclosure, per-user platform fee), clinic licensing with the full compliance boundary from §6, advanced coach analytics (adherence trends, flagged clients).
*Started in parallel with P1 where possible — approval timelines run long and shouldn't gate consumer growth.*

## 9. Open design questions

1. **Free-tier depth.** Is 15–20 analyses the right number, or should it be measured in days-with-at-least-one-log instead of raw photo count?
2. **Nudge personalization.** Fixed 8pm default, or learn each user's typical dinner time from their own logging pattern after the first week?
3. **Confidence threshold.** Where exactly does "ask a clarifying question" kick in, and does that threshold need to differ for clinic-linked accounts, where the data feeds a care decision?
4. **Coach pricing shape.** Flat $79/seat regardless of client count, or a per-client component once a coach passes some threshold (30+ clients)?
5. **Historical corrections.** When a correction changes a past day's totals, does the weekly recap silently reflect the new number, or show both with a note?
6. **Human support requirement.** Apple's review requires verified live human support — does that mean a real person on standby from P0, or is it acceptable to build that only ahead of the P2 Apple application?

---
*Tally — Product Design Brief 02 · Companion document: 01 — Vision Brief*
