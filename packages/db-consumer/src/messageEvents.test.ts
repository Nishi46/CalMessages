import { afterAll, describe, expect, it } from 'vitest';
import { createUser } from './users.js';
import {
  countNudgesSentToday,
  createMessageEvent,
  updateMessageEventStatus,
  updateMessageEventStatusBySid,
  updateMessageEventTwilioSid,
} from './messageEvents.js';
import { getPool } from './pool.js';
import { uniqueTestPhone } from './testSupport.js';

describe('updateMessageEventStatusBySid — terminal status lock', () => {
  it('does not let a later out-of-order callback regress a terminal status', async () => {
    const user = await createUser(uniqueTestPhone());
    const event = await createMessageEvent(user.id, 'outbound', 'nudge');
    await updateMessageEventTwilioSid(event.id, 'SM_out_of_order');

    const delivered = await updateMessageEventStatusBySid('SM_out_of_order', 'delivered');
    expect(delivered?.deliveryStatus).toBe('delivered');

    // A delayed "sent" callback arrives after "delivered" already landed.
    const regressed = await updateMessageEventStatusBySid('SM_out_of_order', 'sent');
    expect(regressed).toBeNull();

    const { rows } = await getPool().query<{ delivery_status: string }>(
      'SELECT delivery_status FROM message_event WHERE id = $1',
      [event.id],
    );
    expect(rows[0]?.delivery_status).toBe('delivered');
  });

  it('still allows non-terminal statuses to progress normally', async () => {
    const user = await createUser(uniqueTestPhone());
    const event = await createMessageEvent(user.id, 'outbound', 'nudge');
    await updateMessageEventTwilioSid(event.id, 'SM_progressing');

    const sent = await updateMessageEventStatusBySid('SM_progressing', 'sent');
    expect(sent?.deliveryStatus).toBe('sent');

    const delivered = await updateMessageEventStatusBySid('SM_progressing', 'delivered');
    expect(delivered?.deliveryStatus).toBe('delivered');
  });
});

describe('updateMessageEventStatus', () => {
  it('sets delivery status by id, for when a send fails before Twilio returns a sid', async () => {
    const user = await createUser(uniqueTestPhone());
    const event = await createMessageEvent(user.id, 'outbound', 'nudge');

    const failed = await updateMessageEventStatus(event.id, 'failed');
    expect(failed.deliveryStatus).toBe('failed');
    expect(failed.twilioSid).toBeNull();
  });
});

describe("countNudgesSentToday (09 breakdown §C step 9 — buckets by the user's LOCAL day, not UTC)", () => {
  async function insertNudge(userId: string, sentAtUtc: string, overrides: { direction?: string; type?: string } = {}) {
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, $2, $3, $4, 'sent')`,
      [userId, overrides.direction ?? 'outbound', overrides.type ?? 'nudge', sentAtUtc],
    );
  }

  it('counts an outbound nudge sent within the given local date, for the default America/New_York timezone', async () => {
    const user = await createUser(uniqueTestPhone());
    // 2026-08-26T20:00:00Z is 2026-08-26T16:00 in America/New_York (EDT, UTC-4).
    await insertNudge(user.id, '2026-08-26T20:00:00Z');

    expect(await countNudgesSentToday(user.id, '2026-08-26')).toBe(1);
    expect(await countNudgesSentToday(user.id, '2026-08-25')).toBe(0);
  });

  it('excludes inbound messages and non-nudge types', async () => {
    const user = await createUser(uniqueTestPhone());
    await insertNudge(user.id, '2026-08-26T20:00:00Z', { direction: 'inbound' });
    await insertNudge(user.id, '2026-08-26T20:00:00Z', { type: 'recap' });

    expect(await countNudgesSentToday(user.id, '2026-08-26')).toBe(0);
  });

  it("buckets by the user's local day, not the UTC calendar day, right at the local-midnight boundary", async () => {
    const user = await createUser(uniqueTestPhone());
    // 2026-08-27T03:30:00Z is 2026-08-26T23:30 in America/New_York — the same
    // instant computeLocalDate.test.ts uses, so both agree on which local
    // day a send just before local midnight belongs to.
    await insertNudge(user.id, '2026-08-27T03:30:00Z');

    expect(await countNudgesSentToday(user.id, '2026-08-26')).toBe(1);
    expect(await countNudgesSentToday(user.id, '2026-08-27')).toBe(0);
  });

  it('scopes the count to the given user only', async () => {
    const userA = await createUser(uniqueTestPhone());
    const userB = await createUser(uniqueTestPhone());
    await insertNudge(userA.id, '2026-08-26T20:00:00Z');

    expect(await countNudgesSentToday(userB.id, '2026-08-26')).toBe(0);
  });
});

afterAll(async () => {
  await getPool().end();
});
