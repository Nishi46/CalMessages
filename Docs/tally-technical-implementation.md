# Tally — Technical Implementation
### Technical Design Doc 04 — Implementation Spec

> Schema, contracts, state tables, and build sequencing detailed enough to start writing code against. Assumes the shape described in 03 — Architecture; this doc is where the components get concrete.

**Prepared:** 24 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture &nbsp;|&nbsp; **Status:** Pre-build

## At a glance

| | |
|---|---|
| **7** | tables in the consumer schema, 1:1 with Build Spec §3 |
| **9** | conversation states in the P0 machine |
| **4** | Stripe/Twilio webhook events the system must handle idempotently |
| **3** | phases of build sequencing, mapped to Build Spec §8 |

---

## 1. Stack & rationale

Recommendations, not mandates — chosen to keep the fast path thin (Architecture §1) and every dependency swappable.

| Layer | Choice | Why |
|---|---|---|
| **Application language** | TypeScript (Node.js) | Single language across webhook handlers, workers, and the dashboard API/frontend; strong typing pays off in a state-machine-heavy system where an invalid transition should be a compile error, not a runtime surprise. |
| **API framework** | Fastify (or equivalent minimal framework) | Low request overhead matters directly against the ~10s reply budget; schema-validated routes double as webhook payload contracts. |
| **Database** | Supabase (managed Postgres), two separate projects — consumer + clinic | Relational fit per Architecture §3.4; two logically identical schemas, physically isolated Supabase projects (separate instance, separate credentials, separate connection pooler) for the compliance boundary. Row Level Security gives the consent/panel-scoping rules in §9–10 a database-enforced backstop, not just an application-layer filter — see §3.3. |
| **Queue / cache** | Redis + BullMQ | Job queue for proactive sends and retries; also backs the conversation-state read cache in front of Supabase. Supabase does not provide a job queue, so Redis remains a separate managed service. |
| **Object storage** | S3-compatible bucket | Meal photos; DB stores keys, never blobs. |
| **Vision model** | Hosted multimodal API (provider-agnostic interface) | Treated as commodity per Vision Brief §1 — integration is a single `recognize()` adapter, swappable without touching orchestration. |
| **Messaging** | Twilio Programmable SMS/MMS | Mandated by the product's channel choice (A2P 10DLC); no alternative considered for P0. |
| **Billing** | Stripe Checkout + Webhooks | Mandated by build spec §2. |
| **Dashboard frontend** | Next.js (or equivalent SSR React) | Server-rendered auth-gated pages fit a low-traffic, high-trust internal-facing tool better than a heavy SPA. |
| **Hosting** | Any platform supporting stateless containers + managed Redis (e.g., Fly.io, Render, AWS ECS), with Supabase hosting the database tier | Application/worker hosting stays portable; the database tier is intentionally pinned to Supabase for RLS, Auth, and pooling rather than treated as an interchangeable managed-Postgres commodity. |

## 2. Repository / service structure

```
tally/
├── apps/
│   ├── api/                 # Webhook handlers, dashboard API, stateless app tier
│   ├── worker/               # Scheduler (leader) + queue consumers
│   └── dashboard/             # Coach/clinic web frontend
├── packages/
│   ├── db-consumer/           # Consumer schema, migrations, typed query layer
│   ├── db-clinic/              # Clinic schema, migrations, typed query layer (separate package = separate credentials by construction)
│   ├── vision/                 # recognize(photo) / parse(text) interface + provider adapters
│   ├── conversation/            # State machine definitions + transition logic
│   ├── messaging/                 # Twilio adapter (send/receive), channel-agnostic interface
│   ├── billing/                    # Stripe adapter
│   └── shared-types/                # MealCandidate, ConversationState, etc.
└── infra/                            # IaC, migration runners, secrets config
```

The `db-consumer` / `db-clinic` split as separate packages (not just separate schemas imported from one package) is deliberate: it makes it a compile-time impossibility for a consumer-side handler to accidentally import a clinic query, reinforcing the boundary from Architecture §5 at the code level, not just the network level. Each package holds its own Supabase project URL and service-role key — there is no code path anywhere in the repo with valid credentials for both projects at once.

## 3. Database schema

### 3.1 Consumer store

```sql
-- User: one row per phone number, no password/email required
CREATE TABLE "user" (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164      TEXT NOT NULL UNIQUE,
    timezone        TEXT NOT NULL DEFAULT 'America/New_York',
    plan_status     TEXT NOT NULL DEFAULT 'free', -- free | active | past_due | canceled
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    opt_out_at      TIMESTAMPTZ,
    paused_at       TIMESTAMPTZ,
    referral_code   TEXT,               -- coach/clinic referral, best-effort attribution
    conversation_state TEXT NOT NULL DEFAULT 'new', -- see §6
    conversation_context JSONB          -- e.g. held meal candidate awaiting clarification
);
CREATE INDEX idx_user_phone ON "user"(phone_e164);
CREATE INDEX idx_user_state ON "user"(conversation_state) WHERE opt_out_at IS NULL;

-- Goal: current + historical goals, one active per user
CREATE TABLE goal (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES "user"(id),
    type            TEXT NOT NULL, -- lose | maintain | gain | protein_only
    daily_calories  INT,
    daily_protein   INT,
    set_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    source          TEXT NOT NULL DEFAULT 'self', -- self | coach | clinic
    superseded_at   TIMESTAMPTZ  -- null = currently active
);
CREATE INDEX idx_goal_active ON goal(user_id) WHERE superseded_at IS NULL;

-- MealLog: append-only; corrections and deletes are new rows, never in-place edits
CREATE TABLE meal_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES "user"(id),
    photo_url           TEXT,
    items                JSONB NOT NULL DEFAULT '[]', -- [{name, portion, calories, protein, carbs, fat}]
    calories             INT,
    protein               INT,
    carbs                  INT,
    fat                     INT,
    confidence               TEXT NOT NULL, -- high | medium | low
    source                    TEXT NOT NULL, -- photo | text | voice
    logged_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    local_date                DATE NOT NULL, -- day bucket in user's timezone, set at write time
    corrected_from_id          UUID REFERENCES meal_log(id),
    soft_deleted_at             TIMESTAMPTZ
);
CREATE INDEX idx_meal_user_date ON meal_log(user_id, local_date) WHERE soft_deleted_at IS NULL;

-- MessageEvent: every send/receive, backs frequency cap + nudge-response metric
CREATE TABLE message_event (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES "user"(id),
    direction       TEXT NOT NULL, -- inbound | outbound
    type            TEXT NOT NULL, -- nudge | recap | paywall | system | log_reply
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at    TIMESTAMPTZ,
    twilio_sid      TEXT,
    delivery_status TEXT -- queued | sent | delivered | failed | undelivered
);
CREATE INDEX idx_msgevent_user_type_sent ON message_event(user_id, type, sent_at);
-- Frequency cap query: count outbound nudges where sent_at::date = today

-- Subscription: metering + plan state
CREATE TABLE subscription (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES "user"(id),
    plan                TEXT NOT NULL DEFAULT 'free',
    status               TEXT NOT NULL DEFAULT 'active', -- active | past_due | canceled
    stripe_customer_id    TEXT,
    stripe_subscription_id TEXT,
    free_analyses_used     INT NOT NULL DEFAULT 0,
    free_analyses_limit      INT NOT NULL DEFAULT 20,
    renews_at                 TIMESTAMPTZ
);

-- Coach: dashboard-side identity, separate auth from consumer sessions
CREATE TABLE coach (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    org             TEXT,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT, -- null if SSO-only
    referral_code   TEXT NOT NULL UNIQUE,
    seat_status     TEXT NOT NULL DEFAULT 'active', -- active | suspended
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ClientLink: the consent record, not just a join table
CREATE TABLE client_link (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coach_id            UUID NOT NULL REFERENCES coach(id),
    user_id             UUID NOT NULL REFERENCES "user"(id),
    linked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    unlinked_at         TIMESTAMPTZ,
    consent_confirmed    BOOLEAN NOT NULL DEFAULT false,
    consent_confirmed_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_clientlink_active ON client_link(coach_id, user_id) WHERE unlinked_at IS NULL;
-- Every dashboard read joins through this table filtered on consent_confirmed = true AND unlinked_at IS NULL
```

### 3.2 Clinic store (isolated instance, per Architecture §5)

```sql
-- Mirrors consumer shape where relevant, but is a physically separate database.
CREATE TABLE clinic (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    baa_signed_at   TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE clinic_patient (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID NOT NULL REFERENCES clinic(id),
    phone_e164      TEXT NOT NULL UNIQUE, -- clinic-linked users never also exist as consumer `user` rows
    timezone        TEXT NOT NULL,
    enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    consent_disclosure_ack_at TIMESTAMPTZ, -- clinic-specific consent language, §4.9
    conversation_state TEXT NOT NULL DEFAULT 'new',
    conversation_context JSONB
);

-- meal_log, goal, message_event, subscription-equivalent tables mirror the consumer
-- schema structurally but live only in this database, scoped by clinic_patient_id.

CREATE TABLE clinic_staff (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID NOT NULL REFERENCES clinic(id),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT,
    role            TEXT NOT NULL, -- care_team | admin
    panel_scope     UUID[] -- patient ids this staff member may access, if panel-restricted
);

-- Every read AND write is logged — this table is what makes the store audit-ready.
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_type      TEXT NOT NULL, -- clinic_staff | system
    actor_id        UUID,
    action          TEXT NOT NULL, -- read | write | export
    resource_type   TEXT NOT NULL, -- clinic_patient | meal_log | goal
    resource_id     UUID,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata        JSONB
);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, occurred_at);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id, occurred_at);
```

Application-level enforcement, not just schema: the query layer package (`db-clinic`) wraps every read in a mandatory audit-log write in the same transaction — there is no code path in that package that returns patient data without producing an audit row.

### 3.3 Supabase-specific configuration

Two separate **Supabase projects** — not two schemas on one project, not two schemas within one database — back the consumer/clinic split, so the physical isolation from Architecture §5 is a platform-level property (separate Postgres instance, separate API keys, separate dashboard, separate backup/restore) rather than something the application has to maintain by discipline alone.

- **Row Level Security (RLS) as a second enforcement layer.** The application query layer already scopes coach/clinic reads through `client_link` and `panel_scope` (§9, §10). RLS policies on the consumer project enforce the same rule *inside the database*, so a bug in application-layer filtering — a missing `WHERE`, a route that forgets to scope — fails closed instead of leaking data:

  ```sql
  ALTER TABLE meal_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE goal ENABLE ROW LEVEL SECURITY;

  -- A coach-authenticated request can only ever select meal_log rows for
  -- users where an active, consented client_link exists. The coach_id is
  -- read from the verified JWT claim set by the dashboard's Supabase Auth
  -- session, not from a client-supplied parameter.
  CREATE POLICY coach_scoped_meal_log ON meal_log
    FOR SELECT
    USING (
      user_id IN (
        SELECT user_id FROM client_link
        WHERE coach_id = (auth.jwt() ->> 'coach_id')::uuid
          AND unlinked_at IS NULL
          AND consent_confirmed = true
      )
    );

  -- The messaging/orchestration service role bypasses RLS (service-role key),
  -- since it legitimately reads/writes across all users. RLS here exists to
  -- constrain the *dashboard*-facing connection, which authenticates as the
  -- coach, not as the service role.
  ```

  The clinic project applies the equivalent policy against `clinic_staff.panel_scope` instead of `client_link`. This does not replace the `audit_log` requirement in §3.2 — RLS controls *whether a row is returned*, the audit log records *that it was requested* — the two are complementary, not substitutes for each other.
- **Connection pooling.** The application tier is stateless and horizontally scaled (Architecture §6); it connects through Supabase's built-in pooler (Supavisor) in transaction mode rather than opening direct Postgres connections per instance, so scaling app replicas doesn't scale connection count 1:1 against the database.
- **Extensions**: `pgcrypto` (for `gen_random_uuid()` used throughout §3.1–3.2) is enabled by default on a new Supabase project — no manual extension setup required.
- **Migrations** run via the Supabase CLI (`supabase migration new` / `db push`) per project, keeping the independent migration histories called out in §13 — the consumer and clinic projects are never migrated by the same command or CI job.

## 4. Twilio integration

### 4.1 Inbound webhook contract

`POST /webhooks/twilio/inbound`

1. Verify `X-Twilio-Signature` against the raw request body and the configured auth token. Reject (403) on mismatch — no further processing.
2. Parse `From` (E.164), `Body` (text, if any), `NumMedia` + `MediaUrl0..N` (photo, if any).
3. Resolve or create the `User`/`ClinicPatient` row by phone number (creation only on truly first contact — see §6.1 onboarding state).
4. If media present: fetch `MediaUrl0` immediately (Twilio media URLs are time-limited) and persist to object storage before anything else touches the request.
5. Hand off `{ user_id, text?, photo_key?, current_state }` to the conversation router (§6).
6. Return TwiML (empty `<Response/>` is fine — replies are sent async via the REST API, not the webhook response, so the reply pipeline is identical whether it's a fast-path log reply or a delayed clarification).

### 4.2 Outbound send

All outbound messages — fast-path replies, nudges, recaps, paywall — go through one `sendMessage(userId, body, type)` function in the `messaging` package, which:
- Checks `opt_out_at` is null (defense in depth; Twilio already suppresses at carrier level, but the app should never even attempt).
- Writes a `MessageEvent` row before calling Twilio's API, with `delivery_status = 'queued'`.
- Updates `delivery_status` from Twilio's status callback webhook (`/webhooks/twilio/status`).

### 4.3 STOP/START handling

- Twilio intercepts `STOP` at the carrier level automatically — no application code decides whether to honor it.
- The application still subscribes to Twilio's opt-out status callback to set `User.opt_out_at`, which:
  - Removes the user from the scheduler's eligible set (Architecture §3.3) so sends aren't even attempted.
  - Feeds the deliverability metric (Build Spec §7) — an opt-out is logged distinctly from a delivery failure.
- `START` reverses `opt_out_at` the same way, symmetrically.

## 5. Vision & parsing pipeline

### 5.1 Interface

```typescript
interface MealCandidate {
  items: { name: string; portion: string; calories: number; protein: number; carbs: number; fat: number }[];
  calories: number; protein: number; carbs: number; fat: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceNote?: string; // e.g. "home-cooked dishes vary"
  isFood: boolean; // false short-circuits to the non-food edge case, §4.2
}

interface VisionProvider {
  recognize(photoKey: string): Promise<MealCandidate>;
}
interface TextParser {
  parse(text: string): Promise<MealCandidate>;
}
```

### 5.2 Confidence scoring

Confidence is computed in application code, not taken as a raw model output (Architecture §3.2), combining:

| Signal | Effect |
|---|---|
| Model-reported certainty per item | Base signal |
| Item count on the plate | More distinct items lowers aggregate confidence |
| Dish category (packaged/branded vs. home-cooked/mixed) | Packaged food with visible labeling → high; stir-fry/casserole-type dishes → capped at medium, per Build Spec §4.2 |
| Portion reference available (utensil, hand, known plate size) | Missing reference lowers confidence one tier |

Thresholds: `high`/`medium` deliver a full reply; `low` triggers the single clarifying question and holds the candidate in `User.conversation_context` rather than writing `MealLog`. Tuning these thresholds against real correction-rate data is explicitly called out as a P1 activity (Build Spec §9, open question 3) — the scorer is built as a pure function of these signals specifically so the thresholds can move without a redeploy of the vision integration itself.

### 5.3 Non-food and low-quality photos

`isFood: false` and "too blurry/dark to assess" are both modeled as terminal candidate states — the router replies per Build Spec §4.2 edge cases (say so plainly / ask for retake) and never writes a `MealLog` or holds conversation state waiting on a guess.

## 6. Conversation state machine

### 6.1 States (P0)

| State | Meaning | Entered from | Exits to |
|---|---|---|---|
| `new` | No prior contact | — | `onboarding_q1` on first inbound |
| `onboarding_q1` / `_q2` / `_q3` | Mid three-question onboarding | `new`, or previous question | Next question, or `idle` on completion |
| `idle` | Normal steady state, ready for a log or command | Onboarding complete, or post-clarification | `awaiting_clarification`, `awaiting_checkout`, stays `idle` after a completed log |
| `awaiting_clarification` | Held a low-confidence candidate, asked one question | `idle`, on low-confidence log | `idle` on resolution |
| `awaiting_checkout` | Free tier exhausted, checkout link sent | `idle`, on paywall trigger | `idle` on Stripe webhook confirming payment |
| `paused` | Proactive messages suppressed, logging still works | `idle`, on "pause" | `idle` on "resume" |
| `care_pause` | Safety guardrail triggered (§11) — proactive suppressed, tone shifted | Any state, on flagged language | Manual/careful transition only, never automatic |
| `deleted` | Deletion requested, 30-day purge in progress | Any state, on "delete my data" | Terminal |

Transitions are defined as a lookup table (`{fromState, trigger} -> {toState, sideEffect}`) in the `conversation` package — the router matches inbound intent (onboarding answer, meal content, correction, command word, opt-out language) against the current state, not a general-purpose NLU intent classifier layered on top. This keeps the machine auditable: every transition is enumerable and testable.

### 6.2 Timeout-driven transitions

The build spec calls for stall-avoidance ("one follow-up after a few hours, then proceed with sensible defaults," §4.1) — implemented as delayed jobs enqueued alongside the state transition itself:

- Entering `onboarding_q2` or `_q3` enqueues a follow-up job for N hours later.
- If the state has already advanced by the time the job runs, it's a no-op (checked against current `conversation_state` before firing).
- If still stalled, the follow-up fires once, then a second delayed job applies the default and advances to `idle` regardless of response.

### 6.3 Correction routing (§4.3)

A `correction` intent match against `idle` state resolves the target `meal_log` row by: most recent log for that user within a lookback window (same-day, then prior days if referenced explicitly — "yesterday's lunch"), disambiguating by asking which entry if more than one plausible match exists. Resolution writes a new `meal_log` row with `corrected_from_id` set and recalculates `local_date` totals for *that* entry's date, not the current date (edge case in Build Spec §4.3).

## 7. Scheduler implementation

### 7.1 Evaluation loop

Runs on a fixed interval (e.g., every 15 minutes) as a leader-elected singleton (Architecture §6):

```
for each active user (opt_out_at IS NULL, paused_at IS NULL, conversation_state = 'idle'):
    if local_time(user.timezone) not in nudge_window: continue
    if already logged today (meal_log where local_date = today): continue
    if quiet_hours(user): continue
    if outbound MessageEvent(type='nudge') count today >= daily_cap: continue
    if days_since_last_log >= 5: apply reduced-frequency rule (skip more often, never escalate)
    enqueue nudge job (idempotency key: user_id + local_date)
```

### 7.2 Quiet hours & timezone

`User.timezone` (captured or inferred at onboarding, defaulted if unknown) drives every time-of-day decision — the nudge window (default ~8pm local, Build Spec open question 2 flags this as tunable/learnable in P1), quiet hours, and the weekly recap's chosen day all evaluate against local time, never server time.

### 7.3 Frequency cap enforcement

Default: one proactive send per day, hard cap, enforced twice — once by the scheduler (cheap pre-filter) and once by the queue consumer immediately before sending (authoritative check against `message_event`, closing the race described in Architecture §7). The 5+ day disengagement rule reduces cadence multiplicatively rather than suppressing entirely, per Build Spec §5 ("reduced further... rather than increased").

### 7.4 Weekly recap (P1)

Same queue, a second producer: a once-weekly job per user (day-of-week configurable, default Sunday evening local time) that aggregates `meal_log` and `goal` over the trailing 7 days and composes the summary described in Build Spec §4.5. Explicitly out of scope for P0 (Build Spec §8) but designed against the same pipeline from day one so it's additive, not a rebuild.

## 8. Billing implementation

### 8.1 Free-tier metering

- `subscription.free_analyses_used` increments in the same DB transaction as a successful `meal_log` insert (not text/voice-vs-photo distinguished — every completed analysis counts, per Build Spec §3 note that it's a count, not a day tally).
- After the increment, check `free_analyses_used >= free_analyses_limit`. If crossed for the first time (state was previously under limit), enqueue the paywall message *after* the log reply has already been sent — ordering matters here per Build Spec §4.6 step 1.

### 8.2 Checkout flow

1. Paywall message includes a Stripe Checkout link generated via `stripe.checkout.sessions.create`, with `client_reference_id = user.id` and success/cancel URLs pointing to a minimal confirmation page (no account creation on that page — the phone number is the identity).
2. User completes payment on Stripe's hosted page.
3. `checkout.session.completed` webhook fires: look up `user_id` from `client_reference_id`, upsert `Subscription` (`status = active`, store `stripe_customer_id`/`stripe_subscription_id`), transition `conversation_state` from `awaiting_checkout` back to `idle`.
4. Send one confirmation text and resume — no re-onboarding (Build Spec §4.6 step 3).

### 8.3 Webhook idempotency

All Stripe webhook handlers key off Stripe's event ID (store processed event IDs, short-lived dedup table or a unique constraint) — Stripe explicitly documents at-least-once delivery, so handlers must be safe to receive the same event twice without double-crediting a subscription.

### 8.4 Subscription lifecycle

`customer.subscription.updated` / `.deleted` webhooks keep `Subscription.status` current for `past_due`/`canceled` states; a periodic reconciliation job (daily) re-fetches subscription status for any account whose local state hasn't been touched by a webhook in an unexpectedly long window, as a backstop per Architecture §7.

## 9. Coach dashboard implementation

### 9.1 Auth

Supabase Auth backs coach/clinic dashboard sessions (email/password, magic link, or SSO) — entirely disjoint from any phone-based flow, and disjoint from the service-role credentials the messaging/orchestration services use. A coach's session is a Supabase Auth JWT carrying `coach_id` as a custom claim; that claim is what the RLS policies in §3.3 read directly, so "which client rows can this session see" is enforced the same way whether the request comes through the dashboard API or (hypothetically) straight to the database. Session tokens are scoped to `coach_id` (or `clinic_staff_id` + `panel_scope`), never to a `user_id`/`phone_e164` — there is no `auth.users` row in either Supabase project for a consumer phone number, since the consumer side authenticates by phone number/carrier trust, not by a login.

### 9.2 API surface (consumer/coach side)

| Endpoint | Access | Behavior |
|---|---|---|
| `GET /api/coach/clients` | Coach session | Returns users with an active, consented `client_link` for this `coach_id` only |
| `GET /api/coach/clients/:id/logs` | Coach session | 404s (not 403 — no existence leak) if no active `client_link` matches `coach_id` + `:id` |
| `POST /api/coach/invite` | Coach session | Generates/rotates referral code; no client data touched |
| `POST /api/coach/clients/:id/unlink` | Coach session | Sets `unlinked_at`; does not delete history, just ends future visibility |

No endpoint exists under `/api/coach/*` that accepts a body writing to `meal_log` or `goal` — this is a route-table-level guarantee (those handlers simply aren't registered), not a permission check that could be misconfigured.

### 9.3 Clinic dashboard

Structurally identical pattern against the clinic store, with the added requirement that every `GET` handler wraps its query in the `db-clinic` package's mandatory audit-log write (§3.2). Panel-scoped staff (`clinic_staff.panel_scope`) are filtered at the query layer, same enforcement pattern as `client_link` on the consumer side.

## 10. Compliance implementation

- **Physical separation**: enforced by the repo structure (§2) and separate connection strings/credentials per environment — there is no shared ORM instance or connection pool spanning both stores.
- **Encryption at rest**: Supabase's default encryption at rest for both projects; additionally, field-level encryption (application-layer, e.g. AES-GCM with keys in the secrets manager) on `clinic_patient` fields most sensitive to a breach and on any care-team notes field added in P2.
- **BAA readiness checklist** (tracked against Build Spec §6):
  - Signed BAA on file before `clinic.baa_signed_at` is set — no patient rows are writable for a clinic without it (enforced by a check constraint / application guard).
  - Audit log covers 100% of reads and writes to clinic-side PHI tables (§3.2).
  - Role-based access via `clinic_staff.panel_scope`.
  - Documented data retention and deletion procedure, mirroring §4.7's 30-day consumer deletion commitment, extended to clinic data under BAA terms.
- **Disclosure language**: onboarding copy differs by entry path — organic/coach-referred users get the standard SMS-is-not-encrypted disclosure (Build Spec §6.1); clinic-enrolled patients get the added consent/disclosure block up front (Build Spec §4.9 step 2) — implemented as a template variant selected by enrollment path at `new` → `onboarding_q1`, not a later add-on screen.

## 11. Safety guardrail implementation

Build Spec §5 is the highest-stakes table in the source docs; implementation notes:

- **Detection**: a lightweight classifier/keyword-and-pattern layer runs on inbound text (and can be extended to model-flagged signals from the vision/parsing step, e.g., unusually low logged intake alongside restrictive language) — tuned deliberately toward higher false-positive tolerance, since the cost of a missed flag is categorically worse than an unnecessary care-toned reply.
- **On flag**: transition to `care_pause` (§6.1) — this suppresses the scheduler's eligibility for that user (proactive check-ins stop immediately) and swaps the reply template set to a care-oriented, non-macro response with a resource contact, per Build Spec §5. This state is not auto-exited by any timer or keyword — a flagged user returning to normal logging behavior does not silently clear the flag; it's treated as a state requiring deliberate review, not a bug to auto-heal.
- **Nudge/recap copy**: template review checklist enforced at authoring time (no streak counts, no "you missed," no cross-user comparison) — copy lives in a reviewed template set, not freely generated per-send text, specifically so this constraint is enforceable by review rather than by hoping a generation prompt holds.

## 12. Observability & metrics

Each Build Spec §7 metric maps to a concrete computation:

| Metric | Source query |
|---|---|
| Time to first log | `min(meal_log.logged_at) - user.created_at` |
| D1/D7/D14/D30 retention | Cohort query: users with `created_at` in window X who have any `meal_log.logged_at` in the corresponding later window |
| Meals logged per active user/week | `count(meal_log) / count(distinct user_id)` over trailing 7 days, excluding soft-deleted |
| Nudge response rate | `message_event` where `type='nudge'` and `responded_at IS NOT NULL` within 1hr, over all nudges sent |
| Correction rate | `count(meal_log where corrected_from_id IS NOT NULL and logged_at - corrected_from.logged_at < 24h) / count(meal_log)` |
| Free → paid conversion | Users hitting `free_analyses_used = free_analyses_limit`, joined against `subscription.status='active'` within 7 days |
| Coach seat attach rate | `count(client_link where unlinked_at IS NULL) / count(coach where seat_status='active')` |
| Message deliverability | `message_event.delivery_status` distribution from Twilio status callbacks, by carrier (Twilio exposes carrier info on lookup) |

A falling deliverability metric is wired to alert as a P0 incident (Build Spec §7), not surfaced only on a dashboard someone has to check.

## 13. Environments, secrets, deployment

- **Environments**: `dev`, `staging`, `production` — each with its own Twilio number/messaging service, Stripe account (test/live), and its own pair of Supabase projects (consumer + clinic). Staging never points at a real A2P-registered number used for production traffic, and never at the production Supabase projects.
- **Secrets**: Twilio auth token, Stripe secret/webhook keys, vision provider API key, Supabase service-role keys (one per project — consumer and clinic are separate secrets), field-level encryption keys — all in a managed secrets store, injected at runtime, never committed. The clinic project's service-role key and field-level encryption keys are held on a narrower access list than general application secrets, consistent with the compliance boundary in §10. The Supabase anon/public key (RLS-constrained) is the only credential the coach/clinic dashboard frontend ever holds directly.
- **Deploy**: stateless app/worker containers behind standard CI (test → build → deploy), with the clinic-side migration path requiring separate, explicit approval given the compliance stakes — not bundled into the same auto-deploy as consumer-side schema changes.
- **Migrations**: managed per-package (`db-consumer`, `db-clinic`) via the Supabase CLI, with independent migration histories per project — reinforces that these are separate systems, not a shared schema with a partition key.

## 14. Testing strategy

| Layer | Approach |
|---|---|
| **State machine** | Table-driven unit tests: every `{state, trigger}` pair in §6.1 has an explicit expected transition test, including undefined pairs asserting a safe no-op/fallback rather than a crash. |
| **Vision/parsing** | Golden-set regression tests against a fixed corpus of sample photos/descriptions with known-correct macros, tracking confidence-tier drift over provider or prompt changes. |
| **Scheduler** | Simulated clock tests covering quiet hours, timezone edges (midnight rollover, DST transitions), frequency cap boundary conditions, and the double-fire race from Architecture §7. |
| **Billing** | Stripe webhook fixtures replayed twice to assert idempotency; free-tier boundary tested at exactly `limit - 1`, `limit`, `limit + 1`. |
| **Compliance boundary** | A CI check asserting no code in `apps/api` or `apps/worker` imports both `db-consumer` and `db-clinic` in the same handler file (lint rule, not just convention), plus policy tests that authenticate as a coach JWT with no matching `client_link` and assert the RLS policies in §3.3 return zero rows rather than relying on the application layer to have filtered correctly. |
| **Conversation simulation** | End-to-end scripted conversations (onboarding → log → correction → paywall → checkout) run against a test Twilio number/sandbox, mirroring the example transcripts in Build Spec §4. |

## 15. Build sequencing (mapped to Build Spec §8)

**P0 — SMS launch**
1. Provision the consumer Supabase project; consumer schema (§3.1) + migrations + RLS policies (§3.3).
2. Twilio inbound/outbound adapter (§4) + signature verification.
3. Conversation state machine: `new` → onboarding → `idle` (§6.1, onboarding subset).
4. Vision provider adapter + confidence scorer (§5) — photo and text paths both, per Build Spec §4.2 ("fully supported from P0").
5. Meal logging fast path end-to-end (§ Architecture 4.1).
6. Correction/edit flow (§6.3).
7. Scheduler: single daily nudge, quiet hours, frequency cap, 5-day disengagement rule (§7.1–7.3).
8. Stripe integration: metering, checkout, webhook handling (§8).
9. Opt-out/pause/delete (§6.1 `paused`/`deleted` states; Twilio STOP integration §4.3).
10. Safety guardrail detection + `care_pause` (§11) — treated as launch-blocking, not a fast-follow, given Build Spec §5's framing.
11. Metrics instrumentation (§12) live before the first real cohort, not added retroactively.

**P1 — Professional layer**
1. Weekly recap producer (§7.4).
2. Coach schema (`coach`, `client_link`) + dashboard auth + scoped API (§9).
3. Consent-linked onboarding variant (§10, disclosure template branch).
4. Voice note logging: extend `TextParser` interface to accept transcribed audio, same `MealCandidate` contract.
5. Confidence threshold retuning against accumulated P0 correction-rate data (§5.2).

**P2 — The rail**
1. Provision the separate clinic Supabase project; clinic store (§3.2–3.3) stood up and BAA-gated (§10 checklist) — started in parallel with P1 per Build Spec §8, since approval/legal timelines run long.
2. Clinic enrollment path + clinic-specific consent/disclosure (§10).
3. Apple Messages for Business adapter as a second `messaging` package implementation, behind the same channel-agnostic interface established in Architecture §3.1 — orchestration core requires no changes.
4. Advanced coach/clinic analytics (adherence trends, flagged-client views) as additive read endpoints over existing data — no new write paths.

---
*Tally — Technical Design Doc 04 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture*
