// Options page. Writes go to storage directly (these are settings, not session
// state); the background rebuilds rules on storage change. Nothing here can
// end an active session.

import { browser } from "../lib/browser.js";
import * as store from "../lib/store.js";
import * as watch from "../lib/watch.js";
import { validateWindow } from "../lib/schedule.js";
import { normalizeHost, registrableDomain } from "../lib/hosts.js";

const $ = (id) => document.getElementById(id);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function flash(key, text = "Saved") {
  const span = document.querySelector(`[data-saved="${key}"]`);
  if (!span) return;
  span.textContent = text;
  setTimeout(() => (span.textContent = ""), 2000);
}

const sync = () => browser.runtime.sendMessage({ type: "sync" }).catch(() => {});

// ---------------------------------------------------------------- permission (Firefox)

async function checkPermission() {
  if (!browser.permissions || !browser.permissions.contains) return;
  try {
    const ok = await browser.permissions.contains({ origins: ["<all_urls>"] });
    $("permBanner").hidden = ok;
  } catch {
    $("permBanner").hidden = true;
  }
}

$("grantPerm").addEventListener("click", async () => {
  try {
    await browser.permissions.request({ origins: ["<all_urls>"] });
  } catch (err) {
    console.warn("[presence] permission request failed", err);
  }
  await checkPermission();
  await sync();
});

// ---------------------------------------------------------------- detector

async function loadDetector() {
  const d = await store.get("detector");
  $("windowMinutes").value = d.windowMinutes;
  $("reflexThreshold").value = d.reflexThreshold;
  $("anyThreshold").value = d.anyThreshold;
}

async function saveDetector() {
  const num = (id, min) => Math.max(min, Math.round(Number($(id).value)) || min);
  await store.set("detector", {
    windowMinutes: num("windowMinutes", 1),
    reflexThreshold: num("reflexThreshold", 1),
    anyThreshold: num("anyThreshold", 1),
  });
  await loadDetector();
  flash("detector");
}

// ---------------------------------------------------------------- ignored

async function loadIgnored() {
  const ignored = await store.get("ignored");
  const tbody = $("ignoredTable").querySelector("tbody");
  tbody.textContent = "";
  if (!ignored.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "help";
    td.textContent = "Nothing ignored. The pause page offers this when a site looks like a tool.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  const now = Date.now();
  for (const e of [...ignored].sort((a, b) => a.match.localeCompare(b.match))) {
    const tr = document.createElement("tr");
    const cells = [
      e.match,
      e.scope === "host" ? "host" : "domain",
      e.until ? (e.until > now ? new Date(e.until).toLocaleDateString() : "expired") : "never",
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    const td = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      await watch.unignore(e.match, e.scope);
      await loadIgnored();
      await sync();
    });
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

$("ignoreAdd").addEventListener("click", async () => {
  const match = normalizeHost($("ignoreMatch").value);
  if (!match || registrableDomain(match) === null) return;
  const scope = $("ignoreScope").value === "host" ? "host" : "domain";
  const days = Math.max(1, Math.round(Number($("ignoreDays").value)) || 30);
  await watch.ignore(scope === "domain" ? registrableDomain(match) : match, scope, days);
  $("ignoreMatch").value = "";
  await loadIgnored();
  await sync();
});

// ---------------------------------------------------------------- lists

let listsDraft = [];

function renderLists() {
  const root = $("lists");
  root.textContent = "";
  for (const list of listsDraft) {
    const card = document.createElement("div");
    card.className = "list-card";

    const head = document.createElement("div");
    head.className = "head";

    const name = document.createElement("input");
    name.type = "text";
    name.value = list.name;
    name.placeholder = "List name";
    name.addEventListener("input", () => (list.name = name.value));

    const mode = document.createElement("select");
    for (const [v, label] of [["wall", "Wall during sessions, friction outside"], ["friction", "Friction always"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      mode.appendChild(o);
    }
    mode.value = list.mode === "friction" ? "friction" : "wall";
    mode.addEventListener("change", () => (list.mode = mode.value));

    const enabled = document.createElement("label");
    enabled.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = list.enabled !== false;
    cb.addEventListener("change", () => (list.enabled = cb.checked));
    enabled.append(cb, " Enabled");

    head.append(name, mode, enabled);
    if (list.id !== store.DEFAULT_LIST_ID) {
      const rm = document.createElement("button");
      rm.className = "btn small";
      rm.type = "button";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        listsDraft = listsDraft.filter((l) => l !== list);
        renderLists();
      });
      head.appendChild(rm);
    }

    const ta = document.createElement("textarea");
    ta.placeholder = "one site per line, e.g. example.com";
    ta.value = (list.patterns || []).join("\n");
    ta.spellcheck = false;
    ta.addEventListener("input", () => {
      list.patterns = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    });

    card.append(head, ta);
    if (list.id === store.DEFAULT_LIST_ID) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "Filled in by Not today. You can add sites by hand too.";
      card.appendChild(note);
    }
    root.appendChild(card);
  }
}

async function loadLists() {
  listsDraft = await store.get("lists");
  renderLists();
}

async function saveLists() {
  const clean = listsDraft.map((l) => ({
    id: l.id,
    name: (l.name || "").trim() || "Untitled",
    mode: l.mode === "friction" ? "friction" : "wall",
    enabled: l.enabled !== false,
    patterns: [...new Set((l.patterns || []).map(normalizeHost).filter((p) => p && registrableDomain(p) !== null))],
  }));
  await store.set("lists", clean);
  await loadLists();
  await sync();
  flash("lists");
}

$("addList").addEventListener("click", () => {
  listsDraft.push({ id: crypto.randomUUID(), name: "New list", mode: "wall", patterns: [], enabled: true });
  renderLists();
});

// ---------------------------------------------------------------- schedule

let scheduleDraft = { enabled: true, windows: [] };

function renderSchedule() {
  $("scheduleEnabled").checked = !!scheduleDraft.enabled;
  const tbody = $("scheduleTable").querySelector("tbody");
  tbody.textContent = "";
  scheduleDraft.windows.forEach((w, idx) => {
    const tr = document.createElement("tr");

    const daysTd = document.createElement("td");
    const days = document.createElement("div");
    days.className = "days";
    DAY_NAMES.forEach((label, d) => {
      const l = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = w.days.includes(d);
      cb.addEventListener("change", () => {
        w.days = cb.checked ? [...new Set([...w.days, d])].sort() : w.days.filter((x) => x !== d);
      });
      l.append(cb, label);
      days.appendChild(l);
    });
    daysTd.appendChild(days);

    const startTd = document.createElement("td");
    const start = document.createElement("input");
    start.type = "time";
    start.value = w.start;
    start.addEventListener("change", () => (w.start = start.value));
    startTd.appendChild(start);

    const endTd = document.createElement("td");
    const end = document.createElement("input");
    end.type = "time";
    end.value = w.end;
    end.addEventListener("change", () => (w.end = end.value));
    endTd.appendChild(end);

    const rmTd = document.createElement("td");
    const rm = document.createElement("button");
    rm.className = "btn small";
    rm.type = "button";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      scheduleDraft.windows.splice(idx, 1);
      renderSchedule();
    });
    rmTd.appendChild(rm);

    tr.append(daysTd, startTd, endTd, rmTd);
    tbody.appendChild(tr);
  });
}

async function loadSchedule() {
  scheduleDraft = await store.get("schedule");
  renderSchedule();
}

async function saveSchedule() {
  scheduleDraft.enabled = $("scheduleEnabled").checked;
  const errors = scheduleDraft.windows.map(validateWindow).filter(Boolean);
  const errEl = $("scheduleError");
  if (errors.length) {
    errEl.textContent = errors[0];
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  await store.set("schedule", {
    enabled: scheduleDraft.enabled,
    windows: scheduleDraft.windows.map((w) => ({ days: [...w.days].sort(), start: w.start, end: w.end })),
  });
  await loadSchedule();
  flash("schedule");
}

$("addWindow").addEventListener("click", () => {
  scheduleDraft.windows.push({ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00" });
  renderSchedule();
});

// ---------------------------------------------------------------- friction

async function loadFriction() {
  const f = await store.get("friction");
  $("delaySeconds").value = f.delaySeconds;
  $("passMinutes").value = f.passMinutes;
  $("dailyPassLimit").value = f.dailyPassLimit;
}

async function saveFriction() {
  const num = (id, min) => Math.max(min, Math.round(Number($(id).value)) || 0);
  await store.set("friction", {
    delaySeconds: num("delaySeconds", 0),
    passMinutes: Math.max(1, num("passMinutes", 1)),
    dailyPassLimit: num("dailyPassLimit", 0),
  });
  await loadFriction();
  flash("friction");
}

// ---------------------------------------------------------------- export / import

$("export").addEventListener("click", async () => {
  const data = await store.getMany(store.EXPORT_KEYS);
  const blob = new Blob([JSON.stringify({ presence: 1, ...data }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `presence-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
});

$("import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const patch = {};
    for (const k of store.EXPORT_KEYS) if (data[k] !== undefined) patch[k] = data[k];
    if (!Object.keys(patch).length) throw new Error("no recognised keys");
    await store.setMany(patch);
    await store.init();
    await loadAll();
    await sync();
    $("importStatus").textContent = `Imported ${Object.keys(patch).join(", ")}.`;
  } catch (err) {
    $("importStatus").textContent = `Import failed: ${err.message}`;
  }
  e.target.value = "";
});

// ---------------------------------------------------------------- wiring

const savers = { detector: saveDetector, lists: saveLists, schedule: saveSchedule, friction: saveFriction };
for (const b of document.querySelectorAll("[data-save]")) {
  b.addEventListener("click", () => savers[b.dataset.save]().catch((err) => console.error(err)));
}

async function loadAll() {
  await Promise.all([loadDetector(), loadIgnored(), loadLists(), loadSchedule(), loadFriction()]);
}

checkPermission();
loadAll().catch((err) => console.error("[presence] options failed", err));
