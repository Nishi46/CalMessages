import {
  createGoal,
  createMealLog,
  createUser,
  getDailyTotals,
  getOrCreateSubscriptionForUser,
  getPool,
  getRecentMealLogsForUser,
  getSubscriptionStatus,
  getUserByPhone,
  incrementFreeAnalysesUsed,
  withTransaction,
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

function noCreateCheckoutLink(): (userId: string) => Promise<string> {
  return vi.fn().mockRejectedValue(new Error('createCheckoutLink should not be called'));
}

function fakeCreateCheckoutLink(url = 'https://checkout.stripe.com/c/fake'): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(url);
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
    const today = computeLocalDate(new Date(), user.timezone);
    const original = await createMealLog(
      user.id,
      fakeCandidate({ calories: 300, protein: 25, carbs: 5, fat: 20 }),
      'photo',
      today,
    );
    const sendClient = fakeSendClient();
    const replacement = fakeCandidate({ calories: 210, protein: 18, carbs: 2, fat: 15 });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: fakeTextParser(vi.fn().mockResolvedValue(replacement)),
      createCheckoutLink: noCreateCheckoutLink(),
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
    const today = computeLocalDate(new Date(), user.timezone);
    await createMealLog(user.id, fakeCandidate({ calories: 300 }), 'photo', today);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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

// 11 breakdown §B: free-tier metering and the paywall trigger it feeds.
// Seeds the subscription row directly via SQL (same pattern as the
// conversation_state seeding above) rather than logging up to the limit
// meal-by-meal, so each test only exercises the one crossing under test.
describe('createInboundMessageHandler — free-tier metering & paywall trigger (11 breakdown §B)', () => {
  async function seedSubscription(userId: string, freeAnalysesUsed: number): Promise<void> {
    await getPool().query('INSERT INTO subscription (user_id, free_analyses_used) VALUES ($1, $2)', [
      userId,
      freeAnalysesUsed,
    ]);
  }

  it('the log that crosses the limit is delivered in full, followed by a separate paywall message', async () => {
    const phone = `+1${Date.now()}21`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    await seedSubscription(user.id, 19); // default free_analyses_limit is 20 — this log crosses it
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ confidence: 'high' });
    const createCheckoutLink = fakeCreateCheckoutLink('https://checkout.stripe.com/c/session_abc');
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
      createCheckoutLink,
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/abc', currentState: 'idle' });

    // Build Spec §4.6 step 1 — the log reply goes out first, in full, and
    // only then the paywall message follows as a second, separate send.
    expect(sendClient.send).toHaveBeenCalledTimes(2);
    const [, logReplyBody] = sendClient.send.mock.calls[0] as [string, string];
    expect(logReplyBody).toContain('Logged: 210 cal, 18g protein, 2g carbs, 15g fat.');
    const [, paywallBody] = sendClient.send.mock.calls[1] as [string, string];
    expect(paywallBody).toContain('free logs');
    // 11 breakdown §C step 11: the paywall message interpolates a real
    // Stripe checkout link, built for this user specifically.
    expect(paywallBody).toContain('https://checkout.stripe.com/c/session_abc');
    expect(createCheckoutLink).toHaveBeenCalledWith(user.id);

    const { rows } = await getPool().query<{ type: string }>(
      `SELECT type FROM message_event WHERE user_id = $1 ORDER BY sent_at`,
      [user.id],
    );
    expect(rows.map((r) => r.type)).toEqual(['log_reply', 'paywall']);

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('awaiting_checkout');

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.freeAnalysesUsed).toBe(20);
  });

  it('does not fire the paywall on a log that stays under the limit', async () => {
    const phone = `+1${Date.now()}22`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    await seedSubscription(user.id, 18); // this log lands at 19, one short of the limit
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ confidence: 'high' });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/abc', currentState: 'idle' });

    expect(sendClient.send).toHaveBeenCalledTimes(1);
    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.freeAnalysesUsed).toBe(19);
  });

  it('does not re-fire the paywall on a log logged while already over the limit', async () => {
    const phone = `+1${Date.now()}23`;
    const user = await createUser(phone);
    // Already past the limit but still idle — the state a webhook race or a
    // manually-reset row could leave a user in; this log must not re-fire
    // the paywall just because usage is still >= the limit.
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    await seedSubscription(user.id, 25);
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ confidence: 'high' });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/abc', currentState: 'idle' });

    expect(sendClient.send).toHaveBeenCalledTimes(1);
    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.freeAnalysesUsed).toBe(26);
  });

  // 11 breakdown §F step 17, stated exactly as written there: boundary
  // tests at exactly limit-1, limit, and limit+1 free analyses used —
  // the paywall fires only on the one log that crosses from under the
  // limit to at/over it, never on a log that starts already at or past it.
  it.each([
    [19, true, 20],
    [20, false, 21],
    [21, false, 22],
  ])(
    'starting at %i free analyses used, this log crosses the limit = %s',
    async (startingUsed, crosses, expectedUsedAfter) => {
      const phone = `+1${Date.now()}${startingUsed}25`;
      const user = await createUser(phone);
      await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
      await seedSubscription(user.id, startingUsed);
      const sendClient = fakeSendClient();
      const candidate = fakeCandidate({ confidence: 'high' });
      const handleInboundMessage = createInboundMessageHandler({
        sendClient,
        visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
        textParser: noTextParser(),
        createCheckoutLink: crosses ? fakeCreateCheckoutLink() : noCreateCheckoutLink(),
      });

      await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/abc', currentState: 'idle' });

      expect(sendClient.send).toHaveBeenCalledTimes(crosses ? 2 : 1);
      const subscription = await getSubscriptionStatus(user.id);
      expect(subscription?.freeAnalysesUsed).toBe(expectedUsedAfter);
      const current = await getUserByPhone(phone);
      expect(current?.conversationState).toBe(crosses ? 'awaiting_checkout' : 'idle');
    },
  );

  // 11 breakdown §F step 18: the meal_log insert and the free-tier increment
  // (both wrapped in one withTransaction call by writeMealLogAndComposeReply,
  // router.ts) must commit or roll back together. Calls the same two query
  // functions the router composes, directly, to control exactly where the
  // simulated failure lands — no subscription row exists for this user, so
  // incrementFreeAnalysesUsed's UPDATE matches zero rows and throws, strictly
  // after createMealLog has already run inside the same transaction.
  it('rolls back the meal_log insert too when the free-tier increment fails partway through the same transaction', async () => {
    const user = await createUser(`+1${Date.now()}26`);
    const candidate = fakeCandidate();

    await expect(
      withTransaction(async (client) => {
        await createMealLog(user.id, candidate, 'photo', '2026-08-28', client);
        await incrementFreeAnalysesUsed(client, user.id);
      }),
    ).rejects.toThrow();

    const logs = await getRecentMealLogsForUser(user.id, { sinceDate: '2020-01-01' });
    expect(logs).toHaveLength(0);
  });

  it('commits the meal_log insert and the free-tier increment together when neither fails', async () => {
    const user = await createUser(`+1${Date.now()}27`);
    await getOrCreateSubscriptionForUser(user.id);
    const candidate = fakeCandidate();

    await withTransaction(async (client) => {
      await createMealLog(user.id, candidate, 'photo', '2026-08-28', client);
      await incrementFreeAnalysesUsed(client, user.id);
    });

    const logs = await getRecentMealLogsForUser(user.id, { sinceDate: '2020-01-01' });
    expect(logs).toHaveLength(1);
    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.freeAnalysesUsed).toBe(1);
  });

  it('also fires from the awaiting_clarification completion path, not just the fast path', async () => {
    const phone = `+1${Date.now()}24`;
    const user = await createUser(phone);
    const candidate = fakeCandidate({ confidence: 'low' });
    await getPool().query(
      'UPDATE "user" SET conversation_state = $2, conversation_context = $3 WHERE id = $1',
      [user.id, 'awaiting_clarification', JSON.stringify({ pendingKind: 'meal_candidate', candidate })],
    );
    await seedSubscription(user.id, 19);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: fakeCreateCheckoutLink(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'it was 3 eggs',
      currentState: 'awaiting_clarification',
    });

    expect(sendClient.send).toHaveBeenCalledTimes(2);
    const [, paywallBody] = sendClient.send.mock.calls[1] as [string, string];
    expect(paywallBody).toContain('free logs');
    expect(paywallBody).toContain('https://checkout.stripe.com/c/fake');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('awaiting_checkout');
  });
});

// 12 §A: pause/resume. Logging still works while paused (step 2), and
// paused_at (not just conversation_state) is what actually suppresses the
// scheduler (getActiveUsersForScheduling, db-consumer) — step 3/4.
describe('createInboundMessageHandler — pause/resume (12 §A)', () => {
  it('"pause" from idle: sends the pause confirmation, moves to paused, and stamps paused_at', async () => {
    const phone = `+1${Date.now()}28`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, text: 'pause', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('paused');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('paused');
    expect(current?.pausedAt).not.toBeNull();
  });

  it('"resume" from paused: sends the resume confirmation, moves to idle, and clears paused_at', async () => {
    const phone = `+1${Date.now()}29`;
    const user = await createUser(phone);
    await getPool().query(
      'UPDATE "user" SET conversation_state = $2, paused_at = now() WHERE id = $1',
      [user.id, 'paused'],
    );
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, text: 'resume', currentState: 'paused' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('back on');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');
    expect(current?.pausedAt).toBeNull();
  });

  it('a meal photo while paused still logs, replies with macros, and leaves paused_at/state untouched', async () => {
    const phone = `+1${Date.now()}30`;
    const user = await createUser(phone);
    await getPool().query(
      'UPDATE "user" SET conversation_state = $2, paused_at = now() WHERE id = $1',
      [user.id, 'paused'],
    );
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate({ confidence: 'high' });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: fakeVisionProvider(vi.fn().mockResolvedValue(candidate)),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/paused-1', currentState: 'paused' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Logged: 210 cal');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('paused');
    expect(current?.pausedAt).not.toBeNull();

    const { rows } = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
  });

  it('a correction while paused writes the correction and stays paused', async () => {
    const phone = `+1${Date.now()}31`;
    const user = await createUser(phone);
    await getPool().query(
      'UPDATE "user" SET conversation_state = $2, paused_at = now() WHERE id = $1',
      [user.id, 'paused'],
    );
    const today = computeLocalDate(new Date(), user.timezone);
    await createMealLog(user.id, fakeCandidate({ calories: 300 }), 'photo', today);
    const sendClient = fakeSendClient();
    const replacement = fakeCandidate({ calories: 210 });
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: fakeTextParser(vi.fn().mockResolvedValue(replacement)),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'that was actually 2 eggs not 3',
      currentState: 'paused',
    });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Updated — that entry is now 210 cal');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('paused');
    expect(current?.pausedAt).not.toBeNull();
  });

  it('"pause" while already paused is a no-op fallback, not a re-confirmation', async () => {
    const phone = `+1${Date.now()}32`;
    const user = await createUser(phone);
    await getPool().query(
      'UPDATE "user" SET conversation_state = $2, paused_at = now() WHERE id = $1',
      [user.id, 'paused'],
    );
    const sendClient = fakeSendClient();
    const candidate = fakeCandidate();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: fakeTextParser(vi.fn().mockResolvedValue(candidate)),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    // classifyTrigger only checks pause language from 'idle' — from
    // 'paused' this is just another logging turn, same as any other text.
    await handleInboundMessage({ userId: user.id, text: 'pause', currentState: 'paused' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Logged:');
  });
});

// 12 §B: account deletion. Terminal — once 'deleted', no further trigger
// (including a second delete request) should change state or send a second
// confirmation (step 6's "confirmed once in writing, never re-prompted").
describe('createInboundMessageHandler — delete (12 §B)', () => {
  it('"delete my data" from idle: sends the one confirmation, moves to deleted, and stamps deleted_requested_at', async () => {
    const phone = `+1${Date.now()}33`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, text: 'delete my data', currentState: 'idle' });

    expect(sendClient.send).toHaveBeenCalledTimes(1);
    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('30 days');
    expect(body).not.toContain('?');

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('deleted');
    expect(current?.deletedRequestedAt).not.toBeNull();
  });

  it('works from mid-onboarding too — a delete request has to work "from any state" (04 §6.1)', async () => {
    const phone = `+1${Date.now()}34`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [
      user.id,
      'onboarding_q1',
    ]);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({
      userId: user.id,
      text: 'please delete my account',
      currentState: 'onboarding_q1',
    });

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('deleted');
  });

  it('a second delete request once already deleted is a no-op: no second confirmation, no re-stamped timestamp', async () => {
    const phone = `+1${Date.now()}35`;
    const user = await createUser(phone);
    await getPool().query(
      'UPDATE "user" SET conversation_state = $2, deleted_requested_at = now() WHERE id = $1',
      [user.id, 'deleted'],
    );
    const before = await getUserByPhone(phone);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, text: 'delete my data', currentState: 'deleted' });

    expect(sendClient.send).not.toHaveBeenCalled();
    const after = await getUserByPhone(phone);
    expect(after?.conversationState).toBe('deleted');
    expect(after?.deletedRequestedAt?.getTime()).toBe(before?.deletedRequestedAt?.getTime());
  });

  it('"delete that" while idle still corrects/deletes a meal log, not the whole account', async () => {
    const phone = `+1${Date.now()}36`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const today = computeLocalDate(new Date(), user.timezone);
    await createMealLog(user.id, fakeCandidate({ calories: 300 }), 'photo', today);
    const sendClient = fakeSendClient();
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: noVisionProvider(),
      textParser: noTextParser(),
      createCheckoutLink: noCreateCheckoutLink(),
    });

    await handleInboundMessage({ userId: user.id, text: 'delete that', currentState: 'idle' });

    const [, body] = sendClient.send.mock.calls[0] as [string, string];
    expect(body).toContain('Deleted. Total for that day is now 0 cal.');
    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');
    expect(current?.deletedRequestedAt).toBeNull();
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
      createCheckoutLink: noCreateCheckoutLink(),
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
