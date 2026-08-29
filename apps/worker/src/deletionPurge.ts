import {
  getPhotoUrlsForUser,
  getUsersPendingPurge,
  hardDeleteMealLogsForUser,
  scrubUserPii,
} from '@tally/db-consumer';
import type { ObjectStore } from '@tally/object-store';

// 12 §B step 7: 30 days per Build Spec §4.7 — the account-delete
// confirmation's own promised window.
export const DEFAULT_PURGE_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

// 12 §B step 7: a periodic sweep, same shape as runReconciliationTick — the
// breakdown's own stated reason to prefer this over a per-user delayed job
// is that it's simpler to reason about and doesn't depend on queue
// infrastructure surviving unchanged for 30 days. `now` is threaded through
// rather than read via Date.now() so tests can drive it with a fixed clock
// instead of a real 30-day wait, same posture as reconciliation/evaluation.
export async function runDeletionPurgeTick(
  objectStore: ObjectStore,
  now: Date,
  gracePeriodMs: number = DEFAULT_PURGE_GRACE_PERIOD_MS,
): Promise<void> {
  const cutoff = new Date(now.getTime() - gracePeriodMs);
  const pending = await getUsersPendingPurge(cutoff);

  const results = await Promise.allSettled(
    pending.map(async (user) => {
      // Object storage first, meal_log rows second (12 §B step 8) — deleting
      // a row before its photo is confirmed gone would destroy the only
      // pointer to that S3 key, leaving it orphaned with no way to retry.
      // If a photo delete throws, this user's meal_log rows and PII are left
      // untouched, so the next tick retries the exact same photo list.
      const photoUrls = await getPhotoUrlsForUser(user.id);
      await Promise.all(photoUrls.map((key) => objectStore.deleteObject(key)));
      await hardDeleteMealLogsForUser(user.id);
      await scrubUserPii(user.id);
    }),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      // One user's purge failing (a transient S3 error, say) shouldn't abort
      // the rest of the sweep — same posture as reconciliation's per-account
      // resilience.
      console.error('[worker] deletion purge failed for a user', result.reason);
    }
  }
}
