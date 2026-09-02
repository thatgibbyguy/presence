// Pure host helpers. No browser APIs here; this module runs under node:test.
//
// - normalizeHost(urlOrHost): lowercase, strip port, strip trailing dot,
//   strip a leading "www." (for comparison only).
// - registrableDomain(host): eTLD+1 via a small built-in list of two-part
//   public suffixes. IP literals and localhost return null.
// - hostMatches(host, pattern): pattern "example.com" matches example.com and
//   any subdomain. No globs, no regex. IP literals never match.

// Two-part public suffixes where eTLD+1 is the last three labels.
// Deliberately short; no full PSL in v1.
export const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "com.br", "net.br", "org.br",
  "co.nz", "net.nz", "org.nz",
  "co.za", "org.za",
  "co.in", "net.in", "org.in", "ac.in",
  "com.mx", "com.ar", "com.cn", "com.tw", "com.hk", "com.sg", "com.tr",
  "co.kr", "or.kr", "co.il", "co.id", "co.th",
  "com.pl", "com.ua", "com.ru",
]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for IPv4 dotted quads and anything that looks like IPv6. */
export function isIpLiteral(host) {
  if (typeof host !== "string" || host === "") return false;
  const h = host.replace(/^\[|\]$/g, "");
  if (h.includes(":")) return true; // IPv6 (ports were already stripped by normalizeHost)
  const m = IPV4.exec(h);
  if (!m) return false;
  return m.slice(1).every((n) => Number(n) <= 255);
}

/**
 * Lowercase, strip scheme/path if given a URL, strip port, strip trailing dot,
 * strip a leading "www.". Returns "" for unusable input.
 */
export function normalizeHost(urlOrHost) {
  if (typeof urlOrHost !== "string") return "";
  let host = urlOrHost.trim();
  if (host === "") return "";
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  } else {
    // Bare host, possibly with a path or port attached by hand.
    host = host.split("/")[0];
    if (host.startsWith("[")) {
      // [::1]:8080 → ::1
      const end = host.indexOf("]");
      host = end > 0 ? host.slice(1, end) : host.slice(1);
    } else {
      const colon = host.indexOf(":");
      if (colon !== -1 && host.indexOf(":", colon + 1) === -1) {
        // exactly one colon → host:port
        host = host.slice(0, colon);
      }
    }
  }
  host = host.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

/**
 * eTLD+1 by heuristic. "old.reddit.com" → "reddit.com", "www.bbc.co.uk" →
 * "bbc.co.uk". Returns null for IP literals, localhost, single labels, and
 * bare public suffixes.
 */
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (h === "" || h === "localhost" || isIpLiteral(h)) return null;
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo)) {
    if (labels.length < 3) return null; // "co.uk" alone is a suffix, not a site
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/**
 * Does `host` match `pattern`? Exact or any subdomain. IP literals never match.
 */
export function hostMatches(host, pattern) {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (h === "" || p === "") return false;
  if (isIpLiteral(h) || isIpLiteral(p)) return false;
  return h === p || h.endsWith("." + p);
}
