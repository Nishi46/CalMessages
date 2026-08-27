export type { ConversationState } from './state.js';
export type { Trigger } from './trigger.js';
export type { SideEffect } from './sideEffect.js';
export type { Transition, CorrectionMatch } from './transitions.js';
export {
  resolveTransition,
  resolveMealContentTransition,
  resolveCorrectionTransition,
} from './transitions.js';
export type { InboundSignal } from './classifyTrigger.js';
export { classifyTrigger } from './classifyTrigger.js';
export { isCorrectionText } from './correctionPattern.js';
export type { PendingContext } from './pendingContext.js';
export type { GoalType, GoalAnswer, StartingPointAnswer, ReferralAnswer } from './onboardingAnswers.js';
export {
  captureGoalAnswer,
  captureStartingPointAnswer,
  captureReferralAnswer,
} from './onboardingAnswers.js';
export type { TemplateId } from './templates.js';
export { TEMPLATES, renderTemplate } from './templates.js';
export type { ComputedGoal } from './computeDefaultGoal.js';
export { computeDefaultGoal } from './computeDefaultGoal.js';
export type { SideEffectDeps, MacroTotals } from './applySideEffects.js';
export { applySideEffects } from './applySideEffects.js';
