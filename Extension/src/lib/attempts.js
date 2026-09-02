// Attempt log helpers. Pure; no browser APIs. `log()` takes a store object so
// the write path is injectable (real storage in the extension, a stub in tests).
//
// attempt = { ts, domain, url, reason: "loop"|"list", mode: "wall"|"friction",
//             outcome: "blocked"|"passed"|"closed"|"notToday", intent: string|null }

import { startOfLocalDay } from "./schedule.js";

export const ATTEMPT_RETENTION_DAYS = 30;

/** Append an attempt via the given store ({ get(key), set(key, value) }). */
export async function log(store, attempt) {
  const attempts = (await store.get("attempts")) || [];
  const entry = {
    ts: attempt.ts ?? Date.now(),
    domain: attempt.domain,
    url: attempt.url ?? null,
    reason: attempt.reason,
    mode: attempt.mode,
    outcome: attempt.outcome,
    intent: attempt.intent ? String(attempt.intent).slice(0, 500) : null,
  };
  attempts.push(entry);
  await store.set("attempts", attempts);
  return entry;
}

/** Update the most recent attempt matching (domain, ts) — used to attach a late intent. */
export async function amend(store, ts, domain, patch) {
  const attempts = (await store.get("attempts")) || [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (a.ts === ts && a.domain === domain) {
      attempts[i] = { ...a, ...patch };
      await store.set("attempts", attempts);
      return attempts[i];
    }
  }
  return null;
}

/** Drop attempts older than `days`. */
export function prune(attempts, now, days = ATTEMPT_RETENTION_DAYS) {
  const since = now - days * 86_400_000;
  return (attempts || []).filter((a) => a && a.ts >= since);
}

/** Attempts since local midnight. */
export function today(attempts, now) {
  const start = startOfLocalDay(now);
  return (attempts || []).filter((a) => a && a.ts >= start && a.ts <= now);
}

/** Attempts today for one domain, oldest first. */
export function todayForDomain(attempts, domain, now) {
  return today(attempts, now)
    .filter((a) => a.domain === domain)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Today's numbers for the popup:
 *   blocked, passed, closed, notToday   — counts by outcome
 *   passesUsed                          — list-friction passes consumed today
 *   yesCount(domain)                    — "Yes" answers on the loop page for a domain
 *   longestGapMs                        — longest gap between consecutive attempts (0 if < 2)
 */
export function summarize(attempts, now) {
  const t = today(attempts, now).sort((a, b) => a.ts - b.ts);
  const counts = { blocked: 0, passed: 0, closed: 0, notToday: 0 };
  let passesUsed = 0;
  for (const a of t) {
    if (a.outcome in counts) counts[a.outcome]++;
    if (a.outcome === "passed" && a.reason === "list") passesUsed++;
  }
  let longestGapMs = 0;
  for (let i = 1; i < t.length; i++) {
    const gap = t[i].ts - t[i - 1].ts;
    if (gap > longestGapMs) longestGapMs = gap;
  }
  return { ...counts, total: t.length, passesUsed, longestGapMs };
}

/** How many times the loop page got "Yes" for this domain today (excluding "This is work"). */
export function yesCountToday(attempts, domain, now) {
  return todayForDomain(attempts, domain, now).filter(
    (a) => a.reason === "loop" && a.outcome === "passed" && a.intent !== "work",
  ).length;
}

/** Friction passes used today on listed domains. */
export function passesUsedToday(attempts, now) {
  return summarize(attempts, now).passesUsed;
}
