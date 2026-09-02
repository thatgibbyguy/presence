# Presence

A macOS tool for people who open the same site over and over without deciding to.

You don't tell Presence which sites are a problem. It notices when you keep going back to the same place in a short span, steps in, and asks: *is this what you need to be doing?* Your answers build the blocklist over time.

Presence is two things, built in this order:

1. **The mirror** — a Chrome/Firefox extension that detects the loop and interrupts it with that question. Outside a focus session, it lets you through if you say yes. During one, sites you've said "not today" to are simply off.
2. **The wall** — a menu bar app and root daemon that makes those sites actually unreachable during a session. No stop button, survives reboots, survives quitting the app. SelfControl's promise, rebuilt for modern macOS.

Status: pre-alpha. Phase 1 (the extension) is in progress. See [PLAN.md](PLAN.md) for the full plan and [docs/HANDOFF-extension.md](docs/HANDOFF-extension.md) for the phase 1 spec.

## Principles

- **No exits.** Once a session is on, it's on. Not a paragraph to type, not a 10-minute delay. If that's too hard, make the session shorter.
- **Nothing prescripted.** No setup wizard asking for your problem sites. Presence learns them by catching you, so it also catches the next one.
- **A pause, not a punishment.** The pause page tells you how many times you've been here in the last hour and asks one question. That's it.
- **Auditable.** The daemon will run as root on your machine. It should be small enough to read in one sitting.

## Install locally (extension, once phase 1 lands)

```bash
scripts/build-extension.sh
```

- **Chrome / Brave:** `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`, then grant site access from the extension's options page. Temporary add-ons are removed when Firefox quits; a signed build comes later.

## License

MIT. See [LICENSE](LICENSE).
