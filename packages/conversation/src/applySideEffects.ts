import type { SideEffect } from './sideEffect.js';
import { renderTemplate } from './templates.js';

export interface SideEffectDeps {
  sendReply: (text: string) => Promise<void>;
  mergeContext: (patch: Record<string, unknown>) => Promise<void>;
  createGoal: () => Promise<{ dailyCalories: number; dailyProtein: number }>;
}

// Executes a transition's side effects in order against injected deps, so
// this is testable against fakes without touching Twilio or Postgres (07
// §C). deps is supplied by the caller (07 §D's router wiring), which is
// where the current user/context this invocation is for gets closed over.
//
// createGoal's result feeds into any sendReply that follows it in the same
// effect list — that's how the onboarding_q3 -> idle transition's
// confirmation message interpolates the goal numbers it just created (07 §C
// step 13), without the static lookup table needing to know them ahead of
// time.
export async function applySideEffects(effects: SideEffect[], deps: SideEffectDeps): Promise<void> {
  let runtimeVars: Record<string, string | number> = {};

  for (const effect of effects) {
    switch (effect.type) {
      case 'mergeContext':
        await deps.mergeContext(effect.patch);
        break;
      case 'createGoal': {
        const goal = await deps.createGoal();
        runtimeVars = { ...runtimeVars, ...goal };
        break;
      }
      case 'sendReply': {
        const vars = { ...runtimeVars, ...effect.vars };
        await deps.sendReply(renderTemplate(effect.template, vars));
        break;
      }
    }
  }
}
