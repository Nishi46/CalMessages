// 09 breakdown §A step 4: wraps 04 §7.1's periodic evaluation-loop interval
// behind an injectable interval + callback, kept out of index.ts's env
// wiring so it stays a hardcoded-nowhere concern — §F's simulated-clock
// tests can call onTick directly instead of waiting on a real 15-minute
// timer.
export interface TickHandle {
  stop: () => void;
}

export function startPeriodicTick(intervalMs: number, onTick: () => void | Promise<void>): TickHandle {
  const timer = setInterval(() => {
    void onTick();
  }, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
