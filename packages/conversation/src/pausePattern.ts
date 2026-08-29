// Keyword match for the app-level pause/resume trigger (12 §A step 1, Build
// Spec §4.7) — deliberately distinct from Twilio's carrier-level STOP/START
// handling (12 §C step 9), which never reaches this classifier as inbound
// text at all. "pause"/"stop nudges" only suspend proactive nudges; a plain
// "stop" alone (the carrier keyword) is left unmatched here so it can't be
// confused with the carrier-level opt-out.
const PAUSE_PATTERNS: RegExp[] = [/\bpause\b/i, /\bstop nudges\b/i];

const RESUME_PATTERNS: RegExp[] = [/\bresume\b/i];

export function isPauseText(text: string): boolean {
  return PAUSE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isResumeText(text: string): boolean {
  return RESUME_PATTERNS.some((pattern) => pattern.test(text));
}
