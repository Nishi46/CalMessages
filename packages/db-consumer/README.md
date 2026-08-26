# @tally/db-consumer

Consumer-store schema, migrations, and typed query layer (04 §3.1, §2). A separate package from `db-clinic` by construction — see 04 §2 for why.

## Local dev

Requires `infra/docker-compose.yml` running (see [infra/README.md](../../infra/README.md)) and `DATABASE_URL_CONSUMER` set — either export it from the repo-root `.env`:

```
set -a && source ../../.env && set +a
```

or pass it inline per command.

```
npm run migrate:up --workspace=@tally/db-consumer     # apply all migrations
npm run migrate:down --workspace=@tally/db-consumer    # roll back the most recent one
npm run migrate:create --workspace=@tally/db-consumer -- some-name   # scaffold a new .sql migration
```

## Query layer

Hand-written, typed functions over `pg` — no ORM (04 §2's "typed query layer" is this, not a generic abstraction). `users.ts` currently covers what Sprint 1 needs: `createUser`, `getUserByPhone`, `updateUserState`. Functions for `goal`, `meal_log`, `message_event`, and `subscription` land in the sprints that actually read/write them.

`src/users.test.ts` is an integration smoke test — it runs against a real Postgres (local dev, or the `postgres` service container in CI), not a mock.
