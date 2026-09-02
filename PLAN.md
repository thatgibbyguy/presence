# Presence — Plan

A macOS app that notices the Cmd+T → same-site-again doom loop and interrupts it. Bespoke first, public later.

Status: v0.4 (2026-09-02). Interview done, decisions locked in §8. §9 resolved: extension first. v0.4 reframes the product around **loop detection** rather than a prescripted blocklist (§1, §3a, §8 Q9). Phase 1 handoff spec is in `docs/HANDOFF-extension.md`.

---

## 1. What we're actually fixing

The loop is not "I decided to browse Reddit." It's a reflex: Cmd+T, type `r`, Enter, before the brain is involved. Close the tab, work for four minutes, do it again. **The site is incidental.** Today it's reddit, discord, facebook; next month it could be anything. Cmd+T is incidental too; the same loop runs from a bookmark or a pinned tab. What's constant is the shape: *the same place, over and over, in a short span, with no reason.*

So the product must not depend on John writing the sites down in advance. There is no onboarding question about "your problem sites." The extension has to **watch for the loop itself and interrupt it.** Three jobs, in priority order:

1. **Detection** — notice that the same site is being opened again and again in a short window, especially from a fresh tab with the address typed by hand. That pattern *is* the doom loop, whatever the domain. Detection is behavioral and unscripted. It learns the sites by catching you.
2. **Interruption** — when a loop is detected, step in on that visit with a page that says: "4th time on reddit.com in the last 40 minutes. Is this what you need to be doing?" and a short pause before you can answer. Hard blocks alone get uninstalled; a question at the right moment is what retrains the hand.
3. **Enforcement** — for sites you've confirmed are a problem (by answering "not today" on the pause page, or by adding them to a list), sessions make them unreachable. Not "hard to reach." Unreachable, until the timer ends. This is SelfControl's core promise and it stays.

Blocklists still exist, but they are an *output* of detection, not an input. The default list ships empty. Everything else (schedules, stats) is in service of those three.

## 2. Platform reality (verified 2026-09-02)

| Approach | Blocks browsers | Blocks Discord.app etc. | Needs Apple entitlement | Notes |
|---|---|---|---|---|
| `/etc/hosts` via root daemon | Yes | Yes (anything using system DNS) | No | SelfControl's approach. Bypassable with sudo, but the daemon re-asserts every few seconds. Firefox and Chrome both consult the hosts file before their DNS-over-HTTPS resolvers (verify empirically in phase 1). |
| `pf` firewall rules | Yes (by IP) | Yes | No | Fragile against CDNs. Supplement only. |
| Network Extension content filter (`NEFilterDataProvider`, system extension) | Yes | Yes | **Yes** — `content-filter-provider-systemextension`; requires a paid Developer account and Apple's approval. Known to be awkward for Developer ID distribution. | The "correct" modern approach. Filters by hostname at socket level, no root hacks. This is what commercial blockers use. Requires Xcode. |
| Screen Time API (FamilyControls / ManagedSettings / DeviceActivity) | — | — | — | **iOS/iPadOS only. Not available on macOS.** Ruled out. |
| Browser extension | Yes (that browser only) | No | No | Trivially bypassed (disable extension), but the only way to show a *nice* block page on HTTPS sites, capture intent, and count attempts. |

**Decision: two-layer architecture.**

- **Layer 1, the wall:** system-level enforcement. Start with a hosts-file daemon (ships day one, no entitlement, no Xcode). Swap to Network Extension once there's a Developer account and the entitlement is granted. Same interface, pluggable backend.
- **Layer 2, the mirror:** WebExtension for Chrome and Firefox. Loop detection, the pause page, attempt counting, intent prompt, friction delay. Present whether or not a hard session is on. This layer is where the product's actual idea lives; the wall only enforces what the mirror has learned.

## 3. Product surface (v1)

**Menu bar app** (no Dock icon). Click it:

- **Schedule** (primary, per John's answer): recurring sessions, e.g. Mon–Fri 9:00–12:00 and 13:00–17:00. When a scheduled session begins there is no stop button. The menu shows the countdown and nothing else.
- **Start session now**: 25m / 1h / 2h / until end of day / custom. Same no-stop rule.
- **Loops**: what detection caught today. Each domain that tripped the detector, how many times, and what you answered. This is the primary "today" view.
- **Lists**: named blocklists, **empty by default.** They fill up from the pause page: answering "Not today" adds the domain to the default list. Manual editing is available in options for people who want a head start, but nothing is seeded. Each list has a mode:
  - **Wall** — hard block during sessions.
  - **Friction** — always on, never hard-blocked. Show the pause page, allow through after N seconds, optional daily pass limit.
  - Default list is **wall during sessions, friction outside them.**
- **Today**: loops caught, attempts blocked, passes used, longest gap between attempts. Small, honest, not gamified.

**Pause page** (extension): the domain, the count and span ("4th time in the last 40 minutes"), the question "Is this what you need to be doing?", a one-line intent input, and after a short countdown three answers: **Yes** (continue), **No** (close the tab), **Not today** (wall it until midnight and add it to the list). During a session on a listed site, none of that: one line, "Session ends at 2:15pm." No unlock button anywhere.

### 3a. Loop detection

The detector is a pure function over a rolling log of main-frame visits. It knows nothing about which sites are "bad."

- **Unit is the registrable domain.** `old.reddit.com`, `www.reddit.com`, and `reddit.com` are one thing. Simple eTLD+1 heuristic with a short list of two-part public suffixes (`co.uk`, `com.au`…); no full PSL in v1.
- **Visit log**: `{ ts, domain, reflex: bool }`, local only, pruned after 48h. Full URLs are not kept in the log; only the current attempt carries its URL so the pause page can continue to it.
- **Reflex signal.** A visit is a *reflex* when it arrives with `transitionType` of `typed`, `generated` (omnibox autocomplete), or `auto_bookmark`, or when the tab was a fresh new-tab page immediately before. A visit reached by clicking a link on another site, or from a search result, is not a reflex. Both browsers expose this through `webNavigation.onCommitted`. The purest form of the loop is a typed visit that lands on the **bare root path** (`reddit.com/`, not `reddit.com/r/adops/comments/…`); the detector records `root: bool` alongside `reflex` so this can be weighted later, but v1 thresholds use `reflex` only.
- **Site versus visit.** The same domain can be both. Reddit as a reflex at 2:47pm and reddit for ad research at 10am are the same registrable domain and different behaviors. The detector never decides a *site* is bad; it decides a *pattern of visits* is a loop. That's why arrival type matters more than domain name, and why "this is work" is scoped and temporary rather than a permanent whitelist.
- **Trigger** (defaults, tunable in options, revisit after two weeks of real data):
  - 3 or more reflex visits to the same domain within 60 minutes, **or**
  - 5 or more visits of any kind to the same domain within 60 minutes.
- **Watched.** Once a domain trips, it is *watched* until midnight: every further visit that day gets the pause page with a running count, caught cleanly before the page loads. The interrupt on the tripping visit itself lands a moment after navigation starts, so the site may flash briefly. Accepted for v1.
- **Answers and their consequences.**
  - *Yes* — continue, pass for `passMinutes`. Logged. For a mixed site like reddit, *Yes* with an intent typed in ("checking the adops campaign") is the intended path: a 20-second pause on a legitimate visit is the cost, and the site is never whitelisted.
  - *This is work* — puts a host on an **ignore list for 30 days.** Offered in two situations: on the **first** interrupt when the trip came from the any-visit threshold with a majority of non-reflex visits (you keep *arriving* there from links and notifications, which is what a tool looks like), and otherwise after the second *Yes* on the same domain in a day. The ignore is scoped to the **exact hostname** of the tripping visit when that hostname differs from the registrable domain (`ads.reddit.com` is work; `reddit.com` still counts), and to the registrable domain otherwise (`atlassian.net`). Without this, Jira and Gmail trip the detector on day one and the whole thing gets uninstalled.
  - *No* — close the tab. Logged. The domain stays watched.
  - *Not today* — domain is walled until midnight and added to the default list, so future sessions enforce it without asking. This is how the list gets built.
- **Sessions and detection are independent.** Detection runs always, sessions or not. A session walls *listed* domains only. A detection interrupt stays a question even during a session, because the detector can be wrong and there is no exit from a wall; the difference is that during a session *Not today* walls the domain immediately with the session's end time, and the intent field is required before *Yes* enables.
- **What it is not:** it is not a time-on-site tracker, it is not a productivity score, and it never phones home. It watches for one shape and asks one question.

**Deliberately not in v1:** streaks, social features, iOS companion, sync, Safari, machine learning of any kind. The detector is two thresholds and a clock.

## 4. Architecture

```
presence/
├── Package.swift                 SwiftPM; Xcode can open it directly later
├── Sources/
│   ├── PresenceCore/             shared: Blocklist, Session, Schedule, Attempt, JSON store, XPC protocol
│   ├── Presence/                 SwiftUI menu bar app (MenuBarExtra)
│   └── PresenceDaemon/           root launchd daemon (SMAppService), XPC server
│       ├── Enforcer.swift        protocol: apply(hosts:), clear()
│       ├── HostsEnforcer.swift   v1 backend
│       └── SessionLock.swift     root-owned session state; source of truth for "is a session on"
├── Extension/                    WebExtension, one codebase, two manifests
│   ├── manifest.chrome.json      MV3, declarativeNetRequest
│   ├── manifest.firefox.json     MV3 with Firefox gecko keys
│   ├── background.js             webNavigation listener → loop detector → interrupt
│   ├── lib/loop.js               pure: detect(visits, now, config) → trip | null
│   └── block.html / block.js     the pause page
├── NativeHost/                   native messaging host manifests for Chrome + Firefox
├── Tests/
├── scripts/                      bundle.sh (assemble .app from SwiftPM build), sign.sh, install-daemon.sh
└── docs/                         ARCHITECTURE.md, THREAT-MODEL.md
```

**Why the daemon owns the session, not the app.** If the app owns it, quitting the app ends the session. The daemon runs as root under launchd with `KeepAlive`, holds a root-only session file, refuses `clear()` before `endsAt`, re-applies hosts every ~5s in case they were edited, and flushes DNS (`dscacheutil -flushcache`, `killall -HUP mDNSResponder`) on every apply. Deleting the app does not stop the daemon. This is SelfControl's model and the reason it has a reputation.

**Schedules live in the daemon too.** The daemon evaluates the schedule on a timer and opens sessions itself, so a schedule fires even if the menu bar app isn't running.

**Extension ↔ app.** Native messaging host so the block page can read live session state and log attempts. Chrome and Firefox both support native messaging on macOS; the host manifest goes in different directories for each. If the host is unreachable the extension degrades to a cached copy of the lists.

**Stack:** Swift 6.3, SwiftUI, **macOS 26 Tahoe minimum** (John doesn't care about older OSes; this frees us to use the latest SMAppService, MenuBarExtra, and Observation APIs without fallbacks). Built with SwiftPM plus a bundling script so it works without Xcode. No Electron/Tauri.

## 5. Bypass resistance (what "hard" means here)

We are not defending against a determined sysadmin. We are defending against *you at 2:47pm*, a much weaker adversary that still needs every 10-second escape route closed:

- Quit app → daemon keeps running. ✅
- Force-quit daemon → launchd restarts it. ✅
- Reboot → launchd starts it, session file persists. ✅
- Edit `/etc/hosts` → re-asserted within 5s. ✅
- Change system time → session stores a monotonic deadline and a wall-clock deadline; the later one wins. ✅
- Disable browser extension → the wall still holds. ✅
- Use Brave or Safari instead → hosts is system-wide. ✅
- Firefox / Chrome DNS-over-HTTPS → both check hosts first (verify in phase 1; if wrong, the extension's redirect rule still catches it). ⚠️
- `sudo` your way out → possible with hosts. Acceptable for v1; NE closes it later. ⚠️
- Uninstall → not possible during a session; uninstaller refuses. ✅

No emergency exit. Ever. (John's call, §8 Q5.)

## 6. Phases

Order flipped on 2026-09-02: the extension ships first because it's the only layer that can run on John's managed work Mac (§9). The daemon comes second and is where the "hard" guarantee lives.

**Phase 0 — Setup** ✅ (this commit)
- Repo scaffold: plan, handoff spec, README, MIT license, `.gitignore`, repo `CLAUDE.md`.
- Later, in the background: install Xcode from the App Store (required for phase 3 only, ~15 GB).

**Phase 1 — The mirror: standalone extension** — daily-driver for John. Full spec: `docs/HANDOFF-extension.md`.
- WebExtension for Chrome and Firefox from one codebase, plain JS, no bundler.
- **Loop detection** over `webNavigation` events: visit log, reflex signal, two thresholds, watched-until-midnight, ignore list. This is the heart of phase 1 and gets built first.
- Pause page with count and span, the question, intent prompt, countdown, and the three answers (Yes / No / Not today).
- Blocklists (empty by default, fed by "Not today") with wall/friction modes, schedules, start-now sessions, all stored in the extension for now.
- Attempt log, a Loops view, and a Today popup.
- Unit tests for loop detection, registrable-domain extraction, host matching, schedule evaluation, and rule generation with `node:test`.
- Known limitation, accepted: disable-able in two clicks. The daemon fixes that.

**Phase 2 — The wall: menu bar app + daemon**
- SwiftPM project, menu bar app, root daemon via SMAppService, hosts enforcer, session lock, schedule evaluator moves here, re-assert loop, DNS flush.
- Native messaging host so the extension reads session state from the daemon and stops being the source of truth.
- Tests: reboot survival, change-the-clock, delete-the-app, Firefox DoH, Chrome Secure DNS.
- Runs on a non-managed Mac, or on the work Mac only after IT signs off.

**Phase 3 — Real enforcement (needs Developer account + entitlement)**
- `NEFilterDataProvider` system extension, hostname filtering. Requires Xcode.
- Enforcer swap behind the same protocol. Hosts stays as fallback.

**Phase 4 — Polish**
- Onboarding, first-run permission walkthrough (Login Items approval, extension install), list import/export.

**Phase 5 — Public release** (blocked on a $99/yr Apple Developer account)
- Developer ID signing + notarization. Without it, Gatekeeper will refuse the app on other people's Macs; this is non-negotiable for public distribution.
- Notarized DMG, Sparkle auto-updates, landing page, GitHub Releases. MIT license.
- Mac App Store is **not** a target: the hosts approach is impossible in the sandbox.

## 7. Risks

- **Entitlement never granted / no Developer account.** Then hosts+extension is the product. SelfControl has shipped that way for 15 years. Fine.
- **DoH in Firefox/Chrome bypasses hosts.** Expected not to, but verify first thing. Fallback is the extension.
- **Chrome/Firefox connection reuse.** Existing connections to a blocked host can survive a few minutes after a session starts. The extension's redirect rule catches these.
- **Root daemon in a public app.** Must be small, auditable, take no network input, and have an XPC interface of ~4 methods. Threat model documented.
- **This is a managed work laptop.** See §9.
- **Detector false positives.** Frequent legitimate sites (Jira, Gmail, GitHub, the company app) will trip the thresholds. Mitigations: reflex weighting, the 30-day hostname-scoped ignore offered early for tool-shaped trips, and tunable thresholds. Mixed sites (reddit for research or ads) are handled by *Yes* with an intent, not by ignoring. If it still nags, the product fails by being uninstalled, so this gets watched closely in the first two weeks. We deliberately do **not** ask "which sites are for work" upfront: arrival type is better evidence than the user's guess, and an upfront list misses the next tool the same way a blocklist misses the next distraction.
- **Detector false negatives.** A loop across several sites (reddit → twitter → reddit) is not caught per-domain. Out of scope for v1; log it and see if it's real.
- **`webNavigation` transition types differ between Chrome and Firefox.** Chrome reports `typed`/`generated`/`auto_bookmark` reliably; Firefox's coverage is less complete. If Firefox under-reports, the new-tab-origin signal carries the reflex weight there. Verify empirically in phase 1.

## 8. Decisions (from interview, 2026-09-02)

| # | Question | Answer |
|---|---|---|
| 1 | Browsers | **Firefox + Chrome.** Safari out of scope, so iCloud Private Relay is a non-issue. Brave is installed and gets the Chrome extension for free. |
| 2 | Wall vs friction | **Both.** Wall during sessions, friction outside. |
| 3 | Discord desktop app | **Yes**, goes dark during sessions. Free with hosts. |
| 4 | Schedules | **Schedules first**, in phase 1. Daemon-owned. |
| 5 | Emergency exit | **None.** |
| 6 | Apple Developer account | **No.** Phase 1–2 use local ad-hoc signing for John's Mac only. Account needed for phase 3 and 5. |
| 7 | License | **MIT.** |
| 8 | macOS | **Tahoe (26.6).** Minimum target macOS 26. |
| 9 | How sites get blocked | **Learned, not prescripted.** No onboarding question about problem sites. The extension detects the same-site-again loop behaviorally and asks "is this what you need to be doing?"; lists are built from the answers. Cmd+T is one trigger, not the definition. (Added 2026-09-02.) |

## 9. Blocker: this is a company-managed Mac

Findings on the dev machine (2026-09-02):

- MDM enrolled via JumpCloud (user-approved).
- SentinelOne network monitoring system extension active.
- JumpCloud Endpoint Security system extension active.
- John is a local admin, so the daemon *can* be installed.
- Xcode not installed; Command Line Tools with Swift 6.3.3 only.

Why it matters: a root launchd daemon that rewrites `/etc/hosts` every 5 seconds and flushes DNS is, behaviorally, indistinguishable from malware to an EDR. SentinelOne may quarantine it, alert IT, or both. Separately, installing unmanaged root daemons on a work device may be against policy regardless of whether the tooling notices.

Options:

1. **Build and run it here anyway.** Loop in IT first. Best experience, real risk of a support ticket with your name on it.
2. **Develop here, enforce on a personal Mac.** Full design, zero policy risk. Only works if a personal Mac exists.
3. **Layer 2 only on this machine.** Browser extension with friction mode, no daemon. Catches the reflex and counts attempts but is disable-able in two clicks. Real detox value, not SelfControl-grade. The daemon still gets built and tested for the public release.

**Decision (2026-09-02): option 3.** Extension first, standalone. The daemon is built as phase 2 and runs wherever policy allows. The extension is designed so that the daemon can later become its source of truth for session state without a rewrite (see the `SessionSource` seam in the handoff spec).
