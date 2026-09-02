// Typed get/set over storage.local with defaults and migrations.
// This module imports the browser namespace; it is NOT pure.

import { browser } from "./browser.js";
import { DEFAULT_DETECTOR } from "./loop.js";
import { DEFAULT_SCHEDULE } from "./schedule.js";

export const SCHEMA_VERSION = 1;
export const DEFAULT_LIST_ID = "default";

// Nothing here names a site. The default list is empty on purpose.
export const DEFAULTS = Object.freeze({
  meta: { schemaVersion: SCHEMA_VERSION, installedAt: null },
  visits: [],
  detector: { ...DEFAULT_DETECTOR },
  watched: [],
  ignored: [],
  walled: [],
  lists: [{ id: DEFAULT_LIST_ID, name: "Not today", mode: "wall", patterns: [], enabled: true }],
  schedule: { enabled: DEFAULT_SCHEDULE.enabled, windows: DEFAULT_SCHEDULE.windows.map((w) => ({ ...w, days: [...w.days] })) },
  session: null,
  friction: { delaySeconds: 20, passMinutes: 10, dailyPassLimit: 3 },
  passes: [],
  attempts: [],
});

export const KEYS = Object.freeze(Object.keys(DEFAULTS));

// Keys covered by export/import. Not visits, not attempts, not session.
export const EXPORT_KEYS = Object.freeze(["detector", "ignored", "lists", "schedule", "friction"]);

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Read one key, falling back to its default. */
export async function get(key) {
  const res = await browser.storage.local.get(key);
  const v = res[key];
  return v === undefined ? clone(DEFAULTS[key]) : v;
}

/** Read several keys at once → object. */
export async function getMany(keys) {
  const res = await browser.storage.local.get(keys);
  const out = {};
  for (const k of keys) out[k] = res[k] === undefined ? clone(DEFAULTS[k]) : res[k];
  return out;
}

/** Everything, with defaults filled in. */
export async function getAll() {
  return getMany(KEYS);
}

export async function set(key, value) {
  await browser.storage.local.set({ [key]: value });
}

export async function setMany(obj) {
  await browser.storage.local.set(obj);
}

/**
 * Seed defaults for any missing key and run migrations. Idempotent; call on
 * install and on every startup.
 */
export async function init(now = Date.now()) {
  const all = await browser.storage.local.get(null);
  const patch = {};
  for (const k of KEYS) {
    if (all[k] === undefined) patch[k] = clone(DEFAULTS[k]);
  }
  const meta = all.meta || patch.meta;
  if (!meta.installedAt) {
    patch.meta = { ...meta, installedAt: now, schemaVersion: SCHEMA_VERSION };
  }
  // Migrations go here, keyed on meta.schemaVersion. None yet.
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    patch.meta = { ...(patch.meta || meta), schemaVersion: SCHEMA_VERSION };
  }
  // Guarantee the default list exists (never re-seed its patterns).
  const lists = all.lists || patch.lists;
  if (!lists.some((l) => l.id === DEFAULT_LIST_ID)) {
    patch.lists = [clone(DEFAULTS.lists[0]), ...lists];
  }
  if (Object.keys(patch).length) await browser.storage.local.set(patch);
}

/** Subscribe to storage.local changes: cb(changes) where changes = { key: { oldValue, newValue } }. */
export function onChange(cb) {
  const handler = (changes, area) => {
    if (area === "local") cb(changes);
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}

/** The default list, guaranteed present after init(). */
export async function getDefaultList() {
  const lists = await get("lists");
  return lists.find((l) => l.id === DEFAULT_LIST_ID) || lists[0];
}

/** Add a pattern to the default list if missing. */
export async function addToDefaultList(pattern) {
  const lists = await get("lists");
  const idx = lists.findIndex((l) => l.id === DEFAULT_LIST_ID);
  const list = idx === -1 ? clone(DEFAULTS.lists[0]) : lists[idx];
  if (!list.patterns.includes(pattern)) list.patterns.push(pattern);
  if (idx === -1) lists.unshift(list);
  else lists[idx] = list;
  await set("lists", lists);
  return list;
}

/** A plain { get, set } pair for the pure attempts helpers. */
export const storeApi = { get, set };
