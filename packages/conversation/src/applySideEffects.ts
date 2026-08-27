import type { MealCandidate } from '@tally/shared-types';
import type { SideEffect } from './sideEffect.js';
import { renderTemplate } from './templates.js';

export interface MacroTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface SideEffectDeps {
  sendReply: (text: string) => Promise<void>;
  mergeContext: (patch: Record<string, unknown>) => Promise<void>;
  createGoal: () => Promise<{ dailyCalories: number; dailyProtein: number }>;
  // Optional: unlike createGoal, no currently-wired transition in the flat
  // TRANSITIONS table reaches these outside of Sprint 4's router wiring (09
  // §D — not yet built), so a caller like today's apps/api router isn't
  // forced to supply them until it actually needs to. applySideEffects
  // throws a clear error below if one of these effects fires without its
  // dep, rather than silently dropping a meal-log write.
  writeMealLog?: () => Promise<MacroTotals>;
  holdCandidate?: (candidate: MealCandidate) => Promise<void>;
  writeCorrection?: (targetLogId: string) => Promise<MacroTotals>;
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
      case 'writeMealLog': {
        if (!deps.writeMealLog) {
          throw new Error('applySideEffects: writeMealLog effect fired without deps.writeMealLog');
        }
        const totals = await deps.writeMealLog();
        runtimeVars = { ...runtimeVars, ...totals };
        break;
      }
      case 'holdCandidate': {
        if (!deps.holdCandidate) {
          throw new Error('applySideEffects: holdCandidate effect fired without deps.holdCandidate');
        }
        await deps.holdCandidate(effect.candidate);
        break;
      }
      case 'writeCorrection': {
        if (!deps.writeCorrection) {
          throw new Error('applySideEffects: writeCorrection effect fired without deps.writeCorrection');
        }
        const totals = await deps.writeCorrection(effect.targetLogId);
        runtimeVars = { ...runtimeVars, ...totals };
        break;
      }
    }
  }
}
