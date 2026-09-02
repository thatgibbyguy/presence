# Handoff: Phase 1 — Presence browser extension

This document is self-contained. An agent should be able to build phase 1 from this file plus `PLAN.md` without any other context.

## Goal

A WebExtension for **Chrome (MV3) and Firefox (MV3)** that intercepts navigation to a user's blocklisted sites and shows a block page instead. During a scheduled or manually-started **session**, the block is absolute. Outside a session, the block is **friction**: a countdown and an intent prompt, then the user may continue for a short pass. Every attempt is logged and shown in a Today view.

The user is one person (John) with a Cmd+T → `reddit` reflex. The extension is a mirror held up to that reflex. It is not tamper-proof and doesn't try to be; that's phase 2's job.

## Non-goals for phase 1

- Tamper resistance. Disabling the extension is a two-click bypass. Accepted.
- Safari. Not in scope.
- Blocking non-browser apps.
- Sync, accounts, streaks, notifications, badges, gamification.
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
│   │   ├── hosts.js           normalizeHost(), hostMatches(host, pattern), pure
│   │   ├── schedule.js        activeWindow(schedule, now) → {endsAt} | null, pure
│   │   ├── rules.js           buildRules(lists, state) → DNR rule array, pure
│   │   ├── session.js         SessionSource: getState(), startSession(), grantPass(). Storage-backed today; daemon-backed in phase 2
│   │   ├── store.js           typed get/set over storage.local with defaults + migrations
│   │   └── attempts.js        log(), today(), pure helpers for aggregation
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
    ├── schedule.test.js
    └── rules.test.js
scripts/
└── build-extension.sh         → dist/chrome/ and dist/firefox/ (copy src + icons + the right manifest as manifest.json)
```

Everything in `src/lib/` that is marked *pure* must have no browser API imports so it runs under `node --test`.

## Data model

All state in `storage.local` under one key per collection. Schema version at `meta.schemaVersion`.

```js
// lists
{
  id: "uuid",
  name: "Doom loop",
  mode: "wall" | "friction",     // wall: blocked during sessions, friction outside. friction: friction always, never walled
  patterns: ["reddit.com", "discord.com", "facebook.com"],  // see matching rules
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
[{ ts, host, url, mode: "wall" | "friction", outcome: "blocked" | "passed", intent: "string or null" }]
```

### Default seed on first install

One list named "Doom loop", mode `wall`, patterns:

```
reddit.com  old.reddit.com  new.reddit.com  redd.it  i.redd.it  v.redd.it  redditmedia.com  redditstatic.com
discord.com  discordapp.com  discord.gg  discord.media  discordapp.net
facebook.com  fb.com  m.facebook.com  messenger.com  fbcdn.net
```

Schedule enabled, Mon–Fri 09:00–12:00 and 13:00–17:00. Friction 20s / 10min pass / 3 passes per day.

## Host matching rules (`hosts.js`)

- `normalizeHost(urlOrHost)`: lowercase, strip port, strip trailing dot, strip leading `www.` for comparison only.
- A pattern `example.com` matches `example.com` and any subdomain `*.example.com`. That is the only wildcard semantics. No globs, no regex in v1.
- IP literals never match.

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

## Block page (`block/`)

The page the user actually sees. This is the product.

Shows, in order, nothing else:

1. The host, plain, no logo. "reddit.com"
2. The count: "4th time today. 11 minutes since the last one." (Use ordinal; omit the second sentence on the first attempt of the day.)
3. A single-line text input: placeholder "What were you about to do?" Optional. Saved to the attempt on continue or after 5s idle.
4. **Wall mode:** one line, "Session ends at 5:00 PM." Nothing clickable. The input still works (intent gets logged with outcome `blocked`).
   **Friction mode:** a `Continue` button, disabled with a countdown label ("Continue in 18s"), enabled at zero. Under it, small: "2 passes left today." If passes are exhausted, treat as wall for the rest of the day with the line "No passes left today."
5. On Continue: `grantPass(host)`, log attempt with `outcome: "passed"`, then `location.replace(originalUrl)`.

Style: system font, one accent color, large type, lots of whitespace, respects `prefers-color-scheme`. No animations except the countdown text changing. It should feel like a pause, not a punishment or a nag.

## Popup (`popup/`)

- If a session is active: "Session · ends 5:00 PM" and the source (Scheduled / Manual). Nothing else about the session.
- If not: buttons `25m`, `1h`, `Until 5pm`, `Custom…`. Each starts a manual session immediately with no confirmation.
- Today: attempts blocked, passes used / limit, longest gap between attempts. Three numbers, one line each.
- Link to options.

## Options (`options/`)

- Lists: add/remove lists, edit name, mode toggle (wall/friction), one pattern per line textarea, enabled toggle.
- Schedule: enabled toggle, table of windows (days checkboxes, start, end). Validate `start < end`, same day.
- Friction: delay seconds, pass minutes, daily pass limit.
- Firefox: permission banner if host permission missing.
- Export / import JSON of everything except attempts.

## Tests (`Extension/test/`, run with `node --test Extension/test`)

Minimum coverage, all pure:

- `hosts.test.js`: exact match, subdomain match, `www.` stripping, port stripping, IP literal never matches, no partial match (`notreddit.com` must not match `reddit.com`).
- `schedule.test.js`: inside window, on boundary start (active), on boundary end (inactive), wrong day, disabled schedule, overlapping windows return latest `endsAt`.
- `rules.test.js`: one rule per pattern, stable ids across two calls, pass produces higher-priority allow rule, disabled list yields no rules, wall list with no session yields friction redirects (same redirect target; mode is decided by the block page from state, not by the rule).

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

- [ ] `node --test Extension/test` passes.
- [ ] `scripts/build-extension.sh` produces both dists.
- [ ] Loaded in Chrome and Firefox; navigating to `reddit.com` during a schedule window shows the wall page; outside it shows friction and Continue works after the countdown and grants a 10-minute pass.
- [ ] Discord and Facebook behave the same.
- [ ] Popup starts a manual session with no confirmation and shows no way to end it.
- [ ] Attempts appear in the Today counts and survive a browser restart.
- [ ] Options edits are reflected within one minute or immediately on save.
- [ ] `docs/ARCHITECTURE.md` written: one page, the `SessionSource` seam called out explicitly for phase 2.
- [ ] Committed on `main` with a message per logical chunk. Don't push without being asked.

## Conventions for agents working in this repo

- Plain JS ES modules. No TypeScript, no bundler, no runtime npm deps. `node:test` only for tests.
- Keep everything under `src/lib/` that's marked pure free of `browser`/`chrome` imports.
- Never add a stop button, a snooze, a "just this once," or any other exit from an active session. If it feels like the UX needs one, the answer is to shorten the schedule window, not to add an exit.
- When in doubt about UX copy, less. The block page is a pause, not a lecture.
