import type { MealCandidate, MealCandidateItem } from '@tally/shared-types';
import { getPool } from './pool.js';

export type MealSource = 'photo' | 'text' | 'voice';

export interface MealLog {
  id: string;
  userId: string;
  photoUrl: string | null;
  items: MealCandidateItem[];
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  confidence: MealCandidate['confidence'];
  source: MealSource;
  loggedAt: Date;
  localDate: string;
  correctedFromId: string | null;
  softDeletedAt: Date | null;
}

interface MealLogRow {
  id: string;
  user_id: string;
  photo_url: string | null;
  items: MealCandidateItem[];
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  confidence: MealLog['confidence'];
  source: MealSource;
  logged_at: Date;
  local_date: string;
  corrected_from_id: string | null;
  soft_deleted_at: Date | null;
}

function rowToMealLog(row: MealLogRow): MealLog {
  return {
    id: row.id,
    userId: row.user_id,
    photoUrl: row.photo_url,
    items: row.items,
    calories: row.calories,
    protein: row.protein,
    carbs: row.carbs,
    fat: row.fat,
    confidence: row.confidence,
    source: row.source,
    loggedAt: row.logged_at,
    localDate: row.local_date,
    correctedFromId: row.corrected_from_id,
    softDeletedAt: row.soft_deleted_at,
  };
}

// `local_date` is cast to text in every query below — the driver's default
// DATE parsing round-trips through a JS Date and can shift the day by one
// under a non-UTC process timezone, which would corrupt the exact bucketing
// this column exists for (04 §3.1).
const MEAL_LOG_COLUMNS = `
  id, user_id, photo_url, items, calories, protein, carbs, fat,
  confidence, source, logged_at, local_date::text AS local_date,
  corrected_from_id, soft_deleted_at
`;

export async function createMealLog(
  userId: string,
  candidate: MealCandidate,
  source: MealSource,
  localDate: string,
): Promise<MealLog> {
  const { rows } = await getPool().query<MealLogRow>(
    `INSERT INTO meal_log (user_id, items, calories, protein, carbs, fat, confidence, source, local_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${MEAL_LOG_COLUMNS}`,
    [
      userId,
      JSON.stringify(candidate.items),
      candidate.calories,
      candidate.protein,
      candidate.carbs,
      candidate.fat,
      candidate.confidence,
      source,
      localDate,
    ],
  );
  return rowToMealLog(rows[0]);
}

export async function getRecentMealLogsForUser(
  userId: string,
  { sinceDate }: { sinceDate: string },
): Promise<MealLog[]> {
  const { rows } = await getPool().query<MealLogRow>(
    `SELECT ${MEAL_LOG_COLUMNS}
     FROM meal_log
     WHERE user_id = $1 AND local_date >= $2 AND soft_deleted_at IS NULL
     ORDER BY logged_at DESC`,
    [userId, sinceDate],
  );
  return rows.map(rowToMealLog);
}

export interface DailyTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export async function getDailyTotals(userId: string, localDate: string): Promise<DailyTotals> {
  const { rows } = await getPool().query<DailyTotals>(
    // Cast: SUM() over an INT column returns BIGINT, which the driver reads
    // back as a string to avoid precision loss outside JS's safe integer
    // range — irrelevant at meal-log scale, so cast back down to a number.
    `SELECT
       COALESCE(SUM(calories), 0)::int AS calories,
       COALESCE(SUM(protein), 0)::int AS protein,
       COALESCE(SUM(carbs), 0)::int AS carbs,
       COALESCE(SUM(fat), 0)::int AS fat
     FROM meal_log
     WHERE user_id = $1 AND local_date = $2 AND soft_deleted_at IS NULL`,
    [userId, localDate],
  );
  return rows[0];
}

// Corrections always arrive via a text reply ("that was actually 2 eggs not
// 3" — Build Spec §4.3), so source is fixed rather than a parameter, same
// posture as goals.ts hardcoding source: 'self' for its Sprint 2 scope.
// `local_date` is copied from the original log, not today's, per the same
// section's "recalculates the total for that day, not the current one".
// Scoping the source lookup to `user_id = $1` keeps this from ever writing a
// correction against another user's log.
export async function createCorrection(
  originalLogId: string,
  userId: string,
  candidate: MealCandidate,
): Promise<MealLog | null> {
  const { rows } = await getPool().query<MealLogRow>(
    `INSERT INTO meal_log (user_id, items, calories, protein, carbs, fat, confidence, source, local_date, corrected_from_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, 'text', local_date, id
     FROM meal_log
     WHERE id = $8 AND user_id = $1 AND soft_deleted_at IS NULL
     RETURNING ${MEAL_LOG_COLUMNS}`,
    [
      userId,
      JSON.stringify(candidate.items),
      candidate.calories,
      candidate.protein,
      candidate.carbs,
      candidate.fat,
      candidate.confidence,
      originalLogId,
    ],
  );
  return rows[0] ? rowToMealLog(rows[0]) : null;
}

export async function softDeleteMealLog(id: string): Promise<MealLog | null> {
  const { rows } = await getPool().query<MealLogRow>(
    `UPDATE meal_log
     SET soft_deleted_at = now()
     WHERE id = $1 AND soft_deleted_at IS NULL
     RETURNING ${MEAL_LOG_COLUMNS}`,
    [id],
  );
  return rows[0] ? rowToMealLog(rows[0]) : null;
}
