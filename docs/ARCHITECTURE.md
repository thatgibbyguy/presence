# Architecture — Phase 1 extension

One codebase, two manifests (`Extension/manifest.chrome.json`, `Extension/manifest.firefox.json`), plain ES modules, no bundler. Everything under `Extension/src/lib/` except `browser.js`, `store.js`, `watch.js`, and `session.js` is pure and tested under `node --test`.

## Detection pipeline

```
webNavigation.onCommitted (frameId 0)
  │
  ├─ our own block page?  → if it arrived via a DNR redirect (no t=1), log the
  │                          visit it intercepted using the redirect's transitionType
  │
  ├─ http(s) only → registrableDomain(hostname)   hosts.js, eTLD+1 heuristic
  ├─ ignored (domain/host scoped, unexpired)?     → stop
  ├─ active pass covers host?                     → stop (continuing after Yes/Continue)
  ├─ resolve origin: tab's previous URL, or (no    background.js resolveVisitContext():
  │  previous URL) the opener tab's page via        tabs.get(tabId).openerTabId, then
  │  openerTabId → originDomain, openedByPage       prevUrlByTab.get(openerTabId) or tabs.get(openerTabId)
  ├─ isArrival(domain, originDomain)?             → stop if false (same-site depth, not
  │                                                 a new arrival); still records prevUrlByTab
  ├─ reflex = isReflex(details, prevUrlForTab,    loop.js: typed | generated | auto_bookmark | keyword,
  │           { openedByPage })                   or previous tab URL was a new-tab page / none —
  │                                                unless openedByPage suppresses that fallback
  ├─ append { ts, domain, host, reflex, root } to visits
  ├─ watched?                                     → interrupt (tabs.update → block.html?reason=loop)
  └─ detect(visits, domain, now, config)          loop.js: two thresholds, one window
         └─ trip → watch(domain) → rebuildRules() → interrupt (…&t=1)
```

- **Tripping visit**: the site has begun rendering; `tabs.update` swaps in the pause page. A brief flash is accepted.
- **Later visits that day**: `rules.js` emits a `declarativeNetRequest` redirect for each watched domain (priority 1, `reason=loop`), so the pause page lands before the site loads. The DNR redirect fires before `onCommitted`, so the background sees only the block page URL commit and reconstructs the visit from its `u=` parameter.
- **Passes** are `allow` rules at priority 4. **Lists** and **"Not today" walls** are redirects at priority 3 (`reason=list`). A host-scoped "this is work" ignore is an `allow` at priority 2: it beats a loop rule for its registrable domain but never a list wall. Domain-scoped ignores simply suppress the loop rule.
- Rules are recomputed from storage as a whole and swapped with `updateDynamicRules`; ids are an FNV-1a hash of `(kind, key)` into a reserved range so recomputation is idempotent, and a structural signature skips no-op swaps.
- The redirect target puts `u=` **last and unencoded** (`regexSubstitution` with `\1`), and the pause page takes the raw remainder, so an original URL containing `?` or `&` cannot break parsing.

**Midnight.** An alarm at next local midnight clears `watched`, prunes `walled`/`ignored` expiries, prunes `visits` (48h) and `attempts` (30d), and rebuilds rules. `meta.watchDay` guards against a midnight slept through: boot and the minute tick both reset if the stored day is stale. Lists and ignores are untouched.

**Pause page → background messages.** `interrupt` (bump the watched count once per show), `answer`, `notToday` (add to default list, wall until the later of midnight and session end, rebuild), `ignore` (add entry, unwatch, rebuild), `closeTab` (open a fresh tab first if it is the window's last one), `sync` (rebuild rules now; UI pages call this after storage writes so navigation never races the rule swap).

## The `SessionSource` seam (phase 2)

`Extension/src/lib/session.js` defines `SessionSource` with `getState()`, `startSession(endsAt)`, `grantPass(host, opts)`, `getPasses()`, `passBudget()`. Phase 1 ships `StorageSessionSource` (storage.local + `schedule.js`); every consumer, background, pause page, popup, and options, gets one via `createSessionSource(opts)` and never reads session state from storage directly. Phase 2 adds `NativeSessionSource` over native messaging to the daemon and switches the factory. There is deliberately no `stopSession()` on the interface.

`state = { active, endsAt, source: "schedule" | "manual" | null, startedAt }`. A manual session overlapping a schedule window reports the later `endsAt`.

## Storage keys

`meta, visits, detector, watched, ignored, walled, lists, schedule, session, friction, passes, attempts` in `storage.local`; defaults and migrations in `store.js`. The default list "Not today" ships with **no patterns**. Export/import covers `detector, ignored, lists, schedule, friction` only.

## `transitionType` coverage per browser — UNVERIFIED

This build was produced without loading the extension in any browser (managed machine; owner to verify). What the code assumes, from documentation:

| Signal | Chrome | Firefox |
|---|---|---|
| `typed` (address typed) | reported | reported, but reportedly less consistent for omnibox autocompletions |
| `generated` (omnibox suggestion) | reported | may appear as `typed` or `link` |
| `auto_bookmark` | reported | reported |
| `keyword` | reported | rare |
| `link` after a new-tab page | reflex via previous-URL rule (`chrome://newtab/`, `chrome://new-tab-page/`) | reflex via previous-URL rule (`about:newtab`, `about:home`, `about:blank`) |
| `transitionType` on a DNR-redirected commit | assumed to carry the original type | assumed the same |
| `tabs.Tab.openerTabId` set for a tab opened via `target="_blank"` / cmd-click | assumed present per MDN/Chrome docs | assumed present per MDN docs |
| `webNavigation.onCommitted` fires for `chrome://newtab/` / `about:newtab` itself (needed so Cmd+T seeds a previous URL before the next real commit) | assumed yes, but unverified — if it does not fire, `prevUrlByTab` stays unset for a brand-new tab and the tab is still correctly treated as having no previous URL (arrival + reflex fallback both behave the same as if it had fired) | same assumption, same fallback behavior either way |

If Firefox under-reports, the previous-URL rule carries the reflex signal there. Please record actual observed values here after a day of use in each browser (`chrome://extensions` → service worker console; `about:debugging` → Inspect), and note whether the DNR-redirected block page commit kept the original `transitionType`.

Also unverified in a browser: Firefox acceptance of `regexSubstitution` in MV3 dynamic rules, Firefox `background.type: "module"`, and that Firefox prompts host permission via `permissions.request` from the options page.
