export type MessageDirection = 'inbound' | 'outbound';

// 04 §3.1 message_event.type — the column itself is unconstrained TEXT, but every
// write this codebase makes uses one of these.
export type MessageType = 'nudge' | 'recap' | 'paywall' | 'system' | 'log_reply';
