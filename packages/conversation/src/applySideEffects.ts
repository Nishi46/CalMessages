import type { MealCandidate } from '@tally/shared-types';
import type { SideEffect } from './sideEffect.js';
import { renderTemplate } from './templates.js';

export interface MacroTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

// Everything the meal_logged template (09 §D step 17) interpolates: the
// just-logged macros, the day's running totals, the goal denominator for
// the "Today: X/Y cal" line (Build Spec §4.2), and a pre-composed per-item
// breakdown ('' when there's only one item) — built by the caller since the
// flat {placeholder} template system can't loop over a variable-length list
// itself.
export interface MealLogWriteResult extends MacroTotals {
  todayCalories: number;
  todayProtein: number;
  todayCarbs: number;
  todayFat: number;
  goalCalories: number | string;
  itemBreakdown: string;
}

// What correction_confirmed / delete_confirmed interpolate: the affected
// entry's own macros, plus the running total for *that entry's own date*
// rather than today's (09 §E step 24 — they only differ when the
// correction/delete referenced a prior day).
export interface CorrectionWriteResult extends MacroTotals {
  dayCalories: number;
  dayProtein: number;
  dayCarbs: number;
  dayFat: number;
}

export interface SideEffectDeps {
  sendReply: (text: string) => Promise<void>;
  mergeContext: (patch: Record<string, unknown>) => Promise<void>;
  createGoal: () => Promise<{ dailyCalories: number; dailyProtein: number }>;
  // Optional: unlike createGoal, no currently-wired transition in the flat
  // TRANSITIONS table reaches these outside of Sprint 4's router wiring (09
  // §D/§E), so a caller isn't forced to supply them until it actually needs
  // to. applySideEffects throws a clear error below if one of these effects
  // fires without its dep, rather than silently dropping a meal-log write.
  writeMealLog?: () => Promise<MealLogWriteResult>;
  holdCandidate?: (candidate: MealCandidate) => Promise<void>;
  writeCorrection?: (targetLogId: string) => Promise<CorrectionWriteResult>;
  deleteMealLog?: (targetLogId: string) => Promise<CorrectionWriteResult>;
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
      case 'deleteMealLog': {
        if (!deps.deleteMealLog) {
          throw new Error('applySideEffects: deleteMealLog effect fired without deps.deleteMealLog');
        }
        const totals = await deps.deleteMealLog(effect.targetLogId);
        runtimeVars = { ...runtimeVars, ...totals };
        break;
      }
    }
  }
}
