---
name: run-api
description: Build and launch @tally/api (the Fastify webhook/dashboard server) locally, and smoke-test it with curl. Use whenever asked to run, start, launch, or boot-check the API server in this repo.
---

# Running @tally/api

Verified working end to end on 2026-08-27 (Node v20.20.2, macOS). This is
the recipe that actually worked — follow it verbatim rather than
re-deriving it.

## 1. Prerequisites

Docker infra must be up (Postgres for `db-consumer`, Redis, MinIO):

```bash
docker compose -f infra/docker-compose.yml up -d
docker ps --format "{{.Names}}\t{{.Status}}"
# expect: infra-postgres-consumer-1, infra-redis-1, infra-minio-1 all "Up"
```

`db-consumer`'s migrations must already be applied (see
`packages/db-consumer/README.md`) — if `meal_log`/`user`/etc. tables don't
exist, run `npm run migrate:up --workspace=@tally/db-consumer` first
(needs `DATABASE_URL` set to the value of `DATABASE_URL_CONSUMER`, since
`node-pg-migrate` reads `DATABASE_URL` by default, not the app's own var
name).

## 2. Env vars

Source the repo-root `.env` (copy from `.env.example` if it doesn't exist
yet). `apps/api/src/index.ts` calls `requireEnv()` on all of these and
**crashes immediately at startup** if any is missing or empty — this is
the #1 thing to check when the process exits right away with no other
output:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `PUBLIC_BASE_URL` (used for Twilio signature verification, not read off
  the request — see `apps/api/README.md`)
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
  (MinIO in local dev)
- `VISION_PROVIDER_API_KEY` — added in Sprint 4 (09 §D) for the
  meal-logging vision/text pipeline. **As of 2026-08-27 this is blank in
  `.env`** and is the one env var most likely to be the reason the server
  won't boot. A real key isn't needed just to confirm the server *starts*
  — any non-empty placeholder string satisfies `requireEnv` and lets you
  boot-smoke-test everything else. It only needs to be a real key for an
  actual photo/text meal-logging request to work.

## 3. Build

```bash
npm run build --workspace=@tally/api
```

This also builds the workspace packages it depends on
(`@tally/db-consumer`, `@tally/conversation`, `@tally/messaging`,
`@tally/time`, `@tally/vision`) via TS project references — no separate
build step needed for those.

## 4. Launch

```bash
cd apps/api
set -a && source ../../.env && set +a
node dist/index.js
```

Or from the repo root without `cd`:

```bash
( set -a; source .env; set +a; node apps/api/dist/index.js )
```

A clean boot logs three `"Server listening at http://..."` lines (one per
network interface) via pino, and does not exit. Default port is 3000 —
override with `PORT=<n>` before the env-var export if it's already taken.

## 5. Smoke-test

```bash
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:3000/health
# expect: {"status":"ok"}
# HTTP 200
```

This alone proves Fastify is up and serving, independent of Twilio/vision
config correctness.

## 6. Stopping it

It runs in the foreground by default — `Ctrl+C`, or if launched
backgrounded (`... &`), `kill <pid>` and confirm with `kill -0 <pid>`
(exits non-zero once it's actually gone).

## Testing the real Twilio webhook path (not just boot)

Boot-smoke-testing (steps 1-5) is independent of whether inbound SMS/MMS
actually work end to end. To test that:

1. `ngrok http <port>` (an authtoken is already configured on this
   machine per prior session notes) and point `PUBLIC_BASE_URL` at the
   ngrok URL.
2. In the Twilio Console, set the number's "A message comes in" webhook to
   `<ngrok-url>/webhooks/twilio/inbound`.
3. Text the number from a real phone.

**Known blocker as of 2026-08-27** (see project memory
`project_sprint2_close_blockers.md`): the Twilio account is still
Trial-tier with A2P 10DLC unfiled — it silently rewrites every outbound
SMS body with a canned template, so a live text-in test can only confirm
"the webhook processed without erroring," never "the right reply copy
arrived." Re-check live before relying on this: `GET
/2010-04-01/Accounts/{sid}.json` (look at `type`) and `GET
/v1/a2p/BrandRegistrations` against the Twilio API.
