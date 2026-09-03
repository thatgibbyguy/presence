# Handoff: Phase 1 — Presence browser extension

This document is self-contained. An agent should be able to build phase 1 from this file plus `PLAN.md` without any other context.

## Goal

A WebExtension for **Chrome (MV3) and Firefox (MV3)** that **detects the doom loop and interrupts it.** The loop is: open the same site again and again in a short span, usually from a fresh tab with the address typed by hand. The extension watches every main-frame navigation, and when a domain trips the detector it steps in with a pause page that asks: *"Is this what you need to be doing?"*

The user does **not** tell the extension which sites are a problem. There is no onboarding question about sites. The extension learns them by catching the behavior; the user's answers on the pause page build the blocklist over time.

Blocklists then feed **sessions**: during a scheduled or manually-started session, listed sites are walled absolutely. Outside a session, listed sites get **friction**: a countdown and an intent prompt, then a short pass. Every attempt is logged and shown in a Today view.

The user is one person (John). The extension is a mirror held up to a reflex. It is not tamper-proof and doesn't try to be; that's phase 2's job.

**Build order within phase 1: detection first.** A version that only detects loops and shows the pause page, with no lists and no sessions, is already the product. Lists and sessions come after.

## Non-goals for phase 1

- Tamper resistance. Disabling the extension is a two-click bypass. Accepted.
- Safari. Not in scope.
- Blocking non-browser apps.
- Sync, accounts, streaks, notifications, badges, gamification.
- Any statistical or ML approach to detection. Two thresholds and a clock. See "Loop detection."
- Time-on-site tracking. We count arrivals, not minutes.
- Any build tooling beyond a copy script. Plain ES modules, no bundler, no framework, no npm dependencies at runtime.

## Environment

- macOS 26 Tahoe. Node 24 available for tests (`node --test`). No Xcode.
- Chrome, Firefox, and Brave are installed in `/Applications`.
- Repo root: this repository. Extension lives in `Extension/`.

## Repository layout to create

```
Extension/
├── manifest.chrome.json
├── manifest.firefox.json
├── src/
│   ├── background.js          service worker (Chrome) / background script (Firefox)
│   ├── lib/
│   │   ├── browser.js         export const browser = globalThis.browser ?? globalThis.chrome
│   │   ├── hosts.js           normalizeHost(), hostMatches(host, pattern), registrableDomain(host), pure
│   │   ├── loop.js            detect(visits, domain, now, config) → trip | null; isReflex(details), pure
│   │   ├── schedule.js        activeWindow(schedule, now) → {endsAt} | null, pure
│   │   ├── rules.js           buildRules(lists, state) → DNR rule array, pure
│   │   ├── session.js         SessionSource: getState(), startSession(), grantPass(). Storage-backed today; daemon-backed in phase 2
│   │   ├── store.js           typed get/set over storage.local with defaults + migrations
│   │   ├── attempts.js        log(), today(), pure helpers for aggregation
│   │   └── watch.js           watched/ignored domain state over storage: watch(domain), isWatched(), ignore(domain, days)
│   ├── block/
│   │   ├── block.html
│   │   ├── block.js
│   │   └── block.css
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   └── options/
│       ├── options.html
│       ├── options.js
│       └── options.css
├── icons/                     16, 32, 48, 128 PNG. Simple, monochrome, a single dot is fine
└── test/
    ├── hosts.test.js
    ├── loop.test.js
    ├── schedule.test.js
    └── rules.test.js
scripts/
└── build-extension.sh         → dist/chrome/ and dist/firefox/ (copy src + icons + the right manifest as manifest.json)
```

Everything in `src/lib/` that is marked *pure* must have no browser API imports so it runs under `node --test`.

## Data model

All state in `storage.local` under one key per collection. Schema version at `meta.schemaVersion`.

```js
// visits — ARRIVALS ONLY (rolling, main_frame only, prune > 48h on startup and daily)
[{ ts, domain, host, reflex: true|false, root: true|false }]
// domain = registrable domain; host = exact hostname (needed for scoped ignores);
// root = path was "/" or empty. No full URLs here.
// An arrival is a visit whose origin (the tab's previous page, or the opener
// tab's page for a tab spawned by a link) is on a different registrable
// domain, or has no origin at all (a fresh tab). Clicking page to page within
// one site — five Redfin listings, reddit.com -> reddit.com/r/adops — is
// depth, not a new arrival, and is never appended here.

// detector config
{
  windowMinutes: 60,
  reflexThreshold: 3,             // reflex visits to one domain within window → trip
  anyThreshold: 5                 // visits of any kind to one domain within window → trip
}

// watched (domains that tripped today; cleared at local midnight)
[{ domain: "reddit.com", trippedAt, count, lastAnswer: "yes"|"no"|"notToday"|null }]

// ignored (hosts or domains the user said are work; detection skips them)
[{ match: "atlassian.net" | "ads.reddit.com", scope: "domain" | "host", until }]
// until = epoch ms, default now + 30 days. scope "domain" matches the registrable
// domain and all subdomains; scope "host" matches that exact hostname only.

// lists
{
  id: "uuid",
  name: "Not today",
  mode: "wall" | "friction",     // wall: blocked during sessions, friction outside. friction: friction always, never walled
  patterns: [],                   // EMPTY by default. Filled by the pause page's "Not today" answer. See matching rules
  enabled: true
}

// schedule (one, global)
{
  enabled: true,
  windows: [
    { days: [1,2,3,4,5], start: "09:00", end: "12:00" },   // days: 0=Sun…6=Sat, local time
    { days: [1,2,3,4,5], start: "13:00", end: "17:00" }
  ]
}

// session (manual)
{ endsAt: 1725300000000 } | null      // epoch ms; also store startedAt for the popup

// friction settings
{
  delaySeconds: 20,
  passMinutes: 10,
  dailyPassLimit: 3               // 0 = unlimited
}

// passes (active temporary allows)
[{ host: "reddit.com", until: 1725300600000 }]

// attempts (append-only, prune > 30 days on startup)
[{ ts, domain, url, reason: "loop" | "list", mode: "wall" | "friction",
   outcome: "blocked" | "passed" | "closed" | "notToday", intent: "string or null" }]
```

### Default seed on first install

One list named "Not today", mode `wall`, **no patterns.** Schedule enabled, Mon–Fri 09:00–12:00 and 13:00–17:00. Friction 20s / 10min pass / 3 passes per day. Detector at defaults above. `watched` and `ignored` empty.

Do not seed reddit, discord, or facebook. The owner knows those are his current sites; the point is that the extension has to find that out on its own, so that it also finds the next one.

## Host matching rules (`hosts.js`)

- `normalizeHost(urlOrHost)`: lowercase, strip port, strip trailing dot, strip leading `www.` for comparison only.
- `registrableDomain(host)`: eTLD+1. Last two labels, or last three when the last two are in a small built-in list of two-part suffixes (`co.uk`, `org.uk`, `com.au`, `co.jp`, `com.br`, and a dozen more; keep the list in the module). `old.reddit.com` → `reddit.com`. IP literals and `localhost` return `null`.
- A pattern `example.com` matches `example.com` and any subdomain `*.example.com`. That is the only wildcard semantics. No globs, no regex in v1.
- IP literals never match.

## Loop detection (`loop.js`, `watch.js`, `background.js`)

This is the core of phase 1. Build and test it before lists or sessions.

**Observing.** Listen to `webNavigation.onCommitted` filtered to `frameId === 0`. For each event:

1. `domain = registrableDomain(new URL(details.url).hostname)`. Skip if `null`, if the URL scheme isn't http(s), or if the URL is our own extension page.
2. Skip if an `ignored` entry with `until > now` matches: scope `domain` matches when `entry.match === domain`; scope `host` matches when `entry.match === hostname`.
3. Resolve the tab's origin. If the tab already has a previous URL (tracked per tab in memory; it does not need to survive a service worker restart), that's the origin. Otherwise the tab may have just been spawned by a link on another page (`target="_blank"`, cmd-click): call `browser.tabs.get(details.tabId)` (wrapped in try/catch), read `openerTabId`, and use the opener's previous URL (or its current `tabs.get` URL) as the origin, marking `openedByPage`. A genuine Cmd+T tab has no opener, so its origin stays "none". `originDomain = registrableDomain(normalizeHost(hostname))` for an http(s) origin, else `null`.
4. **Arrival check.** `isArrival(domain, originDomain)` is false only when `originDomain === domain` (same-site depth). If not an arrival: still record the tab's previous URL for next time, but do **not** append to `visits` and do not run detection or interrupt — the click just navigated within a site that may already be watched, and its DNR rule (unchanged) still redirects that case; this step only keeps the *count* honest.
5. `reflex = isReflex(details, previousUrlForTab, { openedByPage })` where reflex is true when `transitionType ∈ {"typed", "generated", "auto_bookmark", "keyword"}` **or** the tab's previous URL was a new-tab page (`chrome://newtab/`, `about:newtab`, `about:home`, `about:blank`) or the tab had no previous URL (freshly opened) — **unless** `openedByPage` is true, in which case that new-tab/no-previous-URL fallback does not apply (three Redfin listings opened in three new tabs via links must not look like Cmd+T + typed three times). `root = (url.pathname === "/" || url.pathname === "") && !url.search`.
6. Append `{ ts, domain, host: hostname, reflex, root }` to `visits`.
7. If `domain` is already `watched` → interrupt (see below).
8. Else `trip = detect(visits, domain, now, config)`. If `trip` → add to `watched`, then interrupt.

**`detect(visits, domain, now, config)`** is pure. Returns `null` or `{ domain, count, reflexCount, rootCount, firstTs, windowMinutes, trippedBy: "reflex" | "any", toolShaped: bool }`. Counts visits to `domain` with `ts > now - windowMinutes*60_000`. Trips when `reflexCount >= reflexThreshold` (`trippedBy: "reflex"`) or `count >= anyThreshold` (`trippedBy: "any"`). `toolShaped` is true when `trippedBy === "any"` and `reflexCount * 2 < count` (a majority of arrivals were links, notifications, or searches). The visit that just happened is included in the count. `rootCount` is recorded for later tuning and does not affect v1 thresholds.

**Interrupting.**

- On the tripping visit: `tabs.update(details.tabId, { url: block.html?u=<url>&d=<domain>&reason=loop })`. The site may have started rendering; a brief flash is accepted.
- For all later visits that day: add a DNR redirect rule for `domain` (same shape as list rules, `reason=loop` in the redirect target) so the pause page lands before the site loads. Remove the rule at local midnight together with the `watched` entry. Reuse `rules.js`; watched domains are one more input to `buildRules`.
- A `passes` entry for the domain suppresses both paths until it expires, exactly as for list patterns.

**Midnight reset.** An `alarms` alarm at next local midnight clears `watched` and their rules. The `ignored` list and the `lists` are not touched. `visits` older than 48h are pruned at the same time.

**Chrome/Firefox notes.** Chrome reports `transitionType` fully. Firefox's `webNavigation` supports `onCommitted` with `transitionType` but coverage of `typed` vs `link` is known to be less complete. Verify empirically on both; if Firefox under-reports, the new-tab-previous-URL rule carries the reflex signal there. Write down what you observed in `docs/ARCHITECTURE.md`. Both manifests need the `webNavigation` permission.

## Session logic (`schedule.js`, `session.js`)

`state = { active: boolean, endsAt: number|null, source: "schedule"|"manual"|null }`

- `activeWindow(schedule, now)` returns the window containing `now` in local time, with its `endsAt` as epoch ms, or `null`. Windows that cross midnight are **not** supported in v1; validate in the options UI.
- A manual session with `endsAt > now` is active. Manual sessions cannot be stopped from the UI. There is no stop button anywhere. When a manual session overlaps a schedule window, `endsAt` is the later of the two.
- **No emergency exit. Do not add one.** This is a product decision by the owner.
- `SessionSource` is an interface with one implementation, `StorageSessionSource`. Phase 2 adds `NativeSessionSource` backed by the daemon over native messaging. Keep every consumer (background, block page, popup) talking to the interface, never to storage directly.

## Blocking mechanism (`rules.js`, `background.js`)

Use `declarativeNetRequest` **dynamic rules** in both browsers.

- For every enabled list pattern, one rule: `condition: { requestDomains: [pattern], resourceTypes: ["main_frame"] }`, `action: { type: "redirect", redirect: { regexSubstitution or extensionPath } }` to `block.html?u=<encoded original URL>&h=<host>`. Chrome supports `extensionPath` + `regexFilter`; for capturing the original URL, use `regexFilter: "^(.*)$"` with `regexSubstitution: "<ext-url>/src/block/block.html?u=\\1"` combined with `requestDomains`. Test both browsers; if Firefox rejects the substitution form, fall back to redirecting without the URL and reconstruct from `document.referrer` / tab history in `block.js`.
- `main_frame` only. Never block subresources in v1. The goal is to catch navigation, not to break embedded content elsewhere.
- **Passes** are implemented as higher-priority `allow` rules for the specific host, removed by an alarm when `until` elapses.
- Rules are fully recomputed and swapped (`updateDynamicRules` with removeRuleIds of everything we own) whenever lists, passes, or session state change. Stable rule ids: hash the pattern to a positive int in a reserved range so recomputation is idempotent.
- The block page must be listed in `web_accessible_resources` for redirects to land on it.
- Register an `alarms` alarm every minute to re-evaluate schedule state and expire passes. Recompute rules only when state actually changed.
- Log an attempt from the block page on load (not from the background), so the attempt carries the intent text if the user provides one.

### Firefox-specific gotchas

- MV3 host permissions are **optional at install** in Firefox. On install, prompt via `permissions.request` from the options page if `<all_urls>` isn't granted, and show a clear banner until it is. Without it, DNR rules won't apply.
- `background.scripts` (not `service_worker`) in the Firefox manifest. Keep `background.js` free of service-worker-only APIs so one file serves both.
- Needs `browser_specific_settings.gecko.id` in the manifest, e.g. `presence@thatgibbyguy`.
- For local install use `about:debugging` → Load Temporary Add-on, pointing at `dist/firefox/manifest.json`. Note that temporary add-ons are removed on restart; document this in the README and accept it for phase 1.

### Chrome-specific

- `service_worker` background. Load unpacked from `dist/chrome/`.
- `declarativeNetRequest` permission plus `declarativeNetRequestFeedback` is not needed. Do not request `webRequest`.

## Pause page (`block/`)

The page the user actually sees. This is the product. It has two variants chosen by `reason`, and within each, by session state.

### `reason=loop` (detection interrupt)

1. The domain, plain, no logo. "reddit.com"
2. The count and span: "4th time in the last 40 minutes." (Ordinal; span is `now - firstTs` in the window, rounded to minutes. If this is a watched-domain revisit later in the day, say "7th time today.")
3. The question, as its own line, large: **"Is this what you need to be doing?"**
4. A single-line text input: placeholder "What for?" Optional outside a session; **required** during a session before *Yes* enables. Saved to the attempt.
5. After a countdown (`delaySeconds`, label on the Yes button: "Yes · 18s"), three buttons:
   - **Yes** → `grantPass(domain)`, log `outcome: "passed"`, `location.replace(originalUrl)`.
   - **No** → log `outcome: "closed"`, `tabs.remove(currentTab)`. If it's the only tab in the window, navigate to the new-tab page instead of closing the window.
   - **Not today** → log `outcome: "notToday"`, add `domain` to the default list's patterns, mark it walled until local midnight (or until the session ends, whichever is later, if a session is active), rebuild rules, then show the wall variant of this page in place.
6. A fourth, smaller row, "Stop asking about `<domain-or-host>`" followed by three small buttons — **1 hour / Today / 30 days** — appears under the main buttons when **either** the trip was `toolShaped` (first interrupt included) **or** this is at least the second *Yes* on the domain today. Taking any duration adds an `ignored` entry with `until` set from that duration (never a pass — passes must not be used here, since a pass allow rule would outrank a list wall in `rules.js`), removes the domain from `watched`, logs `outcome: "passed"` with `intent: "work"`, and continues to the URL immediately. **Scope:** if the tripping visit's hostname differs from its registrable domain (`ads.reddit.com` vs `reddit.com`), the entry is `scope: "host"` for that hostname and the row's label names it: "Stop asking about ads.reddit.com." Otherwise `scope: "domain"`. Never offer to ignore `reddit.com` when the user is on `ads.reddit.com`; the point is that mixed sites stay watched.

### `reason=list` (listed domain)

1. The domain.
2. The count: "4th time today. 11 minutes since the last one." (Omit the second sentence on the first attempt of the day.)
3. The intent input: placeholder "What were you about to do?" Optional. Saved on continue or after 5s idle.
4. **Wall (session active, or walled by Not today):** one line, "Session ends at 5:00 PM." or "Back tomorrow." Nothing clickable. The input still works; intent is logged with `outcome: "blocked"`.
   **Friction (no session):** a `Continue` button, disabled with a countdown label ("Continue in 18s"), enabled at zero. Under it, small: "2 passes left today." If passes are exhausted, treat as wall for the rest of the day with the line "No passes left today."
5. On Continue: `grantPass(domain)`, log `outcome: "passed"`, `location.replace(originalUrl)`.

Style: system font, one accent color, large type, lots of whitespace, respects `prefers-color-scheme`. No animations except the countdown text changing. It should feel like a pause, not a punishment or a nag. The question is asked once, plainly; it is never rephrased as a guilt trip.

## Popup (`popup/`)

- If a session is active: "Session · ends 5:00 PM" and the source (Scheduled / Manual). Nothing else about the session.
- If not: buttons `25m`, `1h`, `Until 5pm`, `Custom…`. Each starts a manual session immediately with no confirmation.
- Loops today: one line per watched domain, "reddit.com · 6 times · last answer: No". Empty state: "Nothing caught today."
- Today: attempts blocked, passes used / limit, longest gap between attempts. Three numbers, one line each.
- Link to options.

## Options (`options/`)

- Detector: window minutes, reflex threshold, any-visit threshold. One line of help: "Trips when you open the same site N times in the window."
- Ignored: the hosts and domains you said are work, with scope and expiry. Remove button per row. Hand-adding is allowed here but nothing prompts for it; the intended path is the pause page.
- Lists: add/remove lists, edit name, mode toggle (wall/friction), one pattern per line textarea, enabled toggle. Note under the default list: "Filled in by Not today. You can add sites by hand too."
- Export / import covers detector config, ignored, lists, schedule, friction. Not visits or attempts.
- Schedule: enabled toggle, table of windows (days checkboxes, start, end). Validate `start < end`, same day.
- Friction: delay seconds, pass minutes, daily pass limit.
- Firefox: permission banner if host permission missing.
- Export / import JSON of everything except attempts.

## Tests (`Extension/test/`, run with `node --test "Extension/test/*.test.js"`)

Minimum coverage, all pure:

- `hosts.test.js`: exact match, subdomain match, `www.` stripping, port stripping, IP literal never matches, no partial match (`notreddit.com` must not match `reddit.com`). `registrableDomain`: `old.reddit.com` → `reddit.com`, `www.bbc.co.uk` → `bbc.co.uk`, `localhost` → `null`, `10.0.0.1` → `null`.
- `loop.test.js`: 3 reflex visits in 60m trips with `trippedBy: "reflex"`; 2 do not; 3 reflex visits with the first at 61m ago does not; 5 non-reflex visits trip with `trippedBy: "any"` and `toolShaped: true`; 5 visits of which 3 reflex trips with `toolShaped: false`; 4 do not; visits to other domains never count; result carries correct `count`, `reflexCount`, `rootCount`, `firstTs`; custom config is honored; `isReflex` true for `typed`/`generated`/`auto_bookmark`/`keyword`, true for `link` from a new-tab previous URL, false for `link` from another http page. `isReflex` with `{ openedByPage: true }`: a `link` transition with no previous URL is **not** a reflex (opener-spawned tab, e.g. a Redfin listing opened via cmd-click), but `typed`/`auto_bookmark` still are; without `openedByPage` (a genuine Cmd+T tab) the no-previous-URL fallback still applies. `isArrival(domain, originDomain)`: false when `originDomain === domain`, true when it differs, true when `null`/`undefined`. Ignore matching: a `host`-scoped entry for `ads.reddit.com` skips that host and not `reddit.com`; a `domain`-scoped entry for `atlassian.net` skips `highway.atlassian.net`; an expired `until` never matches.
- `schedule.test.js`: inside window, on boundary start (active), on boundary end (inactive), wrong day, disabled schedule, overlapping windows return latest `endsAt`.
- `rules.test.js`: one rule per pattern, one rule per watched domain with `reason=loop` in the target, stable ids across two calls, pass produces higher-priority allow rule, disabled list yields no rules, wall list with no session yields friction redirects (same redirect target; mode is decided by the pause page from state, not by the rule), ignored domains produce no rules even if watched.

## Build & install

`scripts/build-extension.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
for target in chrome firefox; do
  out="$root/dist/$target"
  rm -rf "$out"; mkdir -p "$out"
  cp -R "$root/Extension/src" "$out/src"
  cp -R "$root/Extension/icons" "$out/icons"
  cp "$root/Extension/manifest.$target.json" "$out/manifest.json"
done
echo "built dist/chrome and dist/firefox"
```

README gets a "Install locally" section: Chrome → `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`. Firefox → `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`, then grant host permission from the options page.

## Definition of done for phase 1

- [ ] `node --test "Extension/test/*.test.js"` passes.
- [ ] `scripts/build-extension.sh` produces both dists.
- [ ] **Detection:** with an empty list, in Chrome and Firefox, Cmd+T → type `reddit.com` → Enter three times inside an hour shows the pause page on the third visit with "3rd time in the last N minutes" and the question. A fourth visit shows the pause page before reddit renders. Opening `reddit.com` by clicking links from another site five times trips it; four does not.
- [ ] **Answers:** Yes continues and grants a pass; No closes the tab; Not today walls the domain, adds it to the default list, and the list shows it in options. Second Yes in a day surfaces "This is work"; taking it stops detection for that domain.
- [ ] **Midnight:** watched state and loop rules clear at local midnight (test by moving the alarm or mocking the clock); the list entry from Not today persists.
- [ ] Navigating to a listed domain during a schedule window shows the wall page; outside it shows friction and Continue works after the countdown and grants a 10-minute pass.
- [ ] Popup starts a manual session with no confirmation and shows no way to end it.
- [ ] Attempts appear in the Today counts and survive a browser restart.
- [ ] Options edits are reflected within one minute or immediately on save.
- [ ] `docs/ARCHITECTURE.md` written: one page, the detection pipeline (`onCommitted` → `detect` → interrupt → rule) and the `SessionSource` seam called out explicitly for phase 2, plus what `transitionType` values each browser actually reported.
- [ ] Committed on `main` with a message per logical chunk. Don't push without being asked.

## Conventions for agents working in this repo

- Plain JS ES modules. No TypeScript, no bundler, no runtime npm deps. `node:test` only for tests.
- Keep everything under `src/lib/` that's marked pure free of `browser`/`chrome` imports.
- Never add a stop button, a snooze, a "just this once," or any other exit from an active session. If it feels like the UX needs one, the answer is to shorten the schedule window, not to add an exit.
- Never seed a blocklist or add an onboarding step that asks which sites to block. Detection finds them. If detection isn't finding them, fix detection. The same goes for the ignore list: no "which sites are for work" step. Arrival type tells us more than the user's guess would.
- A site is never "bad" or "good." Visits are. Reddit can be a doom loop at 2:47pm and ad research at 10am; the design handles the first with the question and the second with *Yes* plus an intent, never with a whitelist.
- The detector stays dumb and inspectable: thresholds and a window. Do not add scoring, decay curves, or anything the options page can't explain in one line.
- When in doubt about UX copy, less. The pause page is a pause, not a lecture. The question is "Is this what you need to be doing?" and nothing more pointed.
