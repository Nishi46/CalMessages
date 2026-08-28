import type { Pool } from 'pg';

// Arbitrary fixed key identifying "the nudge scheduler leader" advisory
// lock. 09 breakdown §A step 3: leader election reuses the existing
// consumer Postgres pool via pg_try_advisory_lock rather than adding a
// second leader-election mechanism (e.g. Redlock) for one boolean concern.
const SCHEDULER_LOCK_KEY = 727_100_501;

export interface SchedulerLeadership {
  isLeader: boolean;
  release: () => Promise<void>;
}

// Postgres advisory locks are scoped to the session (connection) that took
// them, so leadership must be held on a dedicated client checked out via
// pool.connect() and kept open — never pool.query(), which returns its
// connection to the pool (and the lock with it) right after the statement.
// A worker instance that doesn't win the lock still runs its queue consumer
// (Architecture §6) — only the evaluation loop itself is a singleton.
export async function tryAcquireSchedulerLeadership(pool: Pool): Promise<SchedulerLeadership> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      SCHEDULER_LOCK_KEY,
    ]);
    if (!rows[0]?.locked) {
      client.release();
      return { isLeader: false, release: async () => {} };
    }
  } catch (error) {
    client.release();
    throw error;
  }

  return {
    isLeader: true,
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
}
