// Loop detection. Pure; no browser APIs.
//
// The detector is two thresholds and a window, nothing else:
//   - reflexThreshold reflex visits to one domain within windowMinutes, or
//   - anyThreshold visits of any kind to one domain within windowMinutes.
// It knows nothing about which sites are "bad". It decides that a pattern of
// visits is a loop, never that a site is.

export const DEFAULT_DETECTOR = Object.freeze({
  windowMinutes: 60,
  reflexThreshold: 3,
  anyThreshold: 5,
});

// transitionType values that mean "the hand did this, not a link".
export const REFLEX_TRANSITIONS = new Set(["typed", "generated", "auto_bookmark", "keyword"]);

// Tab-was-empty-before URLs. A visit that follows one of these is a reflex.
export const NEW_TAB_URLS = new Set([
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "chrome://new-tab-page-third-party/",
  "edge://newtab/",
  "brave://newtab/",
  "about:newtab",
  "about:home",
  "about:blank",
]);

/** Is `url` a browser new-tab / empty page? */
export function isNewTabUrl(url) {
  if (url == null || url === "") return true;
  const u = String(url);
  if (NEW_TAB_URLS.has(u)) return true;
  return NEW_TAB_URLS.has(u.replace(/\/$/, "")) || NEW_TAB_URLS.has(u + "/");
}

/**
 * A visit is a reflex when it arrived with a reflex transitionType, or when
 * the tab had no previous URL / was on a new-tab page just before.
 * `details` is a webNavigation.onCommitted payload (only transitionType is read).
 */
export function isReflex(details, previousUrl) {
  const t = details && details.transitionType;
  if (t && REFLEX_TRANSITIONS.has(t)) return true;
  return isNewTabUrl(previousUrl);
}

/** Root visit: path is "/" or empty and there is no query string. */
export function isRootUrl(url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    return false;
  }
  return (u.pathname === "/" || u.pathname === "") && !u.search;
}

/** Visits to `domain` with ts inside the window ending at `now`. */
export function visitsInWindow(visits, domain, now, windowMinutes) {
  const since = now - windowMinutes * 60_000;
  return visits.filter((v) => v.domain === domain && v.ts > since && v.ts <= now);
}

/**
 * detect(visits, domain, now, config) → trip | null
 *
 * trip = { domain, count, reflexCount, rootCount, firstTs, windowMinutes,
 *          trippedBy: "reflex" | "any", toolShaped: bool }
 *
 * toolShaped is true when the trip came from the any-visit threshold and a
 * majority of the arrivals were not reflexes (links, notifications, search).
 * That is what a tool looks like, and it is when "This is work" is offered
 * on the first interrupt.
 */
export function detect(visits, domain, now, config = DEFAULT_DETECTOR) {
  const cfg = { ...DEFAULT_DETECTOR, ...(config || {}) };
  const inWindow = visitsInWindow(visits, domain, now, cfg.windowMinutes);
  const count = inWindow.length;
  if (count === 0) return null;
  let reflexCount = 0;
  let rootCount = 0;
  let firstTs = Infinity;
  for (const v of inWindow) {
    if (v.reflex) reflexCount++;
    if (v.root) rootCount++;
    if (v.ts < firstTs) firstTs = v.ts;
  }
  let trippedBy = null;
  if (reflexCount >= cfg.reflexThreshold) trippedBy = "reflex";
  else if (count >= cfg.anyThreshold) trippedBy = "any";
  if (!trippedBy) return null;
  return {
    domain,
    count,
    reflexCount,
    rootCount,
    firstTs,
    windowMinutes: cfg.windowMinutes,
    trippedBy,
    toolShaped: trippedBy === "any" && reflexCount * 2 < count,
  };
}

/**
 * Does an `ignored` entry cover this visit?
 * scope "domain" matches when entry.match === registrable domain.
 * scope "host" matches when entry.match === exact hostname.
 * Expired entries (until <= now) never match.
 */
export function isIgnored(ignored, domain, host, now) {
  if (!Array.isArray(ignored)) return false;
  for (const e of ignored) {
    if (!e || (typeof e.until === "number" && e.until <= now)) continue;
    if (e.scope === "host") {
      if (host && e.match === host) return true;
    } else if (e.match === domain) {
      return true;
    }
  }
  return false;
}

/** Ordinal for the pause page: 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th". */
export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
