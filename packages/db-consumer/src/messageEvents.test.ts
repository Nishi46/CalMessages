import { afterAll, describe, expect, it } from 'vitest';
import { createUser } from './users.js';
import {
  createMessageEvent,
  updateMessageEventStatus,
  updateMessageEventStatusBySid,
  updateMessageEventTwilioSid,
} from './messageEvents.js';
import { getPool } from './pool.js';

describe('updateMessageEventStatusBySid — terminal status lock', () => {
  it('does not let a later out-of-order callback regress a terminal status', async () => {
    const user = await createUser(`+1${Date.now()}`);
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
    const user = await createUser(`+1${Date.now()}1`);
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
    const user = await createUser(`+1${Date.now()}2`);
    const event = await createMessageEvent(user.id, 'outbound', 'nudge');

    const failed = await updateMessageEventStatus(event.id, 'failed');
    expect(failed.deliveryStatus).toBe('failed');
    expect(failed.twilioSid).toBeNull();
  });
});

afterAll(async () => {
  await getPool().end();
});
