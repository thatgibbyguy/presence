// Watched / ignored / walled domain state over storage. NOT pure.
//
// watched: [{ domain, trippedAt, count, lastAnswer, trippedBy, toolShaped, firstTs, host }]
// ignored: [{ match, scope: "domain"|"host", until }]
// walled:  [{ domain, until }]   — "Not today" until local midnight or session end

import * as store from "./store.js";
import { isIgnored } from "./loop.js";

export const IGNORE_DAYS_DEFAULT = 30;

export async function getWatched() {
  return store.get("watched");
}

export async function getWatchedEntry(domain) {
  const watched = await store.get("watched");
  return watched.find((w) => w.domain === domain) || null;
}

export async function isWatched(domain) {
  return (await getWatchedEntry(domain)) !== null;
}

/** Add a domain to the watched set from a detector trip. Idempotent. */
export async function watch(trip, host, now = Date.now()) {
  const watched = await store.get("watched");
  if (watched.some((w) => w.domain === trip.domain)) return watched;
  watched.push({
    domain: trip.domain,
    host: host || trip.domain,
    trippedAt: now,
    firstTs: trip.firstTs,
    trippedBy: trip.trippedBy,
    toolShaped: !!trip.toolShaped,
    count: trip.count,
    lastAnswer: null,
  });
  await store.set("watched", watched);
  return watched;
}

/** Increment the visit counter for a watched domain (every interrupt). */
export async function bump(domain, host) {
  const watched = await store.get("watched");
  const w = watched.find((x) => x.domain === domain);
  if (!w) return null;
  w.count = (w.count || 0) + 1;
  if (host) w.host = host;
  await store.set("watched", watched);
  return w;
}

/** Record the answer given on the pause page. */
export async function setLastAnswer(domain, answer) {
  const watched = await store.get("watched");
  const w = watched.find((x) => x.domain === domain);
  if (!w) return null;
  w.lastAnswer = answer;
  await store.set("watched", watched);
  return w;
}

export async function unwatch(domain) {
  const watched = await store.get("watched");
  const next = watched.filter((w) => w.domain !== domain);
  if (next.length !== watched.length) await store.set("watched", next);
  return next;
}

/** Midnight: forget everything that tripped today. */
export async function clearWatched() {
  await store.set("watched", []);
}

// ---- ignored ("this is work") ----

export async function getIgnored(now = Date.now()) {
  const ignored = await store.get("ignored");
  return ignored.filter((e) => typeof e.until !== "number" || e.until > now);
}

export async function isIgnoredNow(domain, host, now = Date.now()) {
  return isIgnored(await store.get("ignored"), domain, host, now);
}

/**
 * Ignore a host or domain for `days`. Replaces an existing entry with the same
 * match + scope.
 */
export async function ignore(match, scope = "domain", days = IGNORE_DAYS_DEFAULT, now = Date.now()) {
  const ignored = await store.get("ignored");
  const until = now + days * 86_400_000;
  const idx = ignored.findIndex((e) => e.match === match && e.scope === scope);
  const entry = { match, scope, until };
  if (idx === -1) ignored.push(entry);
  else ignored[idx] = entry;
  await store.set("ignored", ignored);
  return entry;
}

export async function unignore(match, scope) {
  const ignored = await store.get("ignored");
  const next = ignored.filter((e) => !(e.match === match && (scope === undefined || e.scope === scope)));
  if (next.length !== ignored.length) await store.set("ignored", next);
  return next;
}

/** Drop expired ignore entries. */
export async function pruneIgnored(now = Date.now()) {
  const ignored = await store.get("ignored");
  const next = ignored.filter((e) => typeof e.until !== "number" || e.until > now);
  if (next.length !== ignored.length) await store.set("ignored", next);
  return next;
}

// ---- walled ("not today") ----

export async function getWalled(now = Date.now()) {
  const walled = await store.get("walled");
  return walled.filter((w) => w.until > now);
}

export async function walledEntry(domain, now = Date.now()) {
  return (await getWalled(now)).find((w) => w.domain === domain) || null;
}

/** Wall a domain until `until` (later of any existing wall). */
export async function wall(domain, until) {
  const walled = await store.get("walled");
  const idx = walled.findIndex((w) => w.domain === domain);
  if (idx === -1) walled.push({ domain, until });
  else walled[idx].until = Math.max(walled[idx].until, until);
  await store.set("walled", walled);
  return walled;
}

export async function pruneWalled(now = Date.now()) {
  const walled = await store.get("walled");
  const next = walled.filter((w) => w.until > now);
  if (next.length !== walled.length) await store.set("walled", next);
  return next;
}
