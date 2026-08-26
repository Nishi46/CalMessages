export interface RouterHandoffPayload {
  userId: string;
  text?: string;
  photoKey?: string;
  currentState: string;
}

// Real routing logic (04 §6) lands with the conversation state machine in Sprint 2.
// This just wires the seam so the webhook handler has somewhere to hand off to.
export async function handleInboundMessage(payload: RouterHandoffPayload): Promise<void> {
  void payload;
}
