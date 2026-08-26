import { createUser, getUserByPhone, type User } from '@tally/db-consumer';

const UNIQUE_VIOLATION = '23505';

// "Creation only on truly first contact" (04 §4.1 step 3). Two near-simultaneous
// first messages from the same new number can both miss the row check below; the
// loser of the insert race just re-reads what the winner created instead of erroring.
export async function resolveOrCreateUser(phoneE164: string): Promise<User> {
  const existing = await getUserByPhone(phoneE164);
  if (existing) {
    return existing;
  }

  try {
    return await createUser(phoneE164);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raceWinner = await getUserByPhone(phoneE164);
      if (raceWinner) {
        return raceWinner;
      }
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
