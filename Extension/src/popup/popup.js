// Popup: session status or start buttons, loops caught today, today's numbers.
// Session state comes only through SessionSource. There is no stop button.

import { browser } from "../lib/browser.js";
import * as store from "../lib/store.js";
import * as watch from "../lib/watch.js";
import { createSessionSource } from "../lib/session.js";
import { formatClock, nextLocalMidnight } from "../lib/schedule.js";
import { summarize } from "../lib/attempts.js";

const $ = (id) => document.getElementById(id);

const session = createSessionSource({
  onChange: () => browser.runtime.sendMessage({ type: "sync" }).catch(() => {}),
});

const ANSWER_LABEL = { yes: "Yes", no: "No", notToday: "Not today" };

function fivePmToday(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 0).getTime();
}

async function start(endsAt) {
  await session.startSession(endsAt);
  await render();
}

async function renderSession() {
  const now = Date.now();
  const state = await session.getState();
  $("sessionActive").hidden = !state.active;
  $("sessionStart").hidden = state.active;
  if (state.active) {
    $("sessionLine").textContent = `Session · ends ${formatClock(state.endsAt)}`;
    $("sessionSource").textContent = state.source === "schedule" ? "Scheduled" : "Manual";
    return;
  }
  $("untilFive").hidden = fivePmToday(now) <= now;
}

async function renderLoops() {
  const watched = await store.get("watched");
  const ul = $("loops");
  ul.textContent = "";
  if (!watched.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing caught today.";
    ul.appendChild(li);
    return;
  }
  for (const w of [...watched].sort((a, b) => b.count - a.count)) {
    const li = document.createElement("li");
    const times = w.count === 1 ? "1 time" : `${w.count} times`;
    const answer = w.lastAnswer ? ` · last answer: ${ANSWER_LABEL[w.lastAnswer] || w.lastAnswer}` : "";
    li.textContent = `${w.domain} · ${times}${answer}`;
    ul.appendChild(li);
  }
}

/** "asking paused until 3:15 PM" / "... until tomorrow" / "... for N days". */
function ignoreDurationLabel(until, now) {
  const midnight = nextLocalMidnight(now);
  if (until < midnight) return `asking paused until ${formatClock(until)}`;
  const twoDaysOut = now + 2 * 86_400_000;
  if (until < twoDaysOut) return "asking paused until tomorrow";
  const days = Math.ceil((until - now) / 86_400_000);
  return `asking paused for ${days} ${days === 1 ? "day" : "days"}`;
}

async function renderIgnored() {
  const now = Date.now();
  const ignored = await watch.getIgnored(now);
  const ul = $("ignored");
  ul.textContent = "";
  if (!ignored.length) {
    ul.hidden = true;
    return;
  }
  ul.hidden = false;
  for (const e of [...ignored].sort((a, b) => a.match.localeCompare(b.match))) {
    const li = document.createElement("li");
    li.textContent = `${e.match} · ${ignoreDurationLabel(e.until, now)}`;
    ul.appendChild(li);
  }
}

function formatGap(ms) {
  if (!ms) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function renderToday() {
  const now = Date.now();
  const { attempts, friction } = await store.getMany(["attempts", "friction"]);
  const s = summarize(attempts, now);
  $("statBlocked").textContent = `${s.blocked} ${s.blocked === 1 ? "attempt" : "attempts"} blocked`;
  const limit = friction.dailyPassLimit || 0;
  $("statPasses").textContent = limit ? `${s.passesUsed} / ${limit} passes used` : `${s.passesUsed} passes used`;
  $("statGap").textContent = `Longest gap between attempts: ${formatGap(s.longestGapMs)}`;
}

async function render() {
  await Promise.all([renderSession(), renderLoops(), renderIgnored(), renderToday()]);
}

for (const b of document.querySelectorAll("[data-minutes]")) {
  b.addEventListener("click", () => start(Date.now() + Number(b.dataset.minutes) * 60_000));
}
$("untilFive").addEventListener("click", () => start(fivePmToday(Date.now())));
$("custom").addEventListener("click", () => {
  $("customRow").hidden = !$("customRow").hidden;
  if (!$("customRow").hidden) $("customMinutes").focus();
});
$("customStart").addEventListener("click", () => {
  const m = Number($("customMinutes").value);
  if (Number.isFinite(m) && m >= 1) start(Date.now() + m * 60_000);
});
$("customMinutes").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("customStart").click();
});
$("options").addEventListener("click", () => browser.runtime.openOptionsPage());

render().catch((err) => console.error("[presence] popup failed", err));
