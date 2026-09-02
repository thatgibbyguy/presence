// Schedule evaluation. Pure; no browser APIs. All times are local.
//
// schedule = { enabled, windows: [{ days: [0..6], start: "HH:MM", end: "HH:MM" }] }
// activeWindow(schedule, now) → { startsAt, endsAt } | null
// Windows that cross midnight are not supported in v1 (validateWindow rejects them).

export const DEFAULT_SCHEDULE = Object.freeze({
  enabled: true,
  windows: [
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00" },
    { days: [1, 2, 3, 4, 5], start: "13:00", end: "17:00" },
  ],
});

/** "09:30" → 570 (minutes since local midnight). Returns null if malformed. */
export function parseHHMM(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** Epoch ms of local midnight at the start of the day containing `now`. */
export function startOfLocalDay(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Epoch ms of the next local midnight strictly after `now`. */
export function nextLocalMidnight(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** Epoch ms of `minutes` past local midnight on the day containing `now`. */
export function localTimeOn(now, minutes) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes).getTime();
}

/**
 * Returns an error string, or null if the window is valid: known days,
 * parseable times, start < end on the same day.
 */
export function validateWindow(w) {
  if (!w || !Array.isArray(w.days) || w.days.length === 0) return "Pick at least one day.";
  if (w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Days must be 0–6.";
  const s = parseHHMM(w.start);
  const e = parseHHMM(w.end);
  if (s == null || e == null) return "Times must be HH:MM.";
  if (s >= e) return "Start must be before end, on the same day.";
  return null;
}

/**
 * The window containing `now`, or null. Start boundary is inclusive, end is
 * exclusive. When several windows contain `now`, the latest endsAt wins.
 */
export function activeWindow(schedule, now) {
  if (!schedule || !schedule.enabled || !Array.isArray(schedule.windows)) return null;
  const d = new Date(now);
  const day = d.getDay();
  const minutesNow = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60_000;
  let best = null;
  for (const w of schedule.windows) {
    if (validateWindow(w) !== null) continue;
    if (!w.days.includes(day)) continue;
    const s = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    if (minutesNow >= s && minutesNow < e) {
      const endsAt = localTimeOn(now, e);
      const startsAt = localTimeOn(now, s);
      if (!best || endsAt > best.endsAt) best = { startsAt, endsAt };
    }
  }
  return best;
}

/** "5:00 PM" style clock string for a timestamp, local time. */
export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
