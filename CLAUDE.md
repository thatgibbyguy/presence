# Presence — notes for agents

Read `PLAN.md` first, then the handoff doc for the current phase in `docs/`.

## Current phase

Phase 1: the browser extension. Spec: `docs/HANDOFF-extension.md`. Work happens in `Extension/` and `scripts/`.

## Hard rules

- **No exits from an active session.** No stop button, no snooze, no override, no "emergency" anything. This is the owner's explicit product decision. Do not propose it either.
- The extension talks to session state only through the `SessionSource` interface in `Extension/src/lib/session.js`. Phase 2 swaps the implementation for one backed by a native daemon.
- Plain JS ES modules. No TypeScript, no bundler, no runtime dependencies. Tests use `node:test` only.
- Pure modules under `Extension/src/lib/` (hosts, schedule, rules, attempts helpers) must not import browser APIs, so they stay testable under Node.
- Don't push to the remote unless asked. Commit in logical chunks on `main`.

## Environment facts

- macOS 26 Tahoe, Node 24, Swift 6.3 via Command Line Tools. **No Xcode installed.** Phase 2 uses SwiftPM; phase 3 (Network Extension) will need Xcode.
- This is a company-managed Mac (JumpCloud MDM, SentinelOne). Do not install launchd daemons, edit `/etc/hosts`, or install system extensions on this machine. Phase 2 enforcement work targets a different machine or waits for IT sign-off. See `PLAN.md` §9.
- Chrome, Firefox, and Brave are installed for manual testing.

## Verifying work

```bash
node --test Extension/test
scripts/build-extension.sh
```

Then load `dist/chrome` or `dist/firefox` per the README and walk the phase 1 definition-of-done checklist in the handoff doc.
