import { getPool } from './pool.js';

// 13 breakdown §A step 1: one function per row of 04 §12's metric table. Each
// returns the raw counts alongside the derived rate/average — the "smallest
// viable surface" (§A step 3, still an open scope decision) needs both the
// rate for display and the counts for context ("12% of how many?"), and
// recomputing counts from a bare rate later isn't possible.

export interface TimeToFirstLogResult {
  avgSeconds: number | null;
  sampleSize: number;
}

// 04 §12: `min(meal_log.logged_at) - user.created_at`, averaged across every
// user who has logged at least once. Users with no log yet are excluded
// rather than counted as an infinite/undefined gap — the metric is "how long
// did it take those who got there", not an engagement-rate metric (that's
// D1/D7/D14/D30 retention below).
export async function getTimeToFirstLog(): Promise<TimeToFirstLogResult> {
  const { rows } = await getPool().query<{ avg_seconds: number | null; sample_size: number }>(
    `SELECT
       AVG(EXTRACT(EPOCH FROM (fl.logged_at - u.created_at)))::float8 AS avg_seconds,
       COUNT(*)::int AS sample_size
     FROM "user" u
     JOIN LATERAL (
       SELECT MIN(ml.logged_at) AS logged_at
       FROM meal_log ml
       WHERE ml.user_id = u.id AND ml.soft_deleted_at IS NULL
     ) fl ON fl.logged_at IS NOT NULL`,
  );
  return { avgSeconds: rows[0].avg_seconds, sampleSize: rows[0].sample_size };
}

export type RetentionWindow = 1 | 7 | 14 | 30;

export interface RetentionCohortResult {
  cohortSize: number;
  retainedCount: number;
  retentionRate: number | null;
}

// 04 §12: "users with created_at in window X who have any meal_log.logged_at
// in the corresponding later window." Cohort = users created on cohortDate
// (UTC calendar day); retained = cohort members with a log on exactly
// cohortDate + days (the standard D-N definition — did they come back on
// that day, not "at any point up to and including it"). `days` is typed to
// the four windows the Sprint Plan actually asks for, so a caller can't pass
// an arbitrary N that no dashboard/report is expecting.
export async function getRetentionCohort(
  days: RetentionWindow,
  cohortDate: string,
): Promise<RetentionCohortResult> {
  const { rows } = await getPool().query<{ cohort_size: number; retained_count: number }>(
    `WITH cohort AS (
       SELECT id FROM "user" WHERE created_at::date = $1::date
     )
     SELECT
       (SELECT COUNT(*) FROM cohort)::int AS cohort_size,
       (SELECT COUNT(DISTINCT ml.user_id)
        FROM meal_log ml
        JOIN cohort c ON c.id = ml.user_id
        WHERE ml.local_date = ($1::date + $2 * INTERVAL '1 day')::date
          AND ml.soft_deleted_at IS NULL
       )::int AS retained_count`,
    [cohortDate, days],
  );
  const { cohort_size: cohortSize, retained_count: retainedCount } = rows[0];
  return {
    cohortSize,
    retainedCount,
    retentionRate: cohortSize > 0 ? retainedCount / cohortSize : null,
  };
}

export interface MealsPerActiveUserResult {
  totalMeals: number;
  activeUsers: number;
  mealsPerActiveUser: number | null;
}

// 04 §12: `count(meal_log) / count(distinct user_id)` over the trailing 7
// days, excluding soft-deleted. `asOf` is a caller-supplied instant (same
// posture as mealLogs.daysSinceLastLog) so a scheduled report can pin it to
// the run time instead of racing SQL now() across the two counts below.
export async function getMealsLoggedPerActiveUser(
  asOf: Date = new Date(),
): Promise<MealsPerActiveUserResult> {
  const { rows } = await getPool().query<{ total_meals: number; active_users: number }>(
    `SELECT
       COUNT(*)::int AS total_meals,
       COUNT(DISTINCT user_id)::int AS active_users
     FROM meal_log
     WHERE logged_at >= $1::timestamptz - INTERVAL '7 days'
       AND logged_at < $1::timestamptz
       AND soft_deleted_at IS NULL`,
    [asOf.toISOString()],
  );
  const { total_meals: totalMeals, active_users: activeUsers } = rows[0];
  return {
    totalMeals,
    activeUsers,
    mealsPerActiveUser: activeUsers > 0 ? totalMeals / activeUsers : null,
  };
}

export interface NudgeResponseRateResult {
  nudgesSent: number;
  respondedWithinHour: number;
  responseRate: number | null;
}

// 04 §12: `message_event` where `type='nudge'` and `responded_at IS NOT NULL`
// within 1hr, over all nudges sent. All-time, per the source formula (no
// trailing-window framing like the meals metric above) — direction is
// pinned to outbound since only outbound nudges have a response to measure.
export async function getNudgeResponseRate(): Promise<NudgeResponseRateResult> {
  const { rows } = await getPool().query<{ nudges_sent: number; responded_within_hour: number }>(
    `SELECT
       COUNT(*)::int AS nudges_sent,
       COUNT(*) FILTER (
         WHERE responded_at IS NOT NULL AND responded_at <= sent_at + INTERVAL '1 hour'
       )::int AS responded_within_hour
     FROM message_event
     WHERE type = 'nudge' AND direction = 'outbound'`,
  );
  const { nudges_sent: nudgesSent, responded_within_hour: respondedWithinHour } = rows[0];
  return {
    nudgesSent,
    respondedWithinHour,
    responseRate: nudgesSent > 0 ? respondedWithinHour / nudgesSent : null,
  };
}

export interface CorrectionRateResult {
  totalLogs: number;
  correctionsWithin24h: number;
  correctionRate: number | null;
}

// 04 §12: `count(meal_log where corrected_from_id IS NOT NULL and logged_at -
// corrected_from.logged_at < 24h) / count(meal_log)`. Denominator is every
// meal_log row (corrections included), matching the source formula literally
// rather than counting only "original" logs.
export async function getCorrectionRate(): Promise<CorrectionRateResult> {
  const { rows } = await getPool().query<{
    total_logs: number;
    corrections_within_24h: number;
  }>(
    `SELECT
       COUNT(*)::int AS total_logs,
       COUNT(*) FILTER (
         WHERE ml.corrected_from_id IS NOT NULL
           AND ml.logged_at - orig.logged_at < INTERVAL '24 hours'
       )::int AS corrections_within_24h
     FROM meal_log ml
     LEFT JOIN meal_log orig ON orig.id = ml.corrected_from_id
     WHERE ml.soft_deleted_at IS NULL`,
  );
  const { total_logs: totalLogs, corrections_within_24h: correctionsWithin24h } = rows[0];
  return {
    totalLogs,
    correctionsWithin24h,
    correctionRate: totalLogs > 0 ? correctionsWithin24h / totalLogs : null,
  };
}

export interface FreeToPaidConversionResult {
  usersHitLimit: number;
  converted: number;
  conversionRate: number | null;
}

// 04 §12: "Users hitting free_analyses_used = free_analyses_limit, joined
// against subscription.status='active' within 7 days." Two gaps versus the
// literal formula:
// 1. The "within 7 days" half can't be computed — `subscription` has no
//    hit-the-limit-at timestamp, only the current used/limit counters, so
//    there's no instant to measure 7 days from. This reads the *current*
//    snapshot instead (of everyone at-or-over their limit right now, how
//    many are currently active) rather than fabricating a window.
// 2. `status = 'active'` alone isn't "converted to paid" — the column
//    defaults to 'active' for a brand-new free-tier row too (04 §3.1), and
//    nothing in this codebase ever writes `plan` to a paid value after
//    checkout (only status/stripe_customer_id/stripe_subscription_id get
//    set, in upsertSubscriptionFromCheckout). Using status alone would
//    count every free user who happens to hit their limit as "converted."
//    stripe_subscription_id IS NOT NULL is the actual signal a real
//    checkout completed, so it's added here as well.
// Both are flagged per 13 breakdown §B step 5's pattern rather than silently
// picked: closing gap 1 needs a `free_limit_hit_at` column or event log;
// closing gap 2 for real means fixing `plan` to actually get written.
export async function getFreeToPaidConversionRate(): Promise<FreeToPaidConversionResult> {
  const { rows } = await getPool().query<{ users_hit_limit: number; converted: number }>(
    `SELECT
       COUNT(*)::int AS users_hit_limit,
       COUNT(*) FILTER (
         WHERE status = 'active' AND stripe_subscription_id IS NOT NULL
       )::int AS converted
     FROM subscription
     WHERE free_analyses_used >= free_analyses_limit`,
  );
  const { users_hit_limit: usersHitLimit, converted } = rows[0];
  return {
    usersHitLimit,
    converted,
    conversionRate: usersHitLimit > 0 ? converted / usersHitLimit : null,
  };
}

export interface CoachSeatAttachRateResult {
  activeCoachSeats: number;
  attachedClientLinks: number;
  attachRate: number | null;
}

// 04 §12: `count(client_link where unlinked_at IS NULL) / count(coach where
// seat_status='active')`. 13 breakdown §A step 2: legitimately returns
// activeCoachSeats: 0, attachRate: null at P0 — no coach/client_link rows
// exist until the Sprint 9/10 coach dashboard ships (P1). A zero here isn't
// a bug to chase.
export async function getCoachSeatAttachRate(): Promise<CoachSeatAttachRateResult> {
  const { rows } = await getPool().query<{
    active_coach_seats: number;
    attached_client_links: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM coach WHERE seat_status = 'active')::int AS active_coach_seats,
       (SELECT COUNT(*) FROM client_link WHERE unlinked_at IS NULL)::int AS attached_client_links`,
  );
  const { active_coach_seats: activeCoachSeats, attached_client_links: attachedClientLinks } =
    rows[0];
  return {
    activeCoachSeats,
    attachedClientLinks,
    attachRate: activeCoachSeats > 0 ? attachedClientLinks / activeCoachSeats : null,
  };
}

export interface DeliverabilityResult {
  totalOutbound: number;
  byStatus: Record<string, number>;
  failureRate: number | null;
}

const FAILURE_STATUSES = ['failed', 'undelivered'];

function rowsToDeliverabilityResult(rows: Array<{ status: string | null; count: number }>): DeliverabilityResult {
  const byStatus: Record<string, number> = {};
  let totalOutbound = 0;
  let failures = 0;
  for (const row of rows) {
    const status = row.status ?? 'unknown';
    byStatus[status] = row.count;
    totalOutbound += row.count;
    if (FAILURE_STATUSES.includes(status)) failures += row.count;
  }
  return {
    totalOutbound,
    byStatus,
    failureRate: totalOutbound > 0 ? failures / totalOutbound : null,
  };
}

// 04 §12: "message_event.delivery_status distribution ... by carrier (Twilio
// exposes carrier info on lookup)." The carrier half isn't implemented —
// message_event (04 §3.1) has no carrier column, and nothing in this schema
// calls Twilio's Lookup API to populate one. That's a schema change plus a
// new integration, not something a query can produce from data that was
// never written. This returns the status distribution and derived failure
// rate that alerting (§B) actually needs; carrier segmentation is a separate
// scope decision, flagged here rather than silently dropped.
export async function getMessageDeliverability(): Promise<DeliverabilityResult> {
  const { rows } = await getPool().query<{ status: string | null; count: number }>(
    `SELECT delivery_status AS status, COUNT(*)::int AS count
     FROM message_event
     WHERE direction = 'outbound'
     GROUP BY delivery_status`,
  );
  return rowsToDeliverabilityResult(rows);
}

// 13 breakdown §B step 4: getMessageDeliverability above is an all-time
// snapshot, matching 04 §12's formula literally — but the alerting check
// needs the *recent* rate ("comparing the recent ... rate against a
// threshold"), not an all-time average that a P0 incident an hour ago would
// take days to visibly move. Trailing window ending at `asOf`, same posture
// as getMealsLoggedPerActiveUser(asOf): a caller-supplied instant rather than
// SQL now(), so the periodic alert tick can drive this deterministically.
export async function getRecentMessageDeliverability(
  windowMs: number,
  asOf: Date = new Date(),
): Promise<DeliverabilityResult> {
  const { rows } = await getPool().query<{ status: string | null; count: number }>(
    `SELECT delivery_status AS status, COUNT(*)::int AS count
     FROM message_event
     WHERE direction = 'outbound'
       AND sent_at >= $1::timestamptz - ($2 * INTERVAL '1 millisecond')
       AND sent_at < $1::timestamptz
     GROUP BY delivery_status`,
    [asOf.toISOString(), windowMs],
  );
  return rowsToDeliverabilityResult(rows);
}
