import { getRecentMessageDeliverability, type DeliverabilityResult } from '@tally/db-consumer';

// 13 breakdown §B step 4 (04 §12, Build Spec §7): "wired to alert as a P0
// incident mechanism, not dashboard-only." threshold is a fraction in [0,1],
// same units as DeliverabilityResult.failureRate.
export interface DeliverabilityAlertThresholds {
  failureRateThreshold: number;
}

export interface DeliverabilityAlertEvaluation {
  shouldAlert: boolean;
  failureRate: number | null;
  totalOutbound: number;
}

// Pure — no DB, no I/O — so the boundary condition (13 breakdown §B step 6)
// is testable against a synthetic distribution without a real Postgres.
// Strictly-greater-than: a rate sitting exactly at the configured threshold
// doesn't page anyone, only a rate that has actually crossed it. A null
// failureRate (no outbound messages at all in the window) never alerts —
// there's nothing to have failed.
export function evaluateDeliverabilityAlert(
  result: DeliverabilityResult,
  thresholds: DeliverabilityAlertThresholds,
): DeliverabilityAlertEvaluation {
  const shouldAlert = result.failureRate !== null && result.failureRate > thresholds.failureRateThreshold;
  return { shouldAlert, failureRate: result.failureRate, totalOutbound: result.totalOutbound };
}

// 13 breakdown §B step 5: "needs a decision the source docs don't make" —
// Slack/email/PagerDuty/etc. is unspecified anywhere in 01-07, and was
// decided (2026-08-30) as a structured stderr log line for P0: relies on
// whatever log aggregation/alerting already watches worker stderr, rather
// than adding a new external dependency and credential before one is
// actually chosen. Kept behind this interface (mirroring reconciliation.ts's
// injected SubscriptionStatusClient) specifically so swapping in a real
// webhook/PagerDuty notifier later — likely, once an actual on-call channel
// exists — is a one-file change, not a rewrite of the tick itself.
export interface DeliverabilityNotifier {
  notify(evaluation: DeliverabilityAlertEvaluation, result: DeliverabilityResult): void | Promise<void>;
}

export const consoleDeliverabilityNotifier: DeliverabilityNotifier = {
  notify(evaluation, result) {
    const ratePct = evaluation.failureRate !== null ? (evaluation.failureRate * 100).toFixed(1) : 'n/a';
    console.error(
      `[worker] [ALERT] message deliverability failure rate ${ratePct}% ` +
        `over ${evaluation.totalOutbound} outbound messages — byStatus: ${JSON.stringify(result.byStatus)}`,
    );
  },
};

// 13 breakdown §B step 4: the periodic check itself, reusing the same
// startPeriodicTick infrastructure as the scheduler/reconciliation/purge
// ticks (see index.ts). `now` and `notifier` are threaded through rather
// than read from Date.now()/hardcoded, same posture as runReconciliationTick
// — deterministic in tests, swappable in production.
export async function runDeliverabilityAlertTick(
  notifier: DeliverabilityNotifier,
  now: Date,
  windowMs: number,
  thresholds: DeliverabilityAlertThresholds,
): Promise<void> {
  const result = await getRecentMessageDeliverability(windowMs, now);
  const evaluation = evaluateDeliverabilityAlert(result, thresholds);
  if (evaluation.shouldAlert) {
    await notifier.notify(evaluation, result);
  }
}
