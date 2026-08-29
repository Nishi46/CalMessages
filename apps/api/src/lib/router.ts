import {
  createCorrection,
  createGoal,
  createMealLog,
  getCurrentGoal,
  getDailyTotals,
  getOrCreateSubscriptionForUser,
  getUserById,
  incrementFreeAnalysesUsed,
  softDeleteMealLog,
  updateUserState,
  withTransaction,
  type MealLog,
  type MealSource,
  type User,
} from '@tally/db-consumer';
import {
  applySideEffects,
  captureGoalAnswer,
  captureReferralAnswer,
  captureStartingPointAnswer,
  classifyTrigger,
  computeDefaultGoal,
  isDeleteText,
  renderTemplate,
  resolveCorrectionTransition,
  resolveMealContentTransition,
  resolveTransition,
  type ConversationState,
  type CorrectionIntent,
  type CorrectionWriteResult,
  type GoalType,
  type MealLogWriteResult,
  type PendingContext,
} from '@tally/conversation';
import { sendMessage, type TwilioSendClient } from '@tally/messaging';
import { computeLocalDate } from '@tally/time';
import type { MealCandidate, MealCandidateItem } from '@tally/shared-types';
import type { TextParser, VisionProvider } from '@tally/vision';
import { resolveCorrectionTarget } from './resolveCorrectionTarget.js';

export interface RouterHandoffPayload {
  userId: string;
  text?: string;
  photoKey?: string;
  currentState: string;
}

export interface RouterDeps {
  sendClient: TwilioSendClient;
  visionProvider: VisionProvider;
  textParser: TextParser;
  // 11 breakdown §C step 10: a fully-built function rather than a raw
  // @tally/billing client, so the router stays decoupled from Stripe
  // specifics (session shape, price id) the same way it never touches the
  // Twilio SDK directly either — apps/api/src/index.ts closes over those.
  createCheckoutLink: (userId: string) => Promise<string>;
  // The meal_content path can hold this handler's own async work open past
  // its return (09 §D step 20's holding-reply fallback) — a rejection
  // there would otherwise vanish silently. Defaults to console.error.
  onAsyncError?: (error: unknown) => void;
  // Overrides MEAL_CONTENT_TIMEOUT_MS — exists so tests can exercise the
  // holding-reply fallback without a real 8s wait.
  mealContentTimeoutMs?: number;
}

// Architecture §7: "Vision model API down or slow... fall back to holding
// reply + async completion." 8s comfortably covers a normal multi-second
// call while still catching a genuinely stuck one.
const MEAL_CONTENT_TIMEOUT_MS = 8000;

// Which onboarding question the current state is waiting an answer for (07
// §B). Every other state ignores the message body here — it either isn't an
// onboarding answer, or (for 'new') the message itself carries no answer to
// capture, just the fact that it arrived.
function captureAnswerForState(
  currentState: ConversationState,
  text: string | undefined,
): Record<string, unknown> {
  if (text === undefined) {
    return {};
  }
  switch (currentState) {
    case 'onboarding_q1':
      return { ...captureGoalAnswer(text) };
    case 'onboarding_q2':
      return { ...captureStartingPointAnswer(text) };
    case 'onboarding_q3':
      return { ...captureReferralAnswer(text) };
    default:
      return {};
  }
}

// Real routing logic (04 §6), replacing the Sprint 1 no-op seam now that the
// conversation state machine exists (07 §A-C, 09 §C). Scoped to
// new -> onboarding_q1/q2/q3 -> idle plus Sprint 4's meal-logging fast path
// (09 §D) and correction/delete resolution (09 §E). Every other
// {state, trigger} pair still resolves to the safe fallback and is a no-op
// here, same as inside the state machine itself.
export function createInboundMessageHandler(deps: RouterDeps) {
  const onAsyncError =
    deps.onAsyncError ??
    ((error: unknown) => {
      console.error('handleInboundMessage: async meal-content completion failed', error);
    });
  const mealContentTimeoutMs = deps.mealContentTimeoutMs ?? MEAL_CONTENT_TIMEOUT_MS;

  return async function handleInboundMessage(payload: RouterHandoffPayload): Promise<void> {
    const currentState = payload.currentState as ConversationState;
    const trigger = classifyTrigger({
      currentState,
      hasText: Boolean(payload.text),
      hasPhoto: Boolean(payload.photoKey),
      text: payload.text,
    });

    // meal_content needs a resolved MealCandidate before a transition can
    // even be picked (09 §C step 11) — it never goes through the plain
    // {state, trigger} lookup table, so it's handled entirely separately.
    if (trigger === 'meal_content') {
      await handleMealContent(payload, deps, onAsyncError, mealContentTimeoutMs);
      return;
    }

    // correction also needs runtime data (how many plausible target logs
    // resolveCorrectionTarget finds) before a transition can be picked
    // (09 §E) — same reason meal_content bypasses the plain lookup table.
    if (trigger === 'correction') {
      await handleCorrection(payload, deps);
      return;
    }

    const transition = resolveTransition(currentState, trigger);

    if (transition.isFallback) {
      return;
    }

    const user = await getUserById(payload.userId);
    if (!user) {
      return;
    }

    const existingContext = (user.conversationContext as Record<string, unknown> | null) ?? {};
    const mergedContext: Record<string, unknown> = {
      ...existingContext,
      ...captureAnswerForState(currentState, payload.text),
    };
    let crossedFreeTierLimit = false;

    await applySideEffects(transition.sideEffects, {
      sendReply: async (text) => {
        await sendMessage(deps.sendClient, payload.userId, text, 'system');
      },
      mergeContext: async (patch) => {
        Object.assign(mergedContext, patch);
      },
      createGoal: async () => {
        const goalType = (mergedContext.goalType as GoalType | undefined) ?? 'maintain';
        const rawStartingPoint = (mergedContext.rawStartingPoint as string | undefined) ?? '';
        const computed = computeDefaultGoal(goalType, rawStartingPoint);
        await createGoal(payload.userId, { type: goalType, ...computed });
        return computed;
      },
      // Only reachable via awaiting_clarification:clarification_answer —
      // completes the log from the candidate a prior low-confidence
      // meal_content turn held (09 §C step 12). Merging the clarifying
      // answer's text into the held candidate isn't specified anywhere in
      // the breakdown yet, so this logs the held candidate as-is.
      writeMealLog: async () => {
        const pending = existingContext as Partial<PendingContext>;
        if (pending.pendingKind !== 'meal_candidate' || !pending.candidate) {
          throw new Error(
            'writeMealLog fired in awaiting_clarification without a held meal_candidate',
          );
        }
        const outcome = await writeMealLogAndComposeReply(user, pending.candidate, 'text');
        crossedFreeTierLimit = outcome.crossedFreeTierLimit;
        return outcome.result;
      },
    });

    // 11 breakdown §B step 9: the paywall transition supersedes the normal
    // 'idle' write below rather than following it — one state transition per
    // message, same as every other branch in this handler.
    if (crossedFreeTierLimit) {
      await triggerPaywall(payload.userId, deps);
    } else {
      // 12 §A step 4: paused_at rides along with this same UPDATE only for
      // the two transitions that actually change it — every other trigger
      // passes undefined, leaving the column untouched.
      const pausedAt = trigger === 'pause' ? new Date() : trigger === 'resume' ? null : undefined;
      await updateUserState(payload.userId, transition.toState, mergedContext, undefined, pausedAt);
    }
  };
}

// crossedFreeTierLimit is surfaced alongside the render vars rather than
// folded into MealLogWriteResult — it drives a whole second transition (the
// paywall, 11 breakdown §B), not a template placeholder, so it stays out of
// the vars applySideEffects threads into the *next* sendReply.
interface MealLogWriteOutcome {
  result: MealLogWriteResult;
  crossedFreeTierLimit: boolean;
}

async function writeMealLogAndComposeReply(
  user: User,
  candidate: MealCandidate,
  source: MealSource,
): Promise<MealLogWriteOutcome> {
  const localDate = computeLocalDate(new Date(), user.timezone);
  // 11 breakdown §A step 4: the meal_log insert and the free-tier increment
  // have to commit or roll back together (04 §8.1) — getOrCreateSubscriptionForUser
  // runs first, outside the transaction, since only the increment itself
  // needs atomicity with the log write, not the row's insert-on-first-use.
  await getOrCreateSubscriptionForUser(user.id);
  const subscription = await withTransaction(async (client) => {
    await createMealLog(user.id, candidate, source, localDate, client);
    return incrementFreeAnalysesUsed(client, user.id);
  });
  // 11 breakdown §B step 7: increments always step by exactly 1, so the
  // crossing point (previous value under the limit, new value at/over it) is
  // hit on exactly one log — the one that brings free_analyses_used to
  // exactly free_analyses_limit. Every log before that is under it, every
  // log after is already over it, so equality alone is the crossing check.
  const crossedFreeTierLimit = subscription.freeAnalysesUsed === subscription.freeAnalysesLimit;

  const [totals, goal] = await Promise.all([
    getDailyTotals(user.id, localDate),
    getCurrentGoal(user.id),
  ]);

  return {
    result: {
      calories: candidate.calories,
      protein: candidate.protein,
      carbs: candidate.carbs,
      fat: candidate.fat,
      todayCalories: totals.calories,
      todayProtein: totals.protein,
      todayCarbs: totals.carbs,
      todayFat: totals.fat,
      goalCalories: goal?.dailyCalories ?? '—',
      itemBreakdown: composeItemBreakdown(candidate.items),
    },
    crossedFreeTierLimit,
  };
}

// 11 breakdown §B step 9: the recommended synthetic-trigger route — routes
// through the same resolveTransition/applySideEffects/updateUserState path
// as every other transition, rather than setting conversation_state
// directly from billing code (04 §6.1's one-mechanism goal). Always resolved
// from 'idle', since both meal-log write paths land in 'idle' first.
async function triggerPaywall(userId: string, deps: RouterDeps): Promise<void> {
  const transition = resolveTransition('idle', 'limit_crossed');
  await applySideEffects(transition.sideEffects, {
    sendReply: async (text) => {
      // 11 breakdown §B step 8: Build Spec §4.6 step 1 — this fires only
      // after the caller's own log-reply sendMessage() has already resolved,
      // so the log that crossed the threshold is still delivered in full
      // before the paywall message follows it.
      await sendMessage(deps.sendClient, userId, text, 'paywall');
    },
    mergeContext: async () => {
      throw new Error('mergeContext should not fire on the limit_crossed path');
    },
    createGoal: async () => {
      throw new Error('createGoal should not fire on the limit_crossed path');
    },
    // 11 breakdown §C step 11: idle:limit_crossed's own sideEffects put
    // createCheckoutLink ahead of sendReply, so this result is already
    // available to render {checkoutLink} into the paywall template by the
    // time sendReply above fires.
    createCheckoutLink: async () => ({ checkoutLink: await deps.createCheckoutLink(userId) }),
  });
  await updateUserState(userId, transition.toState);
}

// Build Spec §4.2: "break the reply out by item... so a later correction
// can target one item" — only once there's more than one item to
// disambiguate between.
function composeItemBreakdown(items: MealCandidateItem[]): string {
  if (items.length <= 1) {
    return '';
  }
  return '\n' + items.map((item) => `- ${item.name} (${item.portion}): ${item.calories} cal`).join('\n');
}

type CandidateOutcome =
  | { kind: 'fast'; candidate: MealCandidate }
  | { kind: 'slow'; pending: Promise<MealCandidate> };

// Races the SAME in-flight call against a timer, rather than issuing a
// second one — a slow call keeps running, and its eventual settlement is
// left for the caller to handle via `pending`. A fast rejection is folded
// into the same 'slow' outcome as a timeout, since 09 §D step 20 treats
// "timed out" and "provider error" as triggering the identical fallback.
function resolveWithTimeout(
  pending: Promise<MealCandidate>,
  timeoutMs: number,
): Promise<CandidateOutcome> {
  type RaceResult = { settled: true; candidate: MealCandidate } | { settled: false };

  const settledOrTimedOut = Promise.race<RaceResult>([
    pending.then(
      (candidate) => ({ settled: true, candidate }),
      () => ({ settled: false }),
    ),
    delay(timeoutMs).then(() => ({ settled: false })),
  ]);

  return settledOrTimedOut.then((result) =>
    result.settled ? { kind: 'fast', candidate: result.candidate } : { kind: 'slow', pending },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleMealContent(
  payload: RouterHandoffPayload,
  deps: RouterDeps,
  onAsyncError: (error: unknown) => void,
  timeoutMs: number,
): Promise<void> {
  const user = await getUserById(payload.userId);
  if (!user) {
    return;
  }

  // Photo takes precedence when both are present (09 §D step 15).
  const source: MealSource = payload.photoKey ? 'photo' : 'text';
  const fetchCandidate = (): Promise<MealCandidate> =>
    payload.photoKey
      ? deps.visionProvider.recognize(payload.photoKey)
      : deps.textParser.parse(payload.text ?? '');

  const outcome = await resolveWithTimeout(fetchCandidate(), timeoutMs);

  if (outcome.kind === 'slow') {
    const holdingTemplate = source === 'photo' ? 'meal_holding_reply_photo' : 'meal_holding_reply_text';
    await sendMessage(deps.sendClient, payload.userId, renderTemplate(holdingTemplate), 'log_reply');
    void outcome.pending
      .then((candidate) => finishMealContent(payload, user, candidate, source, deps))
      .catch(onAsyncError);
    return;
  }

  await finishMealContent(payload, user, outcome.candidate, source, deps);
}

async function finishMealContent(
  payload: RouterHandoffPayload,
  user: User,
  candidate: MealCandidate,
  source: MealSource,
  deps: RouterDeps,
): Promise<void> {
  if (!candidate.isFood) {
    // Terminal, its own path — never reaches the confidence scorer, so
    // it's distinct from the confidence-gated branch below (09 §D step 16).
    const template = candidate.rejectionReason === 'unassessable' ? 'meal_unassessable' : 'meal_non_food';
    await sendMessage(deps.sendClient, payload.userId, renderTemplate(template), 'log_reply');
    return;
  }

  // 12 §A step 2: a paused user's meal-logging turn has to land back in
  // 'paused', not 'idle' — meal_content only ever classifies from those two
  // states (classifyTrigger.ts), so this is exhaustive.
  const fromState: ConversationState = payload.currentState === 'paused' ? 'paused' : 'idle';
  const transition = resolveMealContentTransition(candidate, fromState);
  let heldContext: PendingContext | undefined;
  let crossedFreeTierLimit = false;

  await applySideEffects(transition.sideEffects, {
    sendReply: async (text) => {
      await sendMessage(deps.sendClient, payload.userId, text, 'log_reply');
    },
    mergeContext: async () => {
      throw new Error('mergeContext should not fire on the meal_content path');
    },
    createGoal: async () => {
      throw new Error('createGoal should not fire on the meal_content path');
    },
    writeMealLog: async () => {
      const outcome = await writeMealLogAndComposeReply(user, candidate, source);
      crossedFreeTierLimit = outcome.crossedFreeTierLimit;
      return outcome.result;
    },
    holdCandidate: async (heldCandidate) => {
      heldContext = { pendingKind: 'meal_candidate', candidate: heldCandidate };
    },
  });

  if (heldContext) {
    await updateUserState(user.id, transition.toState, heldContext);
  } else if (crossedFreeTierLimit) {
    // 11 breakdown §B step 9: high/medium confidence normally leaves
    // conversation_state untouched here (toState is 'idle', same as it
    // already was) — crossing the limit is the one case on this path that
    // does need a write, into 'awaiting_checkout'.
    await triggerPaywall(user.id, deps);
  }
  // Otherwise: toState is 'idle' (unchanged), and the meal is already
  // durably written by writeMealLog — no state/context update needed.
}

async function handleCorrection(payload: RouterHandoffPayload, deps: RouterDeps): Promise<void> {
  const user = await getUserById(payload.userId);
  if (!user) {
    return;
  }

  const text = payload.text ?? '';
  const resolution = await resolveCorrectionTarget(user.id, text, user.timezone);

  if (resolution.kind === 'none') {
    // Terminal, its own path — nothing to disambiguate or write, and
    // replying (rather than silently no-op'ing) is the explicit instruction
    // (09 §E step 22).
    await sendMessage(deps.sendClient, payload.userId, renderTemplate('correction_not_found'), 'log_reply');
    return;
  }

  // Checked before falling through to a value-replacement correction
  // (09 §E step 23) — "delete that" carries no replacement value to parse.
  const intent: CorrectionIntent = isDeleteText(text) ? 'delete' : 'correct';
  // 12 §A step 2: same paused/idle round-trip as finishMealContent above.
  const fromState: ConversationState = payload.currentState === 'paused' ? 'paused' : 'idle';
  const transition = resolveCorrectionTransition(resolution, intent, fromState);
  let heldContextPatch: Record<string, unknown> | undefined;

  await applySideEffects(transition.sideEffects, {
    sendReply: async (replyText) => {
      await sendMessage(deps.sendClient, payload.userId, replyText, 'log_reply');
    },
    mergeContext: async (patch) => {
      heldContextPatch = patch;
    },
    createGoal: async () => {
      throw new Error('createGoal should not fire on the correction path');
    },
    // The replacement value for a text correction ("that was actually 2
    // eggs not 3") is itself just a meal description — reuses the same
    // TextParser pipeline meal_content's text branch uses, rather than a
    // second parsing scheme.
    writeCorrection: async (targetLogId) => {
      const replacement = await deps.textParser.parse(text);
      const corrected = await createCorrection(targetLogId, user.id, replacement);
      if (!corrected) {
        throw new Error(`writeCorrection: no meal_log row ${targetLogId} for user ${user.id}`);
      }
      return correctionWriteResult(corrected);
    },
    deleteMealLog: async (targetLogId) => {
      const deleted = await softDeleteMealLog(targetLogId);
      if (!deleted) {
        throw new Error(`deleteMealLog: no meal_log row ${targetLogId} for user ${user.id}`);
      }
      return correctionWriteResult(deleted);
    },
  });

  if (heldContextPatch) {
    await updateUserState(user.id, transition.toState, heldContextPatch);
  }
  // Single match: toState is 'idle' (unchanged), and the write already
  // happened via writeCorrection/deleteMealLog — no state/context update
  // needed.
}

// The reply states the total for the corrected/deleted entry's own date,
// not today's — they only differ when the correction referenced a prior
// day (09 §E step 24). `log.localDate` is exactly that date: createCorrection
// copies it from the original row, and a delete doesn't move it.
async function correctionWriteResult(log: MealLog): Promise<CorrectionWriteResult> {
  const dayTotals = await getDailyTotals(log.userId, log.localDate);
  return {
    calories: log.calories ?? 0,
    protein: log.protein ?? 0,
    carbs: log.carbs ?? 0,
    fat: log.fat ?? 0,
    dayCalories: dayTotals.calories,
    dayProtein: dayTotals.protein,
    dayCarbs: dayTotals.carbs,
    dayFat: dayTotals.fat,
  };
}
