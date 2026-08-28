import { describe, expect, it, vi } from 'vitest';
import type { MealCandidate } from '@tally/shared-types';
import { applySideEffects, type SideEffectDeps } from './applySideEffects.js';
import type { SideEffect } from './sideEffect.js';

function fakeDeps(): SideEffectDeps & {
  sendReply: ReturnType<typeof vi.fn>;
  mergeContext: ReturnType<typeof vi.fn>;
  createGoal: ReturnType<typeof vi.fn>;
  writeMealLog: ReturnType<typeof vi.fn>;
  holdCandidate: ReturnType<typeof vi.fn>;
  writeCorrection: ReturnType<typeof vi.fn>;
  deleteMealLog: ReturnType<typeof vi.fn>;
  createCheckoutLink: ReturnType<typeof vi.fn>;
} {
  return {
    sendReply: vi.fn().mockResolvedValue(undefined),
    mergeContext: vi.fn().mockResolvedValue(undefined),
    createGoal: vi.fn().mockResolvedValue({ dailyCalories: 1650, dailyProtein: 120 }),
    writeMealLog: vi.fn().mockResolvedValue({
      calories: 400,
      protein: 30,
      carbs: 10,
      fat: 20,
      todayCalories: 1180,
      todayProtein: 90,
      todayCarbs: 60,
      todayFat: 40,
      goalCalories: 1650,
      itemBreakdown: '',
    }),
    holdCandidate: vi.fn().mockResolvedValue(undefined),
    writeCorrection: vi.fn().mockResolvedValue({
      calories: 450,
      protein: 35,
      carbs: 12,
      fat: 22,
      dayCalories: 1900,
      dayProtein: 150,
      dayCarbs: 80,
      dayFat: 60,
    }),
    deleteMealLog: vi.fn().mockResolvedValue({
      calories: 210,
      protein: 18,
      carbs: 2,
      fat: 15,
      dayCalories: 970,
      dayProtein: 72,
      dayCarbs: 58,
      dayFat: 45,
    }),
    createCheckoutLink: vi.fn().mockResolvedValue({ checkoutLink: 'https://checkout.stripe.com/c/fake' }),
  };
}

function fakeCandidate(): MealCandidate {
  return {
    items: [{ name: 'eggs', portion: '3', calories: 210, protein: 18, carbs: 2, fat: 15 }],
    calories: 210,
    protein: 18,
    carbs: 2,
    fat: 15,
    confidence: 'low',
    isFood: true,
  };
}

describe('applySideEffects (07 §C, breakdown steps 12-13)', () => {
  it('renders and sends a plain reply with no preceding effects', async () => {
    const deps = fakeDeps();
    const effects: SideEffect[] = [{ type: 'sendReply', template: 'onboarding_q3' }];

    await applySideEffects(effects, deps);

    expect(deps.sendReply).toHaveBeenCalledWith(
      'Last one — did a coach or clinic refer you? If not, just say no.',
    );
    expect(deps.createGoal).not.toHaveBeenCalled();
    expect(deps.mergeContext).not.toHaveBeenCalled();
  });

  it('threads a freshly created goal into a sendReply that follows it in the same list', async () => {
    const deps = fakeDeps();
    const effects: SideEffect[] = [
      { type: 'createGoal' },
      { type: 'sendReply', template: 'onboarding_goal_confirmation' },
    ];

    await applySideEffects(effects, deps);

    expect(deps.createGoal).toHaveBeenCalledTimes(1);
    expect(deps.sendReply).toHaveBeenCalledWith(
      'I\'ll set you at 1650 cal and 120g protein a day — easy to change anytime, just text "change my goal." Send me a photo of your next meal whenever you\'re ready.',
    );
  });

  it('calls mergeContext with the effect patch verbatim', async () => {
    const deps = fakeDeps();
    const effects: SideEffect[] = [{ type: 'mergeContext', patch: { goalType: 'lose' } }];

    await applySideEffects(effects, deps);

    expect(deps.mergeContext).toHaveBeenCalledWith({ goalType: 'lose' });
  });

  it('runs effects in order', async () => {
    const deps = fakeDeps();
    const calls: string[] = [];
    deps.mergeContext.mockImplementation(async () => {
      calls.push('mergeContext');
    });
    deps.createGoal.mockImplementation(async () => {
      calls.push('createGoal');
      return { dailyCalories: 1650, dailyProtein: 120 };
    });
    deps.sendReply.mockImplementation(async () => {
      calls.push('sendReply');
    });

    await applySideEffects(
      [
        { type: 'mergeContext', patch: {} },
        { type: 'createGoal' },
        { type: 'sendReply', template: 'onboarding_goal_confirmation' },
      ],
      deps,
    );

    expect(calls).toEqual(['mergeContext', 'createGoal', 'sendReply']);
  });
});

describe('applySideEffects — Sprint 4 meal-log side effects (09 §C, breakdown step 10)', () => {
  it('threads writeMealLog totals into a following sendReply', async () => {
    const deps = fakeDeps();

    await applySideEffects(
      [{ type: 'writeMealLog' }, { type: 'sendReply', template: 'meal_logged' }],
      deps,
    );

    expect(deps.writeMealLog).toHaveBeenCalledTimes(1);
    expect(deps.sendReply).toHaveBeenCalledWith(
      'Logged: 400 cal, 30g protein, 10g carbs, 20g fat.\n\nToday: 1180/1650 cal so far.',
    );
  });

  it('calls holdCandidate with the effect candidate verbatim', async () => {
    const deps = fakeDeps();
    const candidate = fakeCandidate();

    await applySideEffects([{ type: 'holdCandidate', candidate }], deps);

    expect(deps.holdCandidate).toHaveBeenCalledWith(candidate);
  });

  it('threads writeCorrection totals into a following sendReply', async () => {
    const deps = fakeDeps();

    await applySideEffects(
      [
        { type: 'writeCorrection', targetLogId: 'log-1' },
        { type: 'sendReply', template: 'correction_confirmed' },
      ],
      deps,
    );

    expect(deps.writeCorrection).toHaveBeenCalledWith('log-1');
    expect(deps.sendReply).toHaveBeenCalledWith(
      'Updated — that entry is now 450 cal, 35g protein, 12g carbs, 22g fat. Total for that day is now 1900 cal.',
    );
  });

  it('threads deleteMealLog totals into a following sendReply', async () => {
    const deps = fakeDeps();

    await applySideEffects(
      [
        { type: 'deleteMealLog', targetLogId: 'log-1' },
        { type: 'sendReply', template: 'delete_confirmed' },
      ],
      deps,
    );

    expect(deps.deleteMealLog).toHaveBeenCalledWith('log-1');
    expect(deps.sendReply).toHaveBeenCalledWith('Deleted. Total for that day is now 970 cal.');
  });

  it.each([
    ['writeMealLog', [{ type: 'writeMealLog' }]],
    ['holdCandidate', [{ type: 'holdCandidate', candidate: fakeCandidate() }]],
    ['writeCorrection', [{ type: 'writeCorrection', targetLogId: 'log-1' }]],
    ['deleteMealLog', [{ type: 'deleteMealLog', targetLogId: 'log-1' }]],
    ['createCheckoutLink', [{ type: 'createCheckoutLink' }]],
  ] satisfies Array<[string, SideEffect[]]>)(
    'throws a clear error when %s fires without its dep, instead of silently dropping the write',
    async (depName, effects) => {
      const deps = fakeDeps();
      delete (deps as Partial<SideEffectDeps>)[depName as keyof SideEffectDeps];

      await expect(applySideEffects(effects, deps)).rejects.toThrow(depName);
    },
  );
});

describe('applySideEffects — Sprint 6 §C checkout side effects (11 breakdown step 11)', () => {
  it('threads a freshly created checkout link into a sendReply that follows it', async () => {
    const deps = fakeDeps();

    await applySideEffects(
      [{ type: 'createCheckoutLink' }, { type: 'sendReply', template: 'paywall' }],
      deps,
    );

    expect(deps.createCheckoutLink).toHaveBeenCalledTimes(1);
    expect(deps.sendReply).toHaveBeenCalledWith(
      "You've used all your free logs. $9.99/mo keeps it going, no app required: https://checkout.stripe.com/c/fake",
    );
  });
});
