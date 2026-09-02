// declarativeNetRequest rule generation. Pure; no browser APIs.
//
// buildRules(lists, state) → rule[]
//   lists  = [{ id, name, mode, patterns: [], enabled }]
//   state  = {
//     watched: [{ domain }],                // loop-tripped domains → reason=loop redirect
//     walled:  [{ domain, until }],         // "Not today" → reason=list redirect until `until`
//     passes:  [{ host, until }],           // temporary allows → high-priority allow
//     ignored: [{ match, scope, until }],   // domain-scoped: suppresses loop rules;
//                                           // host-scoped: allow rule that beats loop rules only
//     now,                                  // epoch ms, for expiry
//     blockPageUrl,                         // absolute extension URL of block.html
//   }
//
// Every rule is main_frame only. Mode (wall vs friction) is NOT encoded in the
// rule; the pause page decides from session state. The redirect target puts
// `u=` LAST and unencoded so the pause page can take the raw remainder.
//
// Rule ids are a stable hash of (kind, key) into a reserved range so that
// recomputation is idempotent.

import { normalizeHost, registrableDomain } from "./hosts.js";

export const PRIORITY = Object.freeze({
  LOOP: 1, // watched-domain redirect
  IGNORE_HOST: 2, // host-scoped "this is work" allow; beats LOOP, loses to LIST
  LIST: 3, // list pattern / walled-domain redirect
  PASS: 4, // temporary pass allow; beats everything
});

export const ID_MIN = 100_000;
export const ID_SPAN = 1 << 20;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable positive rule id for a (kind, key) pair. */
export function ruleId(kind, key) {
  return ID_MIN + (fnv1a(`${kind}:${key}`) % ID_SPAN);
}

function redirectRule(id, domain, priority, blockPageUrl, reason, paramName) {
  return {
    id,
    priority,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `${blockPageUrl}?reason=${reason}&${paramName}=${encodeURIComponent(domain)}&u=\\1`,
      },
    },
    condition: {
      regexFilter: "^(.*)$",
      requestDomains: [domain],
      resourceTypes: ["main_frame"],
    },
  };
}

function allowRule(id, host, priority) {
  return {
    id,
    priority,
    action: { type: "allow" },
    condition: {
      requestDomains: [host],
      resourceTypes: ["main_frame"],
    },
  };
}

function unexpired(entries, now) {
  return (entries || []).filter((e) => e && (typeof e.until !== "number" || e.until > now));
}

/**
 * Build the full dynamic rule set. Ids are stable; collisions are resolved
 * deterministically by probing upward after sorting inputs.
 */
export function buildRules(lists, state = {}) {
  const now = typeof state.now === "number" ? state.now : Date.now();
  const blockPageUrl = state.blockPageUrl || "block.html";
  const used = new Set();
  const out = [];

  const claim = (kind, key) => {
    let id = ruleId(kind, key);
    while (used.has(id)) id = id + 1 > ID_MIN + ID_SPAN ? ID_MIN : id + 1;
    used.add(id);
    return id;
  };

  // 1. Passes (highest priority) so a colliding id never displaces one.
  const passHosts = new Set();
  for (const p of unexpired(state.passes, now)) {
    const h = normalizeHost(p.host);
    if (h) passHosts.add(h);
  }
  for (const h of [...passHosts].sort()) {
    out.push(allowRule(claim("pass", h), h, PRIORITY.PASS));
  }

  // 2. List patterns + walled domains → reason=list.
  const listed = new Set();
  for (const list of lists || []) {
    if (!list || !list.enabled) continue;
    for (const raw of list.patterns || []) {
      const p = normalizeHost(raw);
      if (p && registrableDomain(p) !== null) listed.add(p);
    }
  }
  for (const w of unexpired(state.walled, now)) {
    const d = normalizeHost(w.domain);
    if (d) listed.add(d);
  }
  for (const p of [...listed].sort()) {
    out.push(redirectRule(claim("list", p), p, PRIORITY.LIST, blockPageUrl, "list", "h"));
  }

  // 3. Host-scoped ignores → allow that beats loop rules only.
  const ignored = unexpired(state.ignored, now);
  const ignoredDomains = new Set(
    ignored.filter((e) => e.scope !== "host").map((e) => normalizeHost(e.match)).filter(Boolean),
  );
  const ignoredHosts = new Set(
    ignored.filter((e) => e.scope === "host").map((e) => normalizeHost(e.match)).filter(Boolean),
  );
  for (const h of [...ignoredHosts].sort()) {
    out.push(allowRule(claim("ignore", h), h, PRIORITY.IGNORE_HOST));
  }

  // 4. Watched (loop-tripped) domains → reason=loop, unless listed or ignored.
  const watched = new Set();
  for (const w of state.watched || []) {
    const d = normalizeHost(w && w.domain);
    if (!d || listed.has(d) || ignoredDomains.has(d)) continue;
    watched.add(d);
  }
  for (const d of [...watched].sort()) {
    out.push(redirectRule(claim("loop", d), d, PRIORITY.LOOP, blockPageUrl, "loop", "d"));
  }

  return out;
}

/** Cheap structural signature so callers can skip no-op rule swaps. */
export function rulesSignature(rules) {
  return JSON.stringify(rules);
}
