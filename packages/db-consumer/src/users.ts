import { getPool, type DbClient } from './pool.js';

export interface User {
  id: string;
  phoneE164: string;
  timezone: string;
  planStatus: 'free' | 'active' | 'past_due' | 'canceled';
  createdAt: Date;
  optOutAt: Date | null;
  pausedAt: Date | null;
  deletedRequestedAt: Date | null;
  referralCode: string | null;
  // Full state enum lands with the conversation package in Sprint 2 (04 §6.1).
  conversationState: string;
  conversationContext: unknown | null;
}

interface UserRow {
  id: string;
  phone_e164: string;
  timezone: string;
  plan_status: User['planStatus'];
  created_at: Date;
  opt_out_at: Date | null;
  paused_at: Date | null;
  deleted_requested_at: Date | null;
  referral_code: string | null;
  conversation_state: string;
  conversation_context: unknown | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    phoneE164: row.phone_e164,
    timezone: row.timezone,
    planStatus: row.plan_status,
    createdAt: row.created_at,
    optOutAt: row.opt_out_at,
    pausedAt: row.paused_at,
    deletedRequestedAt: row.deleted_requested_at,
    referralCode: row.referral_code,
    conversationState: row.conversation_state,
    conversationContext: row.conversation_context,
  };
}

export async function createUser(phoneE164: string): Promise<User> {
  const { rows } = await getPool().query<UserRow>(
    `INSERT INTO "user" (phone_e164) VALUES ($1) RETURNING *`,
    [phoneE164],
  );
  return rowToUser(rows[0]);
}

export async function getUserByPhone(phoneE164: string): Promise<User | null> {
  const { rows } = await getPool().query<UserRow>(
    `SELECT * FROM "user" WHERE phone_e164 = $1`,
    [phoneE164],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function getUserById(id: string): Promise<User | null> {
  const { rows } = await getPool().query<UserRow>(`SELECT * FROM "user" WHERE id = $1`, [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

// 09 breakdown §C step 7: the nudge evaluation loop's active-user set (04
// §7.1) — reuses idx_user_state, the partial index Sprint 1 added on
// exactly this WHERE clause shape.
export async function getActiveUsersForScheduling(): Promise<User[]> {
  const { rows } = await getPool().query<UserRow>(
    `SELECT * FROM "user" WHERE opt_out_at IS NULL AND paused_at IS NULL AND conversation_state = 'idle'`,
  );
  return rows.map(rowToUser);
}

// 12 §C step 10: STOP/START set/clear opt_out_at directly, never through the
// conversation state machine — unlike pause/resume/delete, Twilio's own
// Advanced Opt-Out handling matches the keyword and replies before this app
// even sees the request (04 §4.3: carrier-level, no application code
// decides whether to honor it), so there's no conversation_state/context to
// write alongside it, and this doesn't belong behind updateUserState.
export async function setUserOptOut(userId: string, optOutAt: Date | null): Promise<User> {
  const { rows } = await getPool().query<UserRow>(
    `UPDATE "user" SET opt_out_at = $2 WHERE id = $1 RETURNING *`,
    [userId, optOutAt],
  );
  return rowToUser(rows[0]);
}

// The per-state timestamp columns (12 §A step 4, 12 §B step 7) that ride
// along with a state transition's UPDATE — undefined (the default) leaves a
// column untouched, so every pre-existing call site is unaffected. Only the
// router's pause/resume/delete transitions pass one of these, so the write
// happens in the same UPDATE as conversation_state/conversation_context
// rather than a second round-trip.
export interface UpdateUserStateColumns {
  pausedAt?: Date | null;
  deletedRequestedAt?: Date | null;
}

// `client` defaults to the pool so every pre-Sprint-6 call site is
// unaffected — 11 breakdown §D step 14 passes an open transaction client
// here instead, so this write and the processed_stripe_event marker commit
// atomically with the rest of a webhook's DB-side effects.
export async function updateUserState(
  userId: string,
  conversationState: string,
  conversationContext: unknown = null,
  client: DbClient = getPool(),
  columns: UpdateUserStateColumns = {},
): Promise<User> {
  const setClauses = ['conversation_state = $2', 'conversation_context = $3'];
  const values: unknown[] = [
    userId,
    conversationState,
    conversationContext === null ? null : JSON.stringify(conversationContext),
  ];

  if (columns.pausedAt !== undefined) {
    values.push(columns.pausedAt);
    setClauses.push(`paused_at = $${values.length}`);
  }
  if (columns.deletedRequestedAt !== undefined) {
    values.push(columns.deletedRequestedAt);
    setClauses.push(`deleted_requested_at = $${values.length}`);
  }

  const { rows } = await client.query<UserRow>(
    `UPDATE "user" SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );
  return rowToUser(rows[0]);
}

// 12 §B step 7: candidate rows for the 30-day purge sweep. scrubUserPii
// below clears deleted_requested_at once a user is actually purged, which is
// what keeps a re-run of the sweep from re-selecting an already-purged
// user — no separate "purged" flag needed.
export async function getUsersPendingPurge(cutoff: Date): Promise<User[]> {
  const { rows } = await getPool().query<UserRow>(
    `SELECT * FROM "user"
     WHERE conversation_state = 'deleted' AND deleted_requested_at IS NOT NULL AND deleted_requested_at < $1`,
    [cutoff],
  );
  return rows.map(rowToUser);
}

// 12 §B step 8: scrubs the user row's PII in place rather than deleting the
// row outright — goal/subscription/message_event rows all FK to user.id, and
// a hard delete of the row would either cascade away billing/audit history
// or need every one of those FKs relaxed first, neither of which the sprint
// doc asks for. phone_e164 is NOT NULL + UNIQUE, so it's replaced with a
// non-identifying placeholder derived from the user's own id rather than
// nulled. Clearing deleted_requested_at marks this user done for
// getUsersPendingPurge above.
export async function scrubUserPii(userId: string): Promise<User> {
  const { rows } = await getPool().query<UserRow>(
    `UPDATE "user"
     SET phone_e164 = 'deleted-' || id::text,
         referral_code = NULL,
         conversation_context = NULL,
         deleted_requested_at = NULL
     WHERE id = $1
     RETURNING *`,
    [userId],
  );
  return rowToUser(rows[0]);
}
