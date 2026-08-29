import { randomInt } from 'node:crypto';

// Test-only helper for a phone number guaranteed unique across parallel
// vitest worker processes and files. `+1${Date.now()}<manual suffix>` isn't
// enough on its own — vitest runs test files concurrently, so two files can
// tick the same millisecond with the same hand-picked suffix and collide on
// the DB's UNIQUE phone_e164 constraint (seen in CI: router.test.ts and
// subscriptions.test.ts both used `+1${Date.now()}10`).
export function uniqueTestPhone(): string {
  return `+1${Date.now()}${randomInt(0, 1_000_000_000)}`;
}
