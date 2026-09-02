# Presence

A macOS site blocker for people who open a new tab and type `r` before they've decided anything.

Presence is two things, built in this order:

1. **The mirror** — a Chrome/Firefox extension that catches the reflex. Outside a focus session it makes you pause and say what you came for. During one, it just says when the session ends.
2. **The wall** — a menu bar app and root daemon that makes the sites actually unreachable during a session. No stop button, survives reboots, survives quitting the app. SelfControl's promise, rebuilt for modern macOS.

Status: pre-alpha. Phase 1 (the extension) is in progress. See [PLAN.md](PLAN.md) for the full plan and [docs/HANDOFF-extension.md](docs/HANDOFF-extension.md) for the phase 1 spec.

## Principles

- **No exits.** Once a session is on, it's on. Not a paragraph to type, not a 10-minute delay. If that's too hard, make the session shorter.
- **A pause, not a punishment.** The block page tells you how many times you've been here today and asks what you wanted. That's it.
- **Auditable.** The daemon will run as root on your machine. It should be small enough to read in one sitting.

## Install locally (extension, once phase 1 lands)

```bash
scripts/build-extension.sh
```

- **Chrome / Brave:** `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`, then grant site access from the extension's options page. Temporary add-ons are removed when Firefox quits; a signed build comes later.

## License

MIT. See [LICENSE](LICENSE).
