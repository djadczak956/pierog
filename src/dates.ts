import type { Repeat } from "./schemas.ts";

const DAY_MS = 86_400_000;

// "Today" in the process time zone (the system's, or `timezone` from ~/.pierog/config.json).
export const localDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// Dates are handled as whole days since the epoch so no time zone or DST shift can move them.
const toDays = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS;
const toIso = (days: number) => new Date(days * DAY_MS).toISOString().slice(0, 10);
const weekday = (days: number) => (days + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
const weekOf = (days: number) => Math.floor((days + 4) / 7); // weeks start on Sunday

// The first occurrence after `from` that isn't before `today`, so finishing an overdue task schedules the next upcoming one.
export function nextDueDate(rule: Repeat, from: string, today: string): string {
  const start = toDays(from);
  const min = toDays(today);

  if (rule.freq === "month") {
    const [y, m, d] = from.split("-").map(Number);
    // Count months from the original date so Jan 31 -> Feb 28 -> Mar 31 instead of drifting to the 28th.
    for (let k = 1; ; k++) {
      const total = m - 1 + k * rule.interval;
      const year = y + Math.floor(total / 12);
      const month = total % 12;
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const iso = toIso(Date.UTC(year, month, Math.min(d, lastDay)) / DAY_MS);
      if (iso >= today) return iso;
    }
  }

  if (rule.freq === "week" && rule.weekdays?.length) {
    for (let day = start + 1; ; day++) {
      const onWeek = (weekOf(day) - weekOf(start)) % rule.interval === 0;
      if (day >= min && onWeek && rule.weekdays.includes(weekday(day))) return toIso(day);
    }
  }

  const step = (rule.freq === "day" ? 1 : 7) * rule.interval;
  let day = start + step;
  while (day < min) day += step;
  return toIso(day);
}

export const addDays = (iso: string, n: number) => toIso(toDays(iso) + n);
export const daysBetween = (from: string, to: string) => toDays(to) - toDays(from);
export const mondayOf = (iso: string) => addDays(iso, -((weekday(toDays(iso)) + 6) % 7));
