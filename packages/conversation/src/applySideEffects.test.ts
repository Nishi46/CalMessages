import { describe, expect, it, vi } from 'vitest';
import { applySideEffects, type SideEffectDeps } from './applySideEffects.js';
import type { SideEffect } from './sideEffect.js';

function fakeDeps(): SideEffectDeps & {
  sendReply: ReturnType<typeof vi.fn>;
  mergeContext: ReturnType<typeof vi.fn>;
  createGoal: ReturnType<typeof vi.fn>;
} {
  return {
    sendReply: vi.fn().mockResolvedValue(undefined),
    mergeContext: vi.fn().mockResolvedValue(undefined),
    createGoal: vi.fn().mockResolvedValue({ dailyCalories: 1650, dailyProtein: 120 }),
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
