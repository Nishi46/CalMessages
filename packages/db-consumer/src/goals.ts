import { getPool } from './pool.js';

export interface Goal {
  id: string;
  userId: string;
  type: string; // lose | maintain | gain | protein_only
  dailyCalories: number | null;
  dailyProtein: number | null;
  setAt: Date;
  source: 'self' | 'coach' | 'clinic';
  supersededAt: Date | null;
}

interface GoalRow {
  id: string;
  user_id: string;
  type: string;
  daily_calories: number | null;
  daily_protein: number | null;
  set_at: Date;
  source: Goal['source'];
  superseded_at: Date | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    dailyCalories: row.daily_calories,
    dailyProtein: row.daily_protein,
    setAt: row.set_at,
    source: row.source,
    supersededAt: row.superseded_at,
  };
}

export interface NewGoal {
  type: string;
  dailyCalories: number;
  dailyProtein: number;
}

// Sprint 2 only ever writes source: 'self' — coach/clinic-authored goals
// arrive with the dashboard work in P1/P2 (04 §9, §10).
export async function createGoal(userId: string, goal: NewGoal): Promise<Goal> {
  const { rows } = await getPool().query<GoalRow>(
    `INSERT INTO goal (user_id, type, daily_calories, daily_protein, source)
     VALUES ($1, $2, $3, $4, 'self') RETURNING *`,
    [userId, goal.type, goal.dailyCalories, goal.dailyProtein],
  );
  return rowToGoal(rows[0]);
}
