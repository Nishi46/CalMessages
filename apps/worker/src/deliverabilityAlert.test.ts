import { randomInt } from 'node:crypto';
import { createUser, getPool, uniqueTestPhone } from '@tally/db-consumer';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  consoleDeliverabilityNotifier,
  evaluateDeliverabilityAlert,
  runDeliverabilityAlertTick,
  type DeliverabilityNotifier,
} from './deliverabilityAlert.js';

function fakeNotifier(): DeliverabilityNotifier & { notify: ReturnType<typeof vi.fn> } {
  return { notify: vi.fn() };
}

// getRecentMessageDeliverability is windowed by real wall-clock time, not
// scoped to this test's own rows — using the real `new Date()` as `now`
// would sweep in every other test file's message_event fixtures that also
// default to real `now()`, diluting (or inflating) the intended failure
// rate. Anchoring far outside any real date, same rationale as
// packages/db-consumer/src/metrics.test.ts's randomAnchorDate, keeps this
// test's window from ever coinciding with real traffic.
const MIN_DAY = Math.floor(Date.UTC(1971, 0, 1) / 86_400_000);
const MAX_DAY = Math.floor(Date.UTC(2069, 0, 1) / 86_400_000);
function randomAnchorDate(): Date {
  return new Date(randomInt(MIN_DAY, MAX_DAY) * 86_400_000);
}

describe('evaluateDeliverabilityAlert (13 breakdown §B step 6 — pure, no DB)', () => {
  it('fires when the failure rate is strictly above the threshold', () => {
    const result = evaluateDeliverabilityAlert(
      { totalOutbound: 100, byStatus: { failed: 21, delivered: 79 }, failureRate: 0.21 },
      { failureRateThreshold: 0.2 },
    );
    expect(result.shouldAlert).toBe(true);
  });

  it('does not fire when the failure rate sits exactly at the threshold', () => {
    const result = evaluateDeliverabilityAlert(
      { totalOutbound: 100, byStatus: { failed: 20, delivered: 80 }, failureRate: 0.2 },
      { failureRateThreshold: 0.2 },
    );
    expect(result.shouldAlert).toBe(false);
  });

  it('does not fire when the failure rate is below the threshold', () => {
    const result = evaluateDeliverabilityAlert(
      { totalOutbound: 100, byStatus: { failed: 5, delivered: 95 }, failureRate: 0.05 },
      { failureRateThreshold: 0.2 },
    );
    expect(result.shouldAlert).toBe(false);
  });

  it('does not fire on a null failure rate (no outbound messages in the window)', () => {
    const result = evaluateDeliverabilityAlert(
      { totalOutbound: 0, byStatus: {}, failureRate: null },
      { failureRateThreshold: 0.2 },
    );
    expect(result.shouldAlert).toBe(false);
  });
});

describe('runDeliverabilityAlertTick (13 breakdown §B step 4, against a real Postgres)', () => {
  async function insertMessageEvent(
    userId: string,
    sentAt: string,
    deliveryStatus: string,
    direction: 'outbound' | 'inbound' = 'outbound',
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, $2, 'log_reply', $3::timestamptz, $4)`,
      [userId, direction, sentAt, deliveryStatus],
    );
  }

  it('notifies once the recent window\'s failure rate crosses the threshold', async () => {
    const user = await createUser(uniqueTestPhone());
    const now = randomAnchorDate();
    const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago, within window
    await insertMessageEvent(user.id, recent, 'failed');
    await insertMessageEvent(user.id, recent, 'undelivered');
    await insertMessageEvent(user.id, recent, 'delivered');
    const notifier = fakeNotifier();

    await runDeliverabilityAlertTick(notifier, now, 60 * 60 * 1000, { failureRateThreshold: 0.5 });

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const [evaluation, result] = notifier.notify.mock.calls[0];
    expect(evaluation.shouldAlert).toBe(true);
    expect(result.totalOutbound).toBe(3);
    expect(evaluation.failureRate).toBeCloseTo(2 / 3);
  });

  it('does not notify when the window\'s failure rate stays under the threshold', async () => {
    const user = await createUser(uniqueTestPhone());
    const now = randomAnchorDate();
    const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    await insertMessageEvent(user.id, recent, 'delivered');
    await insertMessageEvent(user.id, recent, 'delivered');
    await insertMessageEvent(user.id, recent, 'delivered');
    const notifier = fakeNotifier();

    await runDeliverabilityAlertTick(notifier, now, 60 * 60 * 1000, { failureRateThreshold: 0.5 });

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('ignores a failure outside the trailing window', async () => {
    const user = await createUser(uniqueTestPhone());
    const now = randomAnchorDate();
    const tooOld = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago, outside a 1h window
    await insertMessageEvent(user.id, tooOld, 'failed');
    const notifier = fakeNotifier();

    await runDeliverabilityAlertTick(notifier, now, 60 * 60 * 1000, { failureRateThreshold: 0.1 });

    expect(notifier.notify).not.toHaveBeenCalled();
  });
});

describe('consoleDeliverabilityNotifier', () => {
  it('logs a single structured error line including the rate and status breakdown', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    consoleDeliverabilityNotifier.notify(
      { shouldAlert: true, failureRate: 0.42, totalOutbound: 50 },
      { totalOutbound: 50, byStatus: { failed: 21, delivered: 29 }, failureRate: 0.42 },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] as [string];
    expect(line).toContain('42.0%');
    expect(line).toContain('50 outbound');
    expect(line).toContain('"failed":21');

    spy.mockRestore();
  });
});

afterAll(async () => {
  await getPool().end();
});
