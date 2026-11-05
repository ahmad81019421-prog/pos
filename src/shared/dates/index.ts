/**
 * Date ranges for reports (local time). Shared by the dashboard (main) and the
 * Reports page (renderer) so both always agree (PRD 40, 41).
 *
 * All values are unix seconds; `to` is the LAST second of the range (inclusive).
 * Local midnight is computed with the Date API so DST changes are handled by the OS.
 */

import type { DateRange } from '@shared/types/index';

export type RangeKey = 'today' | 'yesterday' | 'week' | 'month';

const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 0);
}

export function getRange(key: RangeKey, now: Date = new Date()): DateRange {
  switch (key) {
    case 'today':
      return { from: sec(startOfDay(now)), to: sec(endOfDay(now)) };
    case 'yesterday': {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return { from: sec(startOfDay(y)), to: sec(endOfDay(y)) };
    }
    case 'week': {
      // Monday is the first day of the week.
      const day = now.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
      const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
      return { from: sec(startOfDay(monday)), to: sec(endOfDay(sunday)) };
    }
    case 'month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: sec(startOfDay(first)), to: sec(endOfDay(last)) };
    }
  }
}

/** Custom range from two yyyy-mm-dd strings (inclusive of both days). */
export function getCustomRange(fromIso: string, toIso: string): DateRange | null {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(fromIso);
  const b = re.exec(toIso);
  if (!a || !b) return null;
  const from = new Date(+a[1], +a[2] - 1, +a[3]);
  const to = new Date(+b[1], +b[2] - 1, +b[3]);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  return { from: sec(startOfDay(from)), to: sec(endOfDay(to)) };
}
