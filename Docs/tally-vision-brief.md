# Tally
### Product Design Brief 01 — Vision & Strategy

*Working name, pending trademark search.*

> A calorie tracker with no app, no account, and no home-screen icon. You text a photo of your food. It texts back the macros. That's the whole product surface.

**Prepared:** 25 Aug 2026 &nbsp;|&nbsp; **Stage:** Pre-build concept &nbsp;|&nbsp; **Category:** Consumer health · messaging &nbsp;|&nbsp; **Companion doc:** 02 — Build Spec

## At a glance

| | |
|---|---|
| **70%** | of diet-app users quit within two weeks of starting |
| **11%** | of US adults now on a GLP-1 for weight loss, up from 3% in 2024 |
| **< 60s** | target time from "I should track this" to first logged meal |
| **~4×** | net revenue per user vs. Cal AI, after messaging costs replace the App Store cut |

---

## 1. The problem isn't recognition, it's return

Cal AI proved the hard technical problem is solved. Photo in, macros out, roughly 90% accurate, built by a teenager, sold to MyFitnessPal for real money in under two years. Food recognition is a commodity now. Every serious tracker has it.

What's left is everything wrapped around the recognition: find the app, download it, create an account, sit through an onboarding quiz, then remember it exists three days later and open a fourth icon at the dinner table while the food goes cold. None of that is a technology problem. It's a sequence of small taxes, and consumer habits die from small taxes.

MyFitnessPal is the proof. 220 million people have registered. About 30 million still open it in a given month, and revenue slipped 5.7% to $310m in 2025 even so. That 190-million-person gap between sign-up and use is not a feature gap. It's a distribution problem wearing a product problem's clothes.

## 2. Move the log into the thread

Tally has no app, no account creation, and no icon to forget. The product is a phone number. You text it a photo; it texts back calories and macros. Everything else — history, reminders, upgrading — happens in the same thread, because the thread is a place you're already open fifty times a day.

**01 · The thread is the food diary**
Scroll up and last Tuesday's dinner is right there, photo attached. No export, no sync, no separate history screen to remember exists.

**02 · Onboarding is one message**
No download, no password, no account. Text the number, answer three questions about your goal, log your first meal. Under a minute, start to finish.

**03 · It texts you first**
A message at 8pm asking how dinner went reads as a normal thing to receive. A push notification from an app you last opened nine days ago reads as an app begging. Same intent, opposite psychology — and it's the only lever in this category that meaningfully moves the two-week cliff.

**04 · No app, no App Store tax**
Cal AI charges $29.99 a year and keeps about $21 of it. Bill $9.99 a month on the web and keep roughly $116 a year on the same customer, same job. The trade is a 30% carrier tax for a 30% App Store tax — a wash in structure, not in size, because messaging costs scale with usage instead of revenue.

## 3. What using it actually looks like

Five moments carry the entire product. Nothing else needs to exist for the core loop to work.

| Moment | What happens | Why it matters |
|---|---|---|
| **First text** — GLP-1 patient, referred by a Reddit thread | Texts the number, answers three questions (goal, current weight range, protein target or none), logs lunch inside the same thread. | Zero-download activation is the whole friction thesis in one interaction. |
| **Daily logging** — any user, any meal | Sends a photo. Gets calories, protein, carbs, fat, and a one-line note back in under ten seconds. No app to open first. | This is the moment competitors also win. It has to feel at least as good, not better. |
| **The nudge** — user hasn't logged dinner by 8pm | Gets a short, human check-in — not a streak-shame, not a red badge. Easy to answer, easy to ignore once. | The retention mechanic nobody else in this category has. This is the bet the whole business is built on. |
| **A coach's client** — referred by their trainer | Texts exactly the same number, the same way. Does nothing different. Their coach sees the log on a dashboard. | Acquisition and support both happen through someone who already has the relationship — at zero marginal cost to Tally. |
| **A clinic's patient** — enrolled by a GLP-1 telehealth provider | Same texting experience, but adherence data flows to a care team that already texts its patients for other things. | Sells into a workflow that already exists instead of asking anyone to adopt a new one. |

## 4. Sell the seat, not just the subscription

The consumer product is the wedge. The dashboard sitting on top of the same data is where the durable margin lives, because coaches and clinics buy on behalf of many end users at once, and the end user's experience never changes.

| Tier | Buyer | Price | What they get |
|---|---|---|---|
| **Consumer** | Individual | $9.99/mo | Unlimited logging, daily check-ins, weekly recap. First 15–20 analyses free. |
| **Coach seat** | Trainer / online coach | $79/mo | Client dashboard, real-time logs across every client, zero change to the client's experience. |
| **Clinic licence** | GLP-1 clinic / telehealth provider | Per patient/mo | Adherence data feeding an existing care workflow, priced and contracted per partner. |

One coach with 25 clients is 25 users acquired at zero cost, and the coach becomes the support layer for free. Ten coaches is a cohort large enough to measure retention properly — which is the whole point, because the retention curve *is* the marketing.

## 5. Why this wins the moment, not just the argument

The channel is contested and the underlying vision model is not defensible — any competent team can match Cal AI's ~90% accuracy for fractions of a cent per photo. What's actually unclaimed is narrower and more specific.

| Player | Channel | Proactive? | Where they're weak |
|---|---|---|---|
| **Cal AI / MyFitnessPal** | App | Push only | Now one company; structurally committed to App Store billing and an icon nobody opens. |
| **KCALM, Kcaly AI, WhatFit** | WhatsApp / Telegram | Partial | Already proved the no-app thesis — everywhere except the US, where WhatsApp isn't the default channel. |
| **Rex.fit** | SMS | Yes | Closest direct comparison; sells a wearable too, suggesting they see texting as a front end to hardware, not the whole product. |
| **Poke** | iMessage (Apple-approved) | Yes | Horizontal assistant — nutrition is one feature among many, not the whole thesis. Most likely company to eat this as a side quest. |
| **Tally** | SMS first, iMessage second | Yes, by design | US-first, single-purpose, sold through coaches and clinics before consumers. |

> **The honest read:** the technology is not the moat. The coach and clinic relationship is, along with whatever retention advantage gets proven and then owned. This is a US-first, iMessage-native wedge that nobody else has bothered to build, sold through professionals rather than an app store search.

## 6. How it gets big

Three phases, each one funded by proof from the last.

**Phase I — Wedge: SMS, GLP-1 communities, coaches**
Launch on plain SMS this month; A2P 10DLC registration is a two-to-three-week process, not a technical blocker. Recruit the first hundred users from GLP-1 subreddits and Facebook groups. Sell through ten coaches before spending a dollar on consumer acquisition. Target: beat 30% two-week retention over a 60-day cohort.

**Phase II — Platform: iMessage, coach dashboard, clinic pilots**
Take the retention curve to Apple's Messages for Business review in parallel with consumer growth, not as a blocker to it. Formalize the coach dashboard as a real product. Pilot with one or two GLP-1 clinics under a proper data-handling agreement.

**Phase III — Rail: the default logging layer for adherence**
The ceiling case: telehealth providers and GLP-1 clinics plug their patients into Tally as infrastructure, not as an app their patients are asked to download. This is the only path to a business meaningfully larger than a well-run consumer subscription.

## 7. The bet, stated plainly

Retention in this category correlates with seconds per meal, not motivation. Removing the app doesn't just remove friction — it changes what a reminder feels like, from an app begging to be reopened into a person checking in. That's a psychological shift, not a UX polish, and it's the whole thesis.

The test is cheap and fast: a Twilio number, a vision model, a Stripe link, a hundred people from a GLP-1 subreddit, sixty days. If the two-week retention curve clears 30% where the category average sits closer to it from the wrong side, there is something here nobody else in calorie tracking has been able to buy.

**What "working" looks like at 90 days**

| Signal | Target |
|---|---|
| Two-week retention (still logging) | > 30% |
| Time from first text to first logged meal | < 1 min |
| Nudge response rate (8pm check-in) | > 25% |
| Free-to-paid conversion | > 8% |
| Coaches with 10+ clients enrolled | ≥ 10 |

## 8. Said honestly

Four risks worth naming before anyone gets excited about the upside.

| Risk | Severity | How it's handled |
|---|---|---|
| **Apple's door is barely open.** One agent approved, live human support required, per-user platform fees. | Watch | Build the business on plain SMS; treat iMessage as upside, not the plan. |
| **Carrier filtering** can silently kill deliverability, and deliverability *is* the retention mechanic here. | Risk | Correct A2P 10DLC campaign registration and opt-in language from day one, not retrofitted later. |
| **Platform risk in both directions** — Apple could ship this into Siri; MyFitnessPal could stand up a text number in a fortnight. | Risk | Speed and the coach relationship are the only real defenses. Move first, own the relationship. |
| **Sensitive surface** — an agent proactively texting about food at 8pm needs real safeguards, or it's a brand-ending mistake, not just a bad review. | Risk | Full protocol in the build spec: opt-outs that work first time, a hard line against anything that reads as nagging, disordered-eating detection. |

## 9. Closing thought

The category already solved the hard part and kept treating it as the whole product. Cal AI proved photo logging works, sold, and left the actual bottleneck untouched: apps are a place you have to go, and messages are a place you already are.

Moving the log into the thread does three things at once — it removes every step between intent and logging, it makes a proactive check-in feel normal instead of desperate, and it takes the App Store's 30% off the top. Same customer, roughly four times the net revenue per head, purely because of where the interaction happens. The tailwind is dated and real: GLP-1 adoption has quadrupled in two years, Medicare started covering it for weight loss in July, and 85% of those patients drop off within two years with no adherence layer built for them at all.

---
*Tally — Product Design Brief 01 · Companion document: 02 — Build Spec*
