// Presence background: Chrome MV3 service worker / Firefox MV3 background script.
// One file for both; nothing service-worker-only in here.
//
// Pipeline: webNavigation.onCommitted → registrableDomain → ignored? pass? →
// arrival? (origin domain differs, or none — same-site depth is skipped) →
// log visit → watched? interrupt : detect() → trip? watch + rebuild rules +
// interrupt. Rules (declarativeNetRequest dynamic) are recomputed from
// storage whenever lists / watched / walled / passes / ignored change.

import { browser } from "./lib/browser.js";
import * as store from "./lib/store.js";
import * as watch from "./lib/watch.js";
import { createSessionSource } from "./lib/session.js";
import { buildRules, rulesSignature } from "./lib/rules.js";
import { detect, isReflex, isRootUrl, isArrival } from "./lib/loop.js";
import { registrableDomain, normalizeHost, hostMatches } from "./lib/hosts.js";
import { nextLocalMidnight, startOfLocalDay } from "./lib/schedule.js";
import { prune as pruneAttempts } from "./lib/attempts.js";

const BLOCK_PATH = "src/block/block.html";
const VISIT_RETENTION_MS = 48 * 3_600_000;
const ALARM_TICK = "presence:tick";
const ALARM_MIDNIGHT = "presence:midnight";

const extensionOrigin = browser.runtime.getURL("");
const blockPageUrl = browser.runtime.getURL(BLOCK_PATH);

// Previous URL per tab, in memory. Does not need to survive a worker restart;
// we seed it from open tabs on boot so restarts don't make everything a reflex.
const prevUrlByTab = new Map();

let lastRulesSignature = null;
let rebuildTimer = null;
let queue = Promise.resolve();

const session = createSessionSource({ onChange: () => rebuildRules() });

function serialize(fn) {
  queue = queue.then(fn).catch((err) => console.error("[presence]", err));
  return queue;
}

// ---------------------------------------------------------------- rules

export async function rebuildRules() {
  const now = Date.now();
  const { lists, watched, walled, passes, ignored } = await store.getMany([
    "lists",
    "watched",
    "walled",
    "passes",
    "ignored",
  ]);
  const rules = buildRules(lists, { watched, walled, passes, ignored, now, blockPageUrl });
  const sig = rulesSignature(rules);
  if (sig === lastRulesSignature) return false;
  const existing = await browser.declarativeNetRequest.getDynamicRules();
  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
  lastRulesSignature = sig;
  return true;
}

function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    serialize(rebuildRules);
  }, 50);
}

// ---------------------------------------------------------------- boot

async function seedPrevUrls() {
  try {
    const tabs = await browser.tabs.query({});
    for (const t of tabs) if (t.id != null && t.url) prevUrlByTab.set(t.id, t.url);
  } catch (err) {
    console.warn("[presence] could not seed tab urls", err);
  }
}

async function midnightReset(now = Date.now()) {
  await watch.clearWatched();
  await watch.pruneWalled(now);
  await watch.pruneIgnored(now);
  const { visits, attempts, meta } = await store.getMany(["visits", "attempts", "meta"]);
  await store.setMany({
    visits: visits.filter((v) => v.ts > now - VISIT_RETENTION_MS),
    attempts: pruneAttempts(attempts, now),
    meta: { ...meta, watchDay: startOfLocalDay(now) },
  });
  lastRulesSignature = null;
  await rebuildRules();
}

async function scheduleAlarms(now = Date.now()) {
  await browser.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  // +1s so the alarm lands on the new day, not the last ms of the old one.
  await browser.alarms.create(ALARM_MIDNIGHT, { when: nextLocalMidnight(now) + 1000 });
}

async function boot() {
  const now = Date.now();
  await store.init(now);
  const meta = await store.get("meta");
  if (!meta.watchDay || meta.watchDay < startOfLocalDay(now)) {
    // We slept through midnight (or first run): reset as if the alarm fired.
    await midnightReset(now);
  } else {
    const visits = await store.get("visits");
    const pruned = visits.filter((v) => v.ts > now - VISIT_RETENTION_MS);
    if (pruned.length !== visits.length) await store.set("visits", pruned);
    lastRulesSignature = null;
    await rebuildRules();
  }
  await seedPrevUrls();
  await scheduleAlarms(now);
}

browser.runtime.onInstalled.addListener(() => serialize(boot));
browser.runtime.onStartup.addListener(() => serialize(boot));
// A service worker can be restarted on an event without onStartup firing.
serialize(boot);

// ---------------------------------------------------------------- alarms

browser.alarms.onAlarm.addListener((alarm) => {
  serialize(async () => {
    const now = Date.now();
    if (alarm.name === ALARM_MIDNIGHT) {
      await midnightReset(now);
      await browser.alarms.create(ALARM_MIDNIGHT, { when: nextLocalMidnight(now) + 1000 });
      return;
    }
    if (alarm.name === ALARM_TICK) {
      const meta = await store.get("meta");
      if (!meta.watchDay || meta.watchDay < startOfLocalDay(now)) {
        await midnightReset(now);
      }
      await session.expirePasses();
      await watch.pruneWalled(now);
      // Session state (schedule edges) changes nothing in the rules themselves;
      // the pause page reads it live. Still recompute in case passes expired.
      await rebuildRules();
    }
  });
});

// ---------------------------------------------------------------- storage

store.onChange((changes) => {
  const keys = Object.keys(changes);
  if (keys.some((k) => ["lists", "watched", "walled", "passes", "ignored"].includes(k))) {
    scheduleRebuild();
  }
});

// ---------------------------------------------------------------- tabs

browser.tabs.onRemoved.addListener((tabId) => prevUrlByTab.delete(tabId));

function interruptUrl(url, domain, tripped) {
  // `u` is last and unencoded so the pause page can take the raw remainder.
  return `${blockPageUrl}?reason=loop&d=${encodeURIComponent(domain)}${tripped ? "&t=1" : ""}&u=${url}`;
}

/** Parse our own block page URL back into { reason, domain, host, url, tripped }. */
function parseBlockUrl(href) {
  const q = href.indexOf("?");
  if (q === -1) return null;
  const qs = href.slice(q + 1);
  const uIdx = qs.indexOf("u=");
  const head = uIdx === -1 ? qs : qs.slice(0, uIdx);
  const url = uIdx === -1 ? null : qs.slice(uIdx + 2);
  const params = new URLSearchParams(head);
  return {
    reason: params.get("reason"),
    domain: params.get("d") || params.get("h"),
    tripped: params.get("t") === "1",
    url,
  };
}

async function hasPass(host, now) {
  const passes = await session.getPasses();
  return passes.some((p) => p.until > now && hostMatches(host, p.host));
}

/** Registrable domain of an http(s) origin URL, or null (non-http, unparseable, no origin). */
function originDomainOf(origin) {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return registrableDomain(normalizeHost(u.hostname));
  } catch {
    return null;
  }
}

/**
 * Where did this tab's navigation come from? If the tab already has a
 * previous URL (`prev`), that's the origin and this is an ordinary same-tab
 * navigation. Otherwise the tab may have just been spawned by a link on
 * another page (target="_blank", cmd-click): read `openerTabId` and use the
 * opener's page as the origin, marking `openedByPage` so `isReflex` doesn't
 * treat the empty previous-URL as a Cmd+T reflex. A genuine Cmd+T tab has no
 * opener, so it keeps its existing reflex behavior.
 */
async function resolveVisitContext(tabId, prev) {
  if (prev) return { originDomain: originDomainOf(prev), openedByPage: false };
  let openerTabId = null;
  try {
    const tab = await browser.tabs.get(tabId);
    openerTabId = tab && tab.openerTabId != null ? tab.openerTabId : null;
  } catch (err) {
    openerTabId = null;
  }
  if (openerTabId == null) return { originDomain: null, openedByPage: false };
  let origin = prevUrlByTab.get(openerTabId) || null;
  if (!origin) {
    try {
      const openerTab = await browser.tabs.get(openerTabId);
      origin = (openerTab && openerTab.url) || null;
    } catch (err) {
      origin = null;
    }
  }
  return { originDomain: originDomainOf(origin), openedByPage: true };
}

// ---------------------------------------------------------------- navigation

async function onCommitted(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const now = Date.now();
  const prev = prevUrlByTab.get(details.tabId);
  prevUrlByTab.set(details.tabId, details.url);

  // Our own pause page landing via a DNR redirect: log the visit it intercepted.
  if (details.url.startsWith(extensionOrigin)) {
    if (!details.url.startsWith(blockPageUrl)) return;
    const b = parseBlockUrl(details.url);
    if (!b || b.tripped || !b.url) return; // tripping visit was already logged from the site
    let u;
    try {
      u = new URL(b.url);
    } catch {
      return;
    }
    const host = normalizeHost(u.hostname);
    const domain = registrableDomain(host);
    if (!domain) return;
    const { originDomain, openedByPage } = await resolveVisitContext(details.tabId, prev);
    if (!isArrival(domain, originDomain)) return; // depth within the same site, not a new arrival
    const reflex = isReflex(details, prev, { openedByPage });
    await appendVisit({ ts: now, domain, host, reflex, root: isRootUrl(u) });
    return;
  }

  let u;
  try {
    u = new URL(details.url);
  } catch {
    return;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  const host = normalizeHost(u.hostname);
  const domain = registrableDomain(host);
  if (!domain) return;

  if (await watch.isIgnoredNow(domain, host, now)) return;
  if (await hasPass(host, now)) return; // continuing after Yes / Continue, or inside a pass

  const { originDomain, openedByPage } = await resolveVisitContext(details.tabId, prev);
  if (!isArrival(domain, originDomain)) return; // depth within the same site, not a new arrival

  const reflex = isReflex(details, prev, { openedByPage });
  const root = isRootUrl(u);
  const visits = await appendVisit({ ts: now, domain, host, reflex, root });

  if (await watch.isWatched(domain)) {
    // A watched domain normally lands on the pause page via its DNR rule
    // before this fires. If it got here (rule not yet applied), interrupt now.
    await interrupt(details.tabId, details.url, domain, false);
    return;
  }

  const detector = await store.get("detector");
  const trip = detect(visits, domain, now, detector);
  if (!trip) return;
  await watch.watch(trip, host, now);
  await rebuildRules();
  await interrupt(details.tabId, details.url, domain, true);
}

async function appendVisit(v) {
  const visits = await store.get("visits");
  visits.push(v);
  await store.set("visits", visits);
  return visits;
}

async function interrupt(tabId, url, domain, tripped) {
  try {
    await browser.tabs.update(tabId, { url: interruptUrl(url, domain, tripped) });
  } catch (err) {
    console.warn("[presence] could not interrupt tab", tabId, err);
  }
}

browser.webNavigation.onCommitted.addListener((details) => {
  serialize(() => onCommitted(details));
});

// ---------------------------------------------------------------- messages

async function closeTab(tab) {
  if (!tab || tab.id == null) return;
  const inWindow = await browser.tabs.query({ windowId: tab.windowId });
  if (inWindow.length <= 1) {
    // Only tab: open a fresh one first so the window survives.
    await browser.tabs.create({ windowId: tab.windowId, active: true });
  }
  await browser.tabs.remove(tab.id);
}

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case "sync": {
      await rebuildRules();
      return { ok: true };
    }
    case "getState": {
      return session.getState();
    }
    case "interrupt": {
      // Pause page is showing. Count it once per show for watched domains.
      const { domain, host, reason, tripped } = msg;
      let entry = await watch.getWatchedEntry(domain);
      if (reason === "loop" && entry && !tripped) entry = await watch.bump(domain, host);
      return { watched: entry };
    }
    case "answer": {
      await watch.setLastAnswer(msg.domain, msg.answer);
      return { ok: true };
    }
    case "notToday": {
      const now = Date.now();
      const state = await session.getState();
      const until = Math.max(nextLocalMidnight(now), state.active && state.endsAt ? state.endsAt : 0);
      await store.addToDefaultList(msg.domain);
      await watch.wall(msg.domain, until);
      await watch.setLastAnswer(msg.domain, "notToday");
      await rebuildRules();
      return { ok: true, until };
    }
    case "ignore": {
      await watch.ignore(msg.match, msg.scope, msg.until, Date.now());
      await watch.unwatch(msg.domain);
      await rebuildRules();
      return { ok: true };
    }
    case "closeTab": {
      await closeTab(sender.tab);
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown message" };
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serialize(async () => {
    try {
      sendResponse(await handleMessage(msg, sender));
    } catch (err) {
      console.error("[presence] message failed", msg, err);
      sendResponse({ ok: false, error: String(err && err.message) });
    }
  });
  return true; // async response
});
