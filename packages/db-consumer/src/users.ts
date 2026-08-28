import { getPool, type DbClient } from './pool.js';

export interface User {
  id: string;
  phoneE164: string;
  timezone: string;
  planStatus: 'free' | 'active' | 'past_due' | 'canceled';
  createdAt: Date;
  optOutAt: Date | null;
  pausedAt: Date | null;
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

// `client` defaults to the pool so every pre-Sprint-6 call site is
// unaffected — 11 breakdown §D step 14 passes an open transaction client
// here instead, so this write and the processed_stripe_event marker commit
// atomically with the rest of a webhook's DB-side effects.
export async function updateUserState(
  userId: string,
  conversationState: string,
  conversationContext: unknown = null,
  client: DbClient = getPool(),
): Promise<User> {
  const { rows } = await client.query<UserRow>(
    `UPDATE "user" SET conversation_state = $2, conversation_context = $3 WHERE id = $1 RETURNING *`,
    [userId, conversationState, conversationContext === null ? null : JSON.stringify(conversationContext)],
  );
  return rowToUser(rows[0]);
}
