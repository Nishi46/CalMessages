# @tally/api

Webhook handlers and dashboard API, stateless app tier (04 §2). Currently: health check + the Twilio inbound webhook (04 §4.1).

## Local dev

Needs `infra/docker-compose.yml` running (Postgres, MinIO) and `db-consumer` migrated — see the root and [db-consumer](../../packages/db-consumer/README.md) READMEs. Then, with the repo-root `.env` sourced:

```
npm run build --workspace=@tally/api
npm run start --workspace=@tally/api
```

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `PUBLIC_BASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `VISION_PROVIDER_API_KEY` are required — the process fails fast on startup if any are missing. See `.claude/skills/run-api/SKILL.md` for a verified step-by-step.

## Why `PUBLIC_BASE_URL` is a config value, not something read off the request

Twilio's signature is computed over the exact URL it POSTed to. Behind any reverse proxy or load balancer, `request.protocol`/`request.hostname` can report the wrong scheme or host (e.g. `http` when the public-facing request was `https`), which would silently fail every signature check in production. `PUBLIC_BASE_URL` is set explicitly instead, so the reconstructed URL always matches what Twilio actually signed.

## Design: injected dependencies

`buildApp(deps)` (`src/server.ts`) takes the user-store, media-fetch, object-store, and router-handoff functions as arguments rather than importing them directly, so `src/routes/twilio-inbound.test.ts` can exercise the real route logic — signature verification, media handling, TwiML response — without a live Twilio account or bucket. `src/index.ts` is the only place that wires the real implementations together.

## Test coverage

- Signature verification and the media/router wiring are tested with fully faked dependencies (`twilio-inbound.test.ts`, first describe block) — no external services needed.
- User creation is tested against a **real** Postgres (same CI service container as `db-consumer`'s tests) in the second describe block, per breakdown step 20 — `resolveOrCreateUser` is real, only `fetchMedia`/`objectStore` stay faked.
- Media persistence to the bucket itself is verified at the unit level (the handler calls `fetchMedia` then `objectStore.putObject` with the right arguments, and threads the returned key to the router) rather than against a real MinIO in CI — GitHub Actions service containers can't pass MinIO the `server /data` command it needs to actually start. Exercising the real S3-compatible path is a local manual check: run `infra/docker-compose.yml`, point `S3_ENDPOINT` at it, and send an MMS through.
