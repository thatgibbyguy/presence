# Presence — Plan

A macOS app that breaks the Cmd+T → reddit / discord / facebook doom loop. Bespoke first, public later.

Status: v0.3 (2026-09-02). Interview done, decisions locked in §8. §9 resolved: extension first. Phase 1 handoff spec is in `docs/HANDOFF-extension.md`.

---

## 1. What we're actually fixing

The loop is not "I decided to browse Reddit." It's a reflex: hands open a new tab and type `r` before the brain is involved. So the product has two jobs:

1. **Enforcement** — when a session is on, the sites are unreachable. Not "hard to reach." Unreachable. Quitting the app, rebooting, editing config: none of it works until the timer ends. This is SelfControl's core promise and why it works.
2. **Interruption** — when a session is *not* on, still catch the reflex. A block page that says "3rd time today, 11:42 since the last one, what did you come here for?" and makes you wait ~20 seconds before letting you through. Hard blocks alone get uninstalled; friction is what retrains the hand.

Everything else (schedules, stats) is in service of those two.

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
- **Layer 2, the mirror:** WebExtension for Chrome and Firefox. Block page, attempt counting, intent prompt, friction delay. Present whether or not a hard session is on.

## 3. Product surface (v1)

**Menu bar app** (no Dock icon). Click it:

- **Schedule** (primary, per John's answer): recurring sessions, e.g. Mon–Fri 9:00–12:00 and 13:00–17:00. When a scheduled session begins there is no stop button. The menu shows the countdown and nothing else.
- **Start session now**: 25m / 1h / 2h / until end of day / custom. Same no-stop rule.
- **Lists**: named blocklists. Default list seeded with reddit, discord, facebook, plus their alt/CDN hosts (`old.reddit.com`, `redd.it`, `discordapp.com`, `discord.gg`, `fb.com`, `m.facebook.com`, `messenger.com`…). Each list has a mode:
  - **Wall** — hard block during sessions.
  - **Friction** — always on, never hard-blocked. Show the pause page, allow through after N seconds, optional daily pass limit.
  - Default list is **wall during sessions, friction outside them.**
- **Today**: attempts blocked, attempts let through, longest gap between attempts. Small, honest, not gamified.

**Block page** (extension): the URL you tried, count today, a one-line prompt ("What were you about to do?"), a countdown if friction mode, and for wall mode a single line: "Session ends at 2:15pm." No unlock button anywhere.

**Deliberately not in v1:** streaks, social features, iOS companion, sync, Safari.

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
│   ├── background.js
│   └── block.html / block.js     the mirror
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
- Blocklists with wall/friction modes, schedules, start-now sessions, all stored in the extension for now.
- Block page with intent prompt, friction countdown, temporary pass, daily pass limit.
- Attempt log and a Today popup.
- Unit tests for host matching, schedule evaluation, and rule generation with `node:test`.
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
