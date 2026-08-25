# infra

Local dev environment plus a checklist for the Sprint 0 items that need a human, not a script — account creation, billing, and legal/business filings that no CLI tool has the authority (or the information) to do on its own. Step numbers reference [Docs/tally-sprint-0-1-breakdown.md](../Docs/tally-sprint-0-1-breakdown.md).

## Local dev — already set up

```
cp .env.example .env      # fill in values as accounts get created below
docker compose -f infra/docker-compose.yml up -d
```

Brings up, matching Sprint 0 steps 6–9: a consumer Postgres (`localhost:5432`), a **separate** clinic Postgres instance (`localhost:5433`), Redis (`localhost:6379`), and a MinIO S3-compatible bucket (console at `localhost:9001`, credentials in `.env.example`).

## Still needs you (not automatable from here)

- [ ] **Step 10 — staging environment.** Pick a host (Fly.io, Render, AWS, etc. — 04 §1 treats this as swappable) and provision consumer + clinic Postgres, Redis, and a bucket there. Same shape as local dev, hosted.
- [ ] **Step 11 — production environment.** Same as staging, on the production tier. Can lag a sprint if launch is still weeks out, but the account/billing setup is worth starting now to avoid a scramble later.
- [ ] **Step 12 — secrets manager.** Pick one (Doppler, AWS Secrets Manager, Fly/Render secrets, 1Password Connect) and set it up per environment. `.env.example` documents what needs to go in it.
- [ ] **Step 16 — Twilio account.** Create/access it, provision a trial number for local development.
- [ ] **Step 17 — A2P 10DLC brand registration.** Filed through the Twilio console with real business info.
- [ ] **Step 18 — A2P 10DLC campaign registration.** Needs an accurate use-case description and the opt-in/consent language from Build Spec §6.1 — worth getting right the first time, since a badly classified campaign silently kills deliverability.
- [ ] **Step 19 — Stripe and vision-provider accounts,** whenever those are picked (Sprint 6 and Sprint 3 respectively need the keys, but creating the accounts can happen anytime before then).

None of these block Sprint 1 — the schema, webhook handlers, and tests all run against local dev. They block **deploying to staging/production** and **sending a real SMS**, so the A2P filing (step 18) in particular is worth starting now given its 1–3 week approval window.
