import { randomInt } from 'node:crypto';
import type { MealCandidate } from '@tally/shared-types';
import { afterAll, describe, expect, it } from 'vitest';
import {
  getCoachSeatAttachRate,
  getCorrectionRate,
  getFreeToPaidConversionRate,
  getMealsLoggedPerActiveUser,
  getMessageDeliverability,
  getNudgeResponseRate,
  getRecentMessageDeliverability,
  getRetentionCohort,
  getTimeToFirstLog,
} from './metrics.js';
import { getPool } from './pool.js';
import { uniqueTestPhone } from './testSupport.js';
import { createUser } from './users.js';

// Every metric below (other than getRetentionCohort/getMealsLoggedPerActiveUser,
// which are scoped to a specific date/window) reads the *entire* table with
// no per-user or per-run scoping — the same posture the doc's own formulas
// describe (04 §12). Other test files' fixtures share this same Postgres
// instance and are never cleaned up between tests, so asserting an absolute
// count here would be flaky by construction. Every such test instead asserts
// the *delta* caused by its own fixtures, which is exact regardless of what
// else is in the table.

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

// getRetentionCohort/getMealsLoggedPerActiveUser aren't delta-testable the
// same way (they're windowed to a specific date/instant, not the whole
// table), so isolation instead comes from picking that date/instant at
// random per run, the same rationale as uniqueTestPhone (10 breakdown
// §testSupport) but for a UTC day rather than a phone number: a fixed
// literal date would collide with the same fixture left behind by this
// file's own *previous* run against a persistent local dev Postgres (unlike
// CI's fresh-per-run container), silently multiplying the expected counts.
const MIN_DAY = Math.floor(Date.UTC(1971, 0, 1) / 86_400_000);
const MAX_DAY = Math.floor(Date.UTC(2069, 0, 1) / 86_400_000);
function randomAnchorDate(): Date {
  return new Date(randomInt(MIN_DAY, MAX_DAY) * 86_400_000);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function plusDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

async function insertUserAt(createdAt: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO "user" (phone_e164, created_at) VALUES ($1, $2::timestamptz) RETURNING id`,
    [uniqueTestPhone(), createdAt],
  );
  return rows[0].id;
}

function candidate(overrides: Partial<MealCandidate> = {}): MealCandidate {
  return {
    items: [{ name: 'eggs', portion: '3', calories: 210, protein: 18, carbs: 2, fat: 15 }],
    calories: 210,
    protein: 18,
    carbs: 2,
    fat: 15,
    confidence: 'high',
    isFood: true,
    ...overrides,
  };
}

async function insertMealLogAt(
  userId: string,
  loggedAt: string,
  localDate: string,
  overrides: { correctedFromId?: string; softDeleted?: boolean } = {},
): Promise<string> {
  const c = candidate();
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO meal_log
       (user_id, items, calories, protein, carbs, fat, confidence, source, local_date, logged_at, corrected_from_id, soft_deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'text', $8, $9::timestamptz, $10, $11)
     RETURNING id`,
    [
      userId,
      JSON.stringify(c.items),
      c.calories,
      c.protein,
      c.carbs,
      c.fat,
      c.confidence,
      localDate,
      loggedAt,
      overrides.correctedFromId ?? null,
      overrides.softDeleted ? loggedAt : null,
    ],
  );
  return rows[0].id;
}

describe('getTimeToFirstLog (13 breakdown §A step 1)', () => {
  it('averages seconds from user creation to first log, weighted correctly against pre-existing data', async () => {
    const before = await getTimeToFirstLog();

    const userA = await insertUserAt('2020-01-01T00:00:00Z');
    await insertMealLogAt(userA, '2020-01-01T00:10:00Z', '2020-01-01'); // +600s
    const userB = await insertUserAt('2020-01-02T00:00:00Z');
    await insertMealLogAt(userB, '2020-01-02T00:20:00Z', '2020-01-02'); // +1200s

    const after = await getTimeToFirstLog();

    expect(after.sampleSize).toBe(before.sampleSize + 2);
    const expectedAvg =
      ((before.avgSeconds ?? 0) * before.sampleSize + 600 + 1200) / after.sampleSize;
    expect(after.avgSeconds).toBeCloseTo(expectedAvg, 1);
  });

  it('excludes users who have never logged, and ignores a soft-deleted-only log', async () => {
    const before = await getTimeToFirstLog();

    await insertUserAt('2020-01-03T00:00:00Z'); // never logs
    const userWithOnlyDeleted = await insertUserAt('2020-01-04T00:00:00Z');
    await insertMealLogAt(userWithOnlyDeleted, '2020-01-04T00:05:00Z', '2020-01-04', {
      softDeleted: true,
    });

    const after = await getTimeToFirstLog();

    expect(after.sampleSize).toBe(before.sampleSize);
  });

  it('uses the earliest non-deleted log, not a later one', async () => {
    const before = await getTimeToFirstLog();

    const user = await insertUserAt('2020-01-05T00:00:00Z');
    await insertMealLogAt(user, '2020-01-05T02:00:00Z', '2020-01-05'); // +7200s, earliest
    await insertMealLogAt(user, '2020-01-05T05:00:00Z', '2020-01-05'); // later, should be ignored

    const after = await getTimeToFirstLog();

    expect(after.sampleSize).toBe(before.sampleSize + 1);
    const expectedAvg = ((before.avgSeconds ?? 0) * before.sampleSize + 7200) / after.sampleSize;
    expect(after.avgSeconds).toBeCloseTo(expectedAvg, 1);
  });
});

describe('getRetentionCohort (04 §12 D1/D7/D14/D30)', () => {
  it('counts a user retained when they log on exactly cohortDate + N days', async () => {
    const anchor = randomAnchorDate();
    const cohortDate = isoDate(anchor);
    const userRetained = await insertUserAt(`${cohortDate}T12:00:00Z`);
    const userChurned = await insertUserAt(`${cohortDate}T12:00:00Z`);
    const d7 = isoDate(plusDays(anchor, 7));
    const d8 = isoDate(plusDays(anchor, 8));
    await insertMealLogAt(userRetained, `${d7}T09:00:00Z`, d7); // exactly +7d
    await insertMealLogAt(userChurned, `${d8}T09:00:00Z`, d8); // +8d, misses D7

    const result = await getRetentionCohort(7, cohortDate);

    expect(result.cohortSize).toBe(2);
    expect(result.retainedCount).toBe(1);
    expect(result.retentionRate).toBeCloseTo(0.5);
  });

  it('does not count a log outside the cohort window as retention for a different N', async () => {
    const anchor = randomAnchorDate();
    const cohortDate = isoDate(anchor);
    const user = await insertUserAt(`${cohortDate}T12:00:00Z`);
    const d7 = isoDate(plusDays(anchor, 7));
    await insertMealLogAt(user, `${d7}T09:00:00Z`, d7); // +7d

    const d1 = await getRetentionCohort(1, cohortDate);
    expect(d1.retainedCount).toBe(0);

    const d7Result = await getRetentionCohort(7, cohortDate);
    expect(d7Result.retainedCount).toBe(1);
  });

  it('returns a null rate rather than dividing by zero for an empty cohort', async () => {
    const result = await getRetentionCohort(1, isoDate(randomAnchorDate()));
    expect(result.cohortSize).toBe(0);
    expect(result.retentionRate).toBeNull();
  });
});

describe('getMealsLoggedPerActiveUser (04 §12)', () => {
  it('divides trailing-7-day meal count by distinct active users, scoped to the asOf window', async () => {
    const anchor = randomAnchorDate(); // this test's "asOf" instant
    const asOf = anchor;
    const userA = await insertUserAt(isoDate(plusDays(anchor, -38)) + 'T00:00:00Z');
    const userB = await insertUserAt(isoDate(plusDays(anchor, -38)) + 'T00:00:00Z');
    const within1 = isoDate(plusDays(anchor, -6));
    const within2 = isoDate(plusDays(anchor, -5));
    const within3 = isoDate(plusDays(anchor, -3));
    const tooOld = isoDate(plusDays(anchor, -38));
    const atAsOf = isoDate(anchor);
    await insertMealLogAt(userA, `${within1}T00:00:00Z`, within1); // within trailing 7d
    await insertMealLogAt(userA, `${within2}T00:00:00Z`, within2); // within trailing 7d
    await insertMealLogAt(userB, `${within3}T00:00:00Z`, within3); // within trailing 7d
    await insertMealLogAt(userB, `${tooOld}T00:00:00Z`, tooOld); // too old, excluded
    await insertMealLogAt(userA, `${atAsOf}T00:00:00Z`, atAsOf); // >= asOf, excluded

    const result = await getMealsLoggedPerActiveUser(asOf);

    expect(result.totalMeals).toBe(3);
    expect(result.activeUsers).toBe(2);
    expect(result.mealsPerActiveUser).toBeCloseTo(1.5);
  });

  it('returns a null ratio rather than dividing by zero when no one was active', async () => {
    const result = await getMealsLoggedPerActiveUser(randomAnchorDate());
    expect(result.activeUsers).toBe(0);
    expect(result.mealsPerActiveUser).toBeNull();
  });
});

describe('getNudgeResponseRate (04 §12)', () => {
  it('counts a response within 1 hour as retained, and outside it as not', async () => {
    const before = await getNudgeResponseRate();
    const user = await createUser(uniqueTestPhone());

    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, responded_at, delivery_status)
       VALUES ($1, 'outbound', 'nudge', now(), now() + interval '30 minutes', 'delivered')`,
      [user.id],
    );
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, responded_at, delivery_status)
       VALUES ($1, 'outbound', 'nudge', now(), now() + interval '2 hours', 'delivered')`,
      [user.id],
    );
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, responded_at, delivery_status)
       VALUES ($1, 'outbound', 'nudge', now(), NULL, 'delivered')`,
      [user.id],
    );

    const after = await getNudgeResponseRate();

    expect(after.nudgesSent - before.nudgesSent).toBe(3);
    expect(after.respondedWithinHour - before.respondedWithinHour).toBe(1);
  });

  it('excludes inbound messages and non-nudge types', async () => {
    const before = await getNudgeResponseRate();
    const user = await createUser(uniqueTestPhone());

    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, 'inbound', 'nudge', now(), 'delivered')`,
      [user.id],
    );
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, 'outbound', 'recap', now(), 'delivered')`,
      [user.id],
    );

    const after = await getNudgeResponseRate();

    expect(after.nudgesSent).toBe(before.nudgesSent);
  });
});

describe('getCorrectionRate (04 §12)', () => {
  it('counts a correction logged within 24h of the original, against the total log count', async () => {
    const before = await getCorrectionRate();
    const user = await createUser(uniqueTestPhone());

    const original = await insertMealLogAt(user.id, '2022-01-01T00:00:00Z', '2022-01-01');
    await insertMealLogAt(user.id, '2022-01-01T10:00:00Z', '2022-01-01', {
      correctedFromId: original,
    }); // within 24h
    const laterOriginal = await insertMealLogAt(user.id, '2022-01-05T00:00:00Z', '2022-01-05');
    await insertMealLogAt(user.id, '2022-01-07T00:00:00Z', '2022-01-07', {
      correctedFromId: laterOriginal,
    }); // 2 days later, outside 24h

    const after = await getCorrectionRate();

    expect(after.totalLogs - before.totalLogs).toBe(4);
    expect(after.correctionsWithin24h - before.correctionsWithin24h).toBe(1);
  });
});

describe('getFreeToPaidConversionRate (04 §12)', () => {
  it('counts a user as converted only once they hit the limit AND have a real Stripe subscription', async () => {
    const before = await getFreeToPaidConversionRate();

    const paidUser = await createUser(uniqueTestPhone());
    await getPool().query(
      `INSERT INTO subscription (user_id, free_analyses_used, free_analyses_limit, status, stripe_customer_id, stripe_subscription_id)
       VALUES ($1, 20, 20, 'active', $2, $3)`,
      [paidUser.id, uniqueId('cus'), uniqueId('sub')],
    );

    // Hit the limit but never actually paid — status defaults to 'active' on
    // a plain free row too (04 §3.1), which is exactly why status alone
    // isn't used as the "converted" signal.
    const freeUserAtLimit = await createUser(uniqueTestPhone());
    await getPool().query(
      `INSERT INTO subscription (user_id, free_analyses_used, free_analyses_limit)
       VALUES ($1, 20, 20)`,
      [freeUserAtLimit.id],
    );

    const freeUserBelowLimit = await createUser(uniqueTestPhone());
    await getPool().query(
      `INSERT INTO subscription (user_id, free_analyses_used, free_analyses_limit)
       VALUES ($1, 5, 20)`,
      [freeUserBelowLimit.id],
    );

    const after = await getFreeToPaidConversionRate();

    expect(after.usersHitLimit - before.usersHitLimit).toBe(2); // paidUser + freeUserAtLimit
    expect(after.converted - before.converted).toBe(1); // paidUser only
  });
});

describe('getCoachSeatAttachRate (04 §12, 13 breakdown §A step 2)', () => {
  it('divides active client_link attachments by active coach seats', async () => {
    const before = await getCoachSeatAttachRate();

    const { rows: activeCoachRows } = await getPool().query<{ id: string }>(
      `INSERT INTO coach (name, email, referral_code, seat_status) VALUES ('Active Coach', $1, $2, 'active') RETURNING id`,
      [`${uniqueId('coach')}@example.com`, uniqueId('ref')],
    );
    await getPool().query(
      `INSERT INTO coach (name, email, referral_code, seat_status) VALUES ('Suspended Coach', $1, $2, 'suspended')`,
      [`${uniqueId('coach')}@example.com`, uniqueId('ref')],
    );
    const activeCoachId = activeCoachRows[0].id;

    const linkedUser = await createUser(uniqueTestPhone());
    const unlinkedUser = await createUser(uniqueTestPhone());
    await getPool().query(
      `INSERT INTO client_link (coach_id, user_id, consent_confirmed) VALUES ($1, $2, true)`,
      [activeCoachId, linkedUser.id],
    );
    await getPool().query(
      `INSERT INTO client_link (coach_id, user_id, consent_confirmed, unlinked_at) VALUES ($1, $2, true, now())`,
      [activeCoachId, unlinkedUser.id],
    );

    const after = await getCoachSeatAttachRate();

    expect(after.activeCoachSeats - before.activeCoachSeats).toBe(1);
    expect(after.attachedClientLinks - before.attachedClientLinks).toBe(1);
  });
});

describe('getMessageDeliverability (04 §12)', () => {
  it('buckets outbound messages by delivery_status and computes the failed+undelivered rate', async () => {
    const before = await getMessageDeliverability();
    const user = await createUser(uniqueTestPhone());

    const statuses = ['delivered', 'delivered', 'failed', 'undelivered'];
    for (const status of statuses) {
      await getPool().query(
        `INSERT INTO message_event (user_id, direction, type, delivery_status) VALUES ($1, 'outbound', 'log_reply', $2)`,
        [user.id, status],
      );
    }
    // Inbound traffic must not count toward outbound deliverability.
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, delivery_status) VALUES ($1, 'inbound', 'log_reply', 'received')`,
      [user.id],
    );

    const after = await getMessageDeliverability();

    expect(after.totalOutbound - before.totalOutbound).toBe(4);
    expect((after.byStatus.delivered ?? 0) - (before.byStatus.delivered ?? 0)).toBe(2);
    expect((after.byStatus.failed ?? 0) - (before.byStatus.failed ?? 0)).toBe(1);
    expect((after.byStatus.undelivered ?? 0) - (before.byStatus.undelivered ?? 0)).toBe(1);
  });
});

describe('getRecentMessageDeliverability (13 breakdown §B step 4)', () => {
  async function insertOutboundAt(userId: string, sentAt: string, status: string): Promise<void> {
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, 'outbound', 'log_reply', $2::timestamptz, $3)`,
      [userId, sentAt, status],
    );
  }

  it('only counts outbound messages within the trailing window ending at asOf', async () => {
    const anchor = randomAnchorDate();
    const user = await createUser(uniqueTestPhone());
    const within = new Date(anchor.getTime() - 10 * 60 * 1000).toISOString(); // 10 min before asOf
    const tooOld = new Date(anchor.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h before asOf
    const atAsOf = anchor.toISOString(); // >= asOf, excluded
    await insertOutboundAt(user.id, within, 'failed');
    await insertOutboundAt(user.id, within, 'delivered');
    await insertOutboundAt(user.id, tooOld, 'failed');
    await insertOutboundAt(user.id, atAsOf, 'failed');

    const result = await getRecentMessageDeliverability(60 * 60 * 1000, anchor);

    expect(result.totalOutbound).toBe(2);
    expect(result.byStatus.failed).toBe(1);
    expect(result.byStatus.delivered).toBe(1);
    expect(result.failureRate).toBeCloseTo(0.5);
  });

  it('excludes inbound messages from the window', async () => {
    const anchor = randomAnchorDate();
    const user = await createUser(uniqueTestPhone());
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, 'inbound', 'log_reply', $2::timestamptz, 'received')`,
      [user.id, new Date(anchor.getTime() - 60_000).toISOString()],
    );

    const result = await getRecentMessageDeliverability(60 * 60 * 1000, anchor);

    expect(result.totalOutbound).toBe(0);
    expect(result.failureRate).toBeNull();
  });
});

afterAll(async () => {
  await getPool().end();
});
