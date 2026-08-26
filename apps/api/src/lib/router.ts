import { createGoal, getUserById, updateUserState } from '@tally/db-consumer';
import {
  applySideEffects,
  captureGoalAnswer,
  captureReferralAnswer,
  captureStartingPointAnswer,
  classifyTrigger,
  computeDefaultGoal,
  resolveTransition,
  type ConversationState,
  type GoalType,
} from '@tally/conversation';
import { sendMessage, type TwilioSendClient } from '@tally/messaging';

export interface RouterHandoffPayload {
  userId: string;
  text?: string;
  photoKey?: string;
  currentState: string;
}

export interface RouterDeps {
  sendClient: TwilioSendClient;
}

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
// conversation state machine exists (07 §A-C). Scoped to the same slice
// those sections ship: new -> onboarding_q1/q2/q3 -> idle. Every other
// {state, trigger} pair still resolves to the safe fallback and is a no-op
// here, same as inside the state machine itself.
export function createInboundMessageHandler(deps: RouterDeps) {
  return async function handleInboundMessage(payload: RouterHandoffPayload): Promise<void> {
    const currentState = payload.currentState as ConversationState;
    const trigger = classifyTrigger({
      currentState,
      hasText: Boolean(payload.text),
      hasPhoto: Boolean(payload.photoKey),
    });
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
    });

    await updateUserState(payload.userId, transition.toState, mergedContext);
  };
}
