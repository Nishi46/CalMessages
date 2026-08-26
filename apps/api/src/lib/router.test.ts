import { createUser, getPool, getUserByPhone } from '@tally/db-consumer';
import type { TwilioSendClient } from '@tally/messaging';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createInboundMessageHandler } from './router.js';

function fakeSendClient(): TwilioSendClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ sid: 'SM_fake' }) };
}

describe('createInboundMessageHandler (07 §D, against a real Postgres)', () => {
  it('walks a fresh user through onboarding to idle, sending four replies and creating a goal', async () => {
    const phone = `+1${Date.now()}`;
    const user = await createUser(phone);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({ sendClient });

    await handleInboundMessage({ userId: user.id, text: 'hi', currentState: 'new' });
    let current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('onboarding_q1');

    await handleInboundMessage({
      userId: user.id,
      text: 'lose weight, on a glp1',
      currentState: 'onboarding_q1',
    });
    current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('onboarding_q2');
    expect(current?.conversationContext).toMatchObject({ goalType: 'lose' });

    await handleInboundMessage({
      userId: user.id,
      text: '190lbs, no target given',
      currentState: 'onboarding_q2',
    });
    current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('onboarding_q3');
    expect(current?.conversationContext).toMatchObject({
      rawStartingPoint: '190lbs, no target given',
    });

    await handleInboundMessage({ userId: user.id, text: 'no', currentState: 'onboarding_q3' });
    current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    expect(sendClient.send).toHaveBeenCalledTimes(4);
    const confirmationCall = sendClient.send.mock.calls[3] as [string, string];
    expect(confirmationCall[1]).toContain('1650 cal and 120g protein');

    const { rows } = await getPool().query<{ type: string; daily_calories: number }>(
      'SELECT type, daily_calories FROM goal WHERE user_id = $1',
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ type: 'lose', daily_calories: 1650 });
  });

  it('is a no-op for an undefined {state, trigger} pair', async () => {
    const phone = `+1${Date.now()}1`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [
      user.id,
      'idle',
    ]);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({ sendClient });

    await handleInboundMessage({ userId: user.id, text: 'chicken and rice', currentState: 'idle' });

    expect(sendClient.send).not.toHaveBeenCalled();
    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');
  });

  afterAll(async () => {
    await getPool().end();
  });
});
