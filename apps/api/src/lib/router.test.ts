import {
  createGoal,
  createMealLog,
  createUser,
  getDailyTotals,
  getPool,
  getUserByPhone,
} from '@tally/db-consumer';
import type { TwilioSendClient } from '@tally/messaging';
import type { MealCandidate } from '@tally/shared-types';
import { computeLocalDate } from '@tally/time';
import type { TextParser, VisionProvider } from '@tally/vision';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createInboundMessageHandler } from './router.js';

function fakeSendClient(): TwilioSendClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ sid: 'SM_fake' }) };
}

function fakeCandidate(overrides: Partial<MealCandidate> = {}): MealCandidate {
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

function fakeVisionProvider(recognize: (photoKey: string) => Promise<MealCandidate>): VisionProvider {
  return { recognize };
}

function fakeTextParser(parse: (text: string) => Promise<MealCandidate>): TextParser {
  return { parse };
}

function noVisionProvider(): VisionProvider {
  return { recognize: vi.fn().mockRejectedValue(new Error('visionProvider should not be called')) };
}

function noTextParser(): TextParser {
  return { parse: vi.fn().mockRejectedValue(new Error('textParser should not be called')) };
}

// The async-completion path fires several real DB round-trips after its
// triggering promise settles, so a single microtask flush isn't enough to
// observe it — poll instead of guessing a fixed delay.
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: condition not met within timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createInboundMessageHandler (07 §D, against a real Postgres)', () => {
  it('walks a fresh user through onboarding to idle, sending four replies and creating a goal', async () => {
    const phone = `+1${Date.now()}`;
    const user = await createUser(phone);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
    });

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
      'awaiting_checkout',
    ]);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'chicken and rice',
      currentState: 'awaiting_checkout',
    });

    expect(sendClient.send).not.toHaveBeenCalled();
    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('awaiting_checkout');
  });
});

describe('createInboundMessageHandler — meal_content fast path (09 §D)', () => {
  it('high confidence: writes the meal log, stays idle, and replies with macros + daily total', async () => {
    const phone = `+1${Date.now()}2`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    await createGoal(user.id, { type: 'lose', dailyCalories: 1650, dailyProtein: 120 });
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ confidence: 'high' });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/abc', currentState: 'idle' });

    expect(sendClient.send).toHaveBeenCalledTimes(1);
    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Logged: 210 cal, 18g protein, 2g carbs, 15g fat.');
    expect(body).toContain('Today: 210/1650 cal so far.');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    const localDate = computeLocalDate(new Date(), current!.timezone);
    const totals = await getDailyTotals(user.id, localDate);
    expect(totals).toEqual({ calories: 210, protein: 18, carbs: 2, fat: 15 });
  });

  it('breaks the reply out per item when the candidate has more than one item', async () => {
    const phone = `+1${Date.now()}3`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({
      confidence: 'medium',
      items: [
        { name: 'eggs', portion: '2', calories: 140, protein: 12, carbs: 1, fat: 10 },
        { name: 'toast', portion: '1 slice', calories: 80, protein: 3, carbs: 15, fat: 1 },
      ],
      calories: 220,
      protein: 15,
      carbs: 16,
      fat: 11,
    });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/def', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('- eggs (2): 140 cal');
    expect(body).toContain('- toast (1 slice): 80 cal');
  });

  it('low confidence: holds the candidate, moves to awaiting_clarification, and asks the clarifying question', async () => {
    const phone = `+1${Date.now()}4`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ confidence: 'low', confidenceNote: 'unclear portion size' });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/ghi', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('unclear portion size');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('awaiting_clarification');
    expect(current?.conversationContext).toMatchObject({ pendingKind: 'meal_candidate', candidate });

    const { rows } = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);
  });

  it('completes a held low-confidence candidate once the clarifying answer arrives', async () => {
    const phone = `+1${Date.now()}5`;
    const user = await createUser(phone);
    const candidate = fakeCandidate({ confidence: 'low' });
    await getPool().query(
      'UPDATE "user" SET conversation_state = $2, conversation_context = $3 WHERE id = $1',
      [user.id, 'awaiting_clarification', JSON.stringify({ pendingKind: 'meal_candidate', candidate })],
    );
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'it was 3 scrambled eggs',
      currentState: 'awaiting_clarification',
    });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Logged: 210 cal');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    const { rows } = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
  });

  it('non-food: sends a terminal reply, stays idle, and writes no log', async () => {
    const phone = `+1${Date.now()}6`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ isFood: false, rejectionReason: 'non_food', items: [] });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/jkl', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain("doesn't look like food");

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');
    const { rows } = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);
  });

  it('unassessable: sends the retake/describe reply, distinct from the non-food copy', async () => {
    const phone = `+1${Date.now()}7`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ isFood: false, rejectionReason: 'unassessable', items: [] });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/mno', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('clearer photo');
  });

  it('dispatches to textParser (not visionProvider) when there is no photoKey', async () => {
    const phone = `+1${Date.now()}8`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate();
    const parse = vi.fn().mockResolvedValue(candidate);
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: fakeTextParser(parse),
    });

    await handleInboundMessage({ userId: user.id, text: 'three eggs', currentState: 'idle' });

    expect(parse).toHaveBeenCalledWith('three eggs');
  });

  it('prefers the photo over text when both are present', async () => {
    const phone = `+1${Date.now()}9`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate();
    const recognize = vi.fn().mockResolvedValue(candidate);
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(recognize),
      textParser: noTextParser(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'three eggs',
      photoKey: 'meal-photos/pqr',
      currentState: 'idle',
    });

    expect(recognize).toHaveBeenCalledWith('meal-photos/pqr');
  });

  it('sends a holding reply and completes the log asynchronously when recognize() is slower than the timeout', async () => {
    const phone = `+1${Date.now()}10`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate();
    const slowPending = new Promise<MealCandidate>((resolve) => {
      setTimeout(() => resolve(candidate), 40);
    });
    const onAsyncError = vi.fn();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(() => slowPending),
      textParser: noTextParser(),
      mealContentTimeoutMs: 10,
      onAsyncError,
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/stu', currentState: 'idle' });

    expect(sendClient.send).toHaveBeenCalledTimes(1);
    expect((sendClient.send.mock.calls[0] as [string, string])[1]).toContain('one sec');

    await waitUntil(() => sendClient.send.mock.calls.length >= 2);

    expect(sendClient.send).toHaveBeenCalledTimes(2);
    expect((sendClient.send.mock.calls[1] as [string, string])[1]).toContain('Logged: 210 cal');
    expect(onAsyncError).not.toHaveBeenCalled();
  });

  it('reports a fast provider error through onAsyncError instead of throwing out of the handler', async () => {
    const phone = `+1${Date.now()}11`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const onAsyncError = vi.fn();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockRejectedValue(new Error('provider down'))),
      textParser: noTextParser(),
      mealContentTimeoutMs: 1000,
      onAsyncError,
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/vwx', currentState: 'idle' });

    expect(sendClient.send).toHaveBeenCalledTimes(1);
    expect((sendClient.send.mock.calls[0] as [string, string])[1]).toContain('one sec');

    await waitUntil(() => onAsyncError.mock.calls.length >= 1);
    expect(onAsyncError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('createInboundMessageHandler — correction/edit resolution (09 §E)', () => {
  it('corrects a single same-day match, using the total for that entry\'s own date', async () => {
    const phone = `+1${Date.now()}12`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const original = await createMealLog(
      user.id,
      fakeCandidate({ calories: 300, protein: 25, carbs: 5, fat: 20 }),
      'photo',
      '2026-08-27',
    );
    const sendClient = fakeSendClient();
    const replacement = fakeCandidate({ calories: 210, protein: 18, carbs: 2, fat: 15 });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: fakeTextParser(vi.fn().mockResolvedValue(replacement)),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'that was actually 2 eggs not 3',
      currentState: 'idle',
    });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Updated — that entry is now 210 cal');
    // The original 300-cal row is still live (createCorrection doesn't
    // delete it) — the day's total is the original plus the correction.
    expect(body).toContain('Total for that day is now 510 cal.');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    const { rows } = await getPool().query<{ corrected_from_id: string }>(
      'SELECT corrected_from_id FROM meal_log WHERE user_id = $1 AND corrected_from_id IS NOT NULL',
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].corrected_from_id).toBe(original.id);
  });

  it('deletes a single match on a "delete that" with no replacement, using textParser only for correction, not delete', async () => {
    const phone = `+1${Date.now()}13`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    await createMealLog(user.id, fakeCandidate({ calories: 300 }), 'photo', '2026-08-27');
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, text: 'delete that', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Deleted. Total for that day is now 0 cal.');

    const { rows } = await getPool().query<{ soft_deleted_at: Date | null }>(
      'SELECT soft_deleted_at FROM meal_log WHERE user_id = $1',
      [user.id],
    );
    expect(rows[0]?.soft_deleted_at).not.toBeNull();
  });

  it('resolves a correction against a prior day when the text names one explicitly', async () => {
    const phone = `+1${Date.now()}14`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const today = computeLocalDate(new Date(), user.timezone);
    const yesterday = computeLocalDate(new Date(Date.now() - 24 * 60 * 60 * 1000), user.timezone);
    await createMealLog(user.id, fakeCandidate({ calories: 999 }), 'photo', today); // unrelated, today
    await createMealLog(user.id, fakeCandidate({ calories: 400 }), 'photo', yesterday);
    const sendClient = fakeSendClient();
    const replacement = fakeCandidate({ calories: 350 });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: fakeTextParser(vi.fn().mockResolvedValue(replacement)),
    });

    await handleInboundMessage({
      userId: user.id,
      text: "that was actually yesterday's lunch, it was smaller",
      currentState: 'idle',
    });

    // Today's total is untouched — the correction landed on yesterday's
    // date, adding to (not replacing) yesterday's original 400-cal row.
    const todayTotals = await getDailyTotals(user.id, today);
    expect(todayTotals.calories).toBe(999);
    const yesterdayTotals = await getDailyTotals(user.id, yesterday);
    expect(yesterdayTotals.calories).toBe(750);
  });

  it('holds a disambiguation context and asks which entry, when more than one match exists', async () => {
    const phone = `+1${Date.now()}15`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const today = computeLocalDate(new Date(), user.timezone);
    await createMealLog(user.id, fakeCandidate(), 'photo', today);
    await createMealLog(user.id, fakeCandidate(), 'text', today);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'that was actually 2 eggs',
      currentState: 'idle',
    });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('which one did you mean');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('awaiting_clarification');
    expect(current?.conversationContext).toMatchObject({
      pendingKind: 'correction_target',
      intent: 'correct',
    });
    expect((current?.conversationContext as { candidateLogIds: string[] }).candidateLogIds).toHaveLength(2);
  });

  it('replies that nothing recent was found when there is no match, without changing state', async () => {
    const phone = `+1${Date.now()}16`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'that was actually 2 eggs',
      currentState: 'idle',
    });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain("couldn't find anything recent");

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');
  });
});

// 09 §G step 30: the whole sprint's fast path, told as continuous
// user-facing scripts rather than isolated assertions — each turn re-reads
// the user's persisted state the way the real webhook route does, so a
// multi-turn scenario (script 2) exercises the actual state hand-off
// between turns, not just each half in isolation.
describe('handleInboundMessage — end-to-end scripted flows (09 §G, breakdown step 30)', () => {
  it('photo -> high-confidence log reply', async () => {
    const phone = `+1${Date.now()}17`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(fakeCandidate({ confidence: 'high' }))),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/e2e-1', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Logged: 210 cal');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');
  });

  it('photo -> low-confidence clarifying question -> answer -> completed log', async () => {
    const phone = `+1${Date.now()}18`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const lowConfidenceCandidate = fakeCandidate({ confidence: 'low', confidenceNote: 'blurry photo' });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(lowConfidenceCandidate)),
      textParser: noTextParser(),
    });

    // Turn 1: photo comes back low-confidence — held, not logged yet.
    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/e2e-2', currentState: 'idle' });

    const [, firstReply] = sendClient.send.mock.calls[0] as [string, string];
    expect(firstReply).toContain('blurry photo');
    expect(firstReply).not.toContain('Logged:');

    const afterTurn1 = await getUserByPhone(phone);
    expect(afterTurn1?.conversationState).toBe('awaiting_clarification');
    const rowsAfterTurn1 = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rowsAfterTurn1.rows).toHaveLength(0);

    // Turn 2: the clarifying answer arrives — re-reads the state turn 1 just
    // persisted, exactly as the webhook route would for the next inbound
    // message from the same user.
    await handleInboundMessage({
      userId: user.id,
      text: 'it was 3 scrambled eggs',
      currentState: afterTurn1!.conversationState,
    });

    const [, secondReply] = sendClient.send.mock.calls[1] as [string, string];
    expect(secondReply).toContain('Logged: 210 cal');

    const afterTurn2 = await getUserByPhone(phone);
    expect(afterTurn2?.conversationState).toBe('idle');
    const rowsAfterTurn2 = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rowsAfterTurn2.rows).toHaveLength(1);
  });

  it('text correction referencing "yesterday\'s lunch" -> corrected entry with the right date\'s total', async () => {
    const phone = `+1${Date.now()}19`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const today = computeLocalDate(new Date(), user.timezone);
    const yesterday = computeLocalDate(new Date(Date.now() - 24 * 60 * 60 * 1000), user.timezone);
    await createMealLog(user.id, fakeCandidate({ calories: 500 }), 'photo', yesterday);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: fakeTextParser(vi.fn().mockResolvedValue(fakeCandidate({ calories: 350 }))),
    });

    await handleInboundMessage({
      userId: user.id,
      text: "that was actually yesterday's lunch, smaller portion",
      currentState: 'idle',
    });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Updated — that entry is now 350 cal');
    // 500 (original, still live) + 350 (correction) — yesterday's total, not today's.
    expect(body).toContain('Total for that day is now 850 cal.');

    const todayTotals = await getDailyTotals(user.id, today);
    expect(todayTotals.calories).toBe(0);
  });

  it('"delete that" -> soft-deleted entry, totals updated', async () => {
    const phone = `+1${Date.now()}20`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const today = computeLocalDate(new Date(), user.timezone);
    const log = await createMealLog(user.id, fakeCandidate({ calories: 300 }), 'photo', today);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
    });

    await handleInboundMessage({ userId: user.id, text: 'delete that', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toBe('Deleted. Total for that day is now 0 cal.');

    const { rows } = await getPool().query<{ soft_deleted_at: Date | null }>(
      'SELECT soft_deleted_at FROM meal_log WHERE id = $1',
      [log.id],
    );
    expect(rows[0]?.soft_deleted_at).not.toBeNull();
    const totals = await getDailyTotals(user.id, today);
    expect(totals.calories).toBe(0);
  });

  afterAll(async () => {
    await getPool().end();
  });
});
