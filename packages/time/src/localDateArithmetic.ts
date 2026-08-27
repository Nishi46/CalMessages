// Pure calendar-day arithmetic on a 'yyyy-MM-dd' string — used for resolving
// day references like "yesterday" or "Monday" (09 §E step 21) once the
// local date itself has already been correctly pinned down by
// computeLocalDate. Deliberately built on Date.UTC/getUTC*, never the local
// system timezone — the same real-timezone-conversion problem
// computeLocalDate's own file comment describes would reappear here if a
// wall-clock/local Date method leaked in, since day + delta days could shift
// under a system clock behind UTC.
export function addDaysToLocalDate(localDate: string, deltaDays: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const yyyy = String(shifted.getUTCFullYear()).padStart(4, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 0 = Sunday ... 6 = Saturday, matching Date.prototype.getDay's convention.
export function weekdayOfLocalDate(localDate: string): number {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
