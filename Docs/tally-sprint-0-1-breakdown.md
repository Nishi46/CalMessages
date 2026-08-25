# Tally — Sprint 0 & 1 Breakdown
### Technical Design Doc 06 — Task-Level Breakdown

> Smallest-reasonable-step breakdown of Sprint 0 (Setup) and Sprint 1 (Data + transport foundation) from 05 — Sprint Plan. Each step traces back to the exact table, index, or webhook-contract line in 04 — Technical Implementation.

**Prepared:** 25 Aug 2026 &nbsp;|&nbsp; **Companion docs:** 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan &nbsp;|&nbsp; **Status:** Pre-build

---

## Sprint 0 — Setup

**Repo & tooling**
1. Pick a workspace tool (pnpm/npm/yarn workspaces or Turborepo) and init the monorepo root.
2. Create the directory skeleton per 04 §2: `apps/api`, `apps/worker`, `apps/dashboard`, `packages/db-consumer`, `packages/db-clinic`, `packages/vision`, `packages/conversation`, `packages/messaging`, `packages/billing`, `packages/shared-types`, `infra/`.
3. Add a root `tsconfig.json`, ESLint, and Prettier config shared across packages.
4. Init each package's `package.json` with a name and a placeholder `index.ts` so the workspace graph resolves.
5. Add a CI workflow (lint → typecheck → test → build) that passes green on the empty scaffold — this is the harness later sprints plug into, not something to bolt on at the end.

**Environments & data stores**
6. Provision the **consumer** Postgres instance for `dev` (local Docker or managed dev tier).
7. Provision a **separate** clinic Postgres instance for `dev` — stood up empty now, on its own instance, so the physical-separation habit (04 §10) exists from day one even before `db-clinic` has a schema.
8. Provision Redis for `dev`.
9. Provision an S3-compatible bucket for `dev` (or MinIO locally).
10. Repeat steps 6–9 for `staging`.
11. Repeat steps 6–9 for `production` (can lag a sprint if launch is still weeks out, but the account/billing setup is worth doing now to avoid a scramble later).

**Secrets**
12. Pick a secrets manager (Doppler, AWS Secrets Manager, Fly/Render secrets, 1Password Connect, etc.) and set it up per environment.
13. Load DB connection strings (×2 per environment), Redis URL, and S3 credentials as secrets — nothing committed to the repo.
14. Reserve (empty) secret slots for Twilio auth token, Stripe secret/webhook keys, and the vision provider API key — filled in once those accounts exist (steps 16–18 below, and Sprint 3/6).
15. Generate the clinic field-level encryption key and store it in a **separate** secrets scope with a narrower access list (04 §13) — reserved now even though `db-clinic` won't be built until P2, so the access-list boundary is never an afterthought.

**Twilio account & A2P registration (external lead time — start immediately)**
16. Create/access the Twilio account and provision a trial number for local development.
17. File the A2P 10DLC **brand** registration.
18. File the A2P 10DLC **campaign** registration, with an accurate use-case description and the correct opt-in/consent language (Build Spec §6.1) — a badly classified campaign silently kills deliverability, so this is worth getting right the first time rather than fast.
19. Note the expected 1–3 week approval window and check status at the start of Sprint 2; this is the one item whose slip doesn't come from engineering velocity.

---

## Sprint 1 — Data + transport foundation

**A. Consumer schema + migrations (04 §3.1)**
1. Choose a migration tool for `db-consumer` (e.g. node-pg-migrate, Drizzle, Kysely + custom runner, Prisma Migrate).
2. Migration: `user` table + `idx_user_phone` + `idx_user_state`.
3. Migration: `goal` table + `idx_goal_active`.
4. Migration: `meal_log` table + `idx_meal_user_date`.
5. Migration: `message_event` table + `idx_msgevent_user_type_sent`.
6. Migration: `subscription` table.
7. Write minimal typed query functions needed this sprint only: `createUser`, `getUserByPhone`, `updateUserState`.
8. Run migrations against `dev`; smoke-test with an insert + read round-trip.

**B. Twilio inbound webhook (04 §4.1)**
9. Stand up the Fastify app in `apps/api` with a health-check route.
10. Add `POST /webhooks/twilio/inbound` returning a stubbed 200 first, before any real logic.
11. Configure Fastify's body parsing so the **raw, untouched** request body is available for signature verification (a re-serialized body will fail Twilio's signature check).
12. Implement `X-Twilio-Signature` verification (Twilio's helper library, against the full URL + params + auth token); reject with 403 on mismatch, before touching the DB.
13. Unit test: valid signature passes; invalid signature 403s **and** no downstream DB call happens.
14. Parse `From` (E.164), `Body`, `NumMedia`, `MediaUrl0..N` from the form-encoded payload.
15. Implement resolve-or-create `User` by phone number — creation gated on "no existing row for this phone," matching the "truly first contact" rule in 04 §4.1 step 3.
16. If `NumMedia > 0`: fetch `MediaUrl0` immediately (Twilio media URLs are time-limited) before any other processing on the request.
17. Upload the fetched media to the `dev` S3 bucket; store the returned key (not the blob) on the request context for the next step.
18. Add a no-op placeholder for the conversation-router handoff (`{ user_id, text?, photo_key?, current_state }`) — real routing logic lands in Sprint 2, this sprint just wires the seam.
19. Return an empty `<Response/>` TwiML body.
20. Integration test: simulated text-only inbound webhook → asserts user created, correct row state.
21. Integration test: simulated media inbound webhook → asserts photo persisted to bucket and key captured.

**C. Twilio outbound send (04 §4.2)**
22. Implement `sendMessage(userId, body, type)` in `packages/messaging`.
23. Guard: check `opt_out_at IS NULL` before attempting a send (defense in depth alongside Twilio's carrier-level suppression).
24. Write a `MessageEvent` row with `delivery_status = 'queued'` **before** calling the Twilio API.
25. Call Twilio's REST API to send; capture `twilio_sid` back onto the `MessageEvent` row.
26. Add `POST /webhooks/twilio/status`, with the same signature-verification treatment as the inbound route.
27. Update `MessageEvent.delivery_status` from the callback's `MessageStatus`, matched by `twilio_sid`.
28. Test: `sendMessage()` → queued row created → simulated status callback → `delivery_status` updates correctly.

**D. Wiring & sprint-close verification**
29. Manual test: text the dev Twilio number, confirm the inbound webhook fires, a user row is created, and an empty TwiML response returns without error.
30. Manual test: trigger `sendMessage()` directly, confirm an SMS actually arrives on a real test phone.
31. Deploy `apps/api` to `staging`, point the Twilio number's webhook URL at the staging endpoint, and repeat both manual tests there before calling the sprint done.

---
*Tally — Technical Design Doc 06 · Companion documents: 01 — Vision Brief · 02 — Build Spec · 03 — Architecture · 04 — Technical Implementation · 05 — Sprint Plan*
