// The pause page. Two variants by `reason` (loop | list), each shaped by
// session state. Session state comes only through SessionSource.

import { browser } from "../lib/browser.js";
import * as store from "../lib/store.js";
import * as watch from "../lib/watch.js";
import { createSessionSource } from "../lib/session.js";
import { registrableDomain, normalizeHost, hostMatches } from "../lib/hosts.js";
import { ordinal } from "../lib/loop.js";
import { formatClock, nextLocalMidnight } from "../lib/schedule.js";
import * as attempts from "../lib/attempts.js";

const $ = (id) => document.getElementById(id);
const el = {
  page: $("page"),
  domain: $("domain"),
  count: $("count"),
  question: $("question"),
  intent: $("intent"),
  wallLine: $("wallLine"),
  loopActions: $("loopActions"),
  yes: $("yes"),
  no: $("no"),
  notToday: $("notToday"),
  listActions: $("listActions"),
  cont: $("continue"),
  passesLeft: $("passesLeft"),
  ignoreRow: $("ignoreRow"),
  ignoreLabel: $("ignoreLabel"),
  ignore1h: $("ignore1h"),
  ignoreToday: $("ignoreToday"),
  ignore30d: $("ignore30d"),
};

const session = createSessionSource({
  onChange: () => browser.runtime.sendMessage({ type: "sync" }).catch(() => {}),
});

const send = (msg) => browser.runtime.sendMessage(msg);

/** Parse our own URL. `u` is the raw remainder after "u=", unencoded. */
function parseSelf(href) {
  const q = href.indexOf("?");
  const qs = q === -1 ? "" : href.slice(q + 1);
  const uIdx = qs.indexOf("u=");
  const head = uIdx === -1 ? qs : qs.slice(0, uIdx);
  const rawUrl = uIdx === -1 ? null : qs.slice(uIdx + 2);
  const p = new URLSearchParams(head);
  return {
    reason: p.get("reason") === "list" ? "list" : "loop",
    domainParam: p.get("d") || p.get("h"),
    tripped: p.get("t") === "1",
    url: rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null,
  };
}

function minutesBetween(a, b) {
  return Math.max(0, Math.round(Math.abs(b - a) / 60_000));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function countdown(button, seconds, label, onDone) {
  let left = Math.max(0, Math.round(seconds));
  const tick = () => {
    if (left <= 0) {
      button.textContent = label(null);
      onDone();
      return;
    }
    button.textContent = label(left);
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

async function main() {
  const now = Date.now();
  const self = parseSelf(location.href);
  const host = self.url ? normalizeHost(new URL(self.url).hostname) : normalizeHost(self.domainParam || "");
  const domain = registrableDomain(host) || normalizeHost(self.domainParam || "") || host;
  const originalUrl = self.url || `https://${host || domain}/`;

  const [state, friction, allAttempts, walled, lists] = await Promise.all([
    session.getState(),
    store.get("friction"),
    store.get("attempts"),
    watch.walledEntry(domain, now),
    store.get("lists"),
  ]);

  el.domain.textContent = domain;

  // Log the attempt now; amend outcome/intent on answer.
  const walledUntil = walled ? walled.until : 0;
  const listsMatching = lists.filter((l) => l.enabled && (l.patterns || []).some((p) => hostMatches(host, p)));
  const anyWallList = listsMatching.some((l) => l.mode === "wall");
  // Wall when a session is on and a wall-mode list matches, or when "Not today" walled it.
  // A friction-mode list stays friction even during a session.
  const isWalled = self.reason === "list" && ((state.active && anyWallList) || walledUntil > now);
  const mode = state.active || walledUntil > now ? "wall" : "friction";
  const attempt = await attempts.log(store.storeApi, {
    ts: now,
    domain,
    url: originalUrl,
    reason: self.reason,
    mode,
    outcome: "blocked",
    intent: null,
  });

  const amend = (patch) => attempts.amend(store.storeApi, attempt.ts, domain, patch);
  const intentValue = () => (el.intent.value.trim() ? el.intent.value.trim() : null);

  // Save intent after 5s idle so a wall page still captures it.
  let idle = null;
  el.intent.addEventListener("input", () => {
    clearTimeout(idle);
    idle = setTimeout(() => amend({ intent: intentValue() }), 5000);
  });

  el.page.hidden = false;
  if (self.reason === "loop") {
    await renderLoop({ now, state, friction, allAttempts, domain, host, originalUrl, tripped: self.tripped, amend, intentValue });
  } else {
    await renderList({ now, state, friction, allAttempts, domain, originalUrl, isWalled, walledUntil, amend, intentValue });
  }
}

// ---------------------------------------------------------------- loop

async function renderLoop({ now, state, friction, allAttempts, domain, host, originalUrl, tripped, amend, intentValue }) {
  const { watched } = await send({ type: "interrupt", reason: "loop", domain, host, tripped });
  const count = watched ? watched.count : 1;

  if (tripped && watched && watched.firstTs) {
    const mins = minutesBetween(watched.firstTs, now);
    el.count.textContent = mins < 1 ? `${ordinal(count)} time in the last minute.` : `${ordinal(count)} time in the last ${plural(mins, "minute")}.`;
  } else {
    el.count.textContent = `${ordinal(count)} time today.`;
  }

  el.question.hidden = false;
  el.intent.placeholder = "What for?";
  el.intent.required = state.active;
  el.loopActions.hidden = false;
  el.intent.focus();

  // Yes: countdown, then requires an intent during a session.
  let countdownDone = false;
  const refreshYes = () => {
    el.yes.disabled = !countdownDone || (state.active && !intentValue());
  };
  el.intent.addEventListener("input", refreshYes);
  countdown(el.yes, friction.delaySeconds, (s) => (s == null ? "Yes" : `Yes · ${s}s`), () => {
    countdownDone = true;
    refreshYes();
  });

  // "Stop asking": tool-shaped trip, or the second Yes today. Three durations,
  // all backed by the `ignored` mechanism — never a pass, per PLAN.md §3a.
  const yesToday = attempts.yesCountToday(allAttempts, domain, now);
  if ((watched && watched.toolShaped) || yesToday >= 2) {
    const hostScoped = host && host !== domain;
    const label = hostScoped ? host : domain;
    el.ignoreLabel.textContent = `Stop asking about ${label}`;
    el.ignoreRow.hidden = false;
    const durationButtons = [
      [el.ignore1h, "1h"],
      [el.ignoreToday, "today"],
      [el.ignore30d, "30d"],
    ];
    const disableAll = () => durationButtons.forEach(([btn]) => (btn.disabled = true));
    for (const [btn, key] of durationButtons) {
      btn.addEventListener("click", async () => {
        disableAll();
        await amend({ outcome: "passed", intent: "work" });
        const until = watch.untilForDuration(key, Date.now());
        // Background rebuilds rules before replying, so the navigation goes through.
        await send({
          type: "ignore",
          match: hostScoped ? host : domain,
          scope: hostScoped ? "host" : "domain",
          domain,
          until,
        });
        location.replace(originalUrl);
      });
    }
  }

  el.yes.addEventListener("click", async () => {
    if (el.yes.disabled) return;
    el.yes.disabled = true;
    await amend({ outcome: "passed", intent: intentValue() });
    await send({ type: "answer", domain, answer: "yes" });
    await session.grantPass(domain, { countsTowardLimit: false });
    location.replace(originalUrl);
  });

  el.no.addEventListener("click", async () => {
    el.no.disabled = true;
    await amend({ outcome: "closed", intent: intentValue() });
    await send({ type: "answer", domain, answer: "no" });
    await send({ type: "closeTab" });
  });

  el.notToday.addEventListener("click", async () => {
    el.notToday.disabled = true;
    await amend({ outcome: "notToday", intent: intentValue() });
    const res = await send({ type: "notToday", domain, url: originalUrl });
    showWall({ now, until: res && res.until ? res.until : nextLocalMidnight(now) });
  });
}

// ---------------------------------------------------------------- list

async function renderList({ now, state, friction, allAttempts, domain, originalUrl, isWalled, walledUntil, amend, intentValue }) {
  const priorToday = attempts.todayForDomain(allAttempts, domain, now).filter((a) => a.reason === "list");
  const n = priorToday.length + 1;
  const last = priorToday.length ? priorToday[priorToday.length - 1] : null;
  const sinceLast = last ? ` ${plural(minutesBetween(last.ts, now), "minute")} since the last one.` : "";
  el.count.textContent = `${ordinal(n)} time today.${sinceLast}`;

  el.intent.placeholder = "What were you about to do?";
  el.intent.focus();

  if (isWalled) {
    const until = Math.max(state.active && state.endsAt ? state.endsAt : 0, walledUntil || 0);
    showWall({ now, until });
    return;
  }

  // Friction.
  const budget = await session.passBudget();
  if (budget.limit > 0 && budget.remaining <= 0) {
    el.wallLine.textContent = "No passes left today.";
    el.wallLine.hidden = false;
    return;
  }

  el.listActions.hidden = false;
  if (budget.limit > 0) {
    el.passesLeft.textContent = `${budget.remaining === 1 ? "1 pass" : `${budget.remaining} passes`} left today.`;
    el.passesLeft.hidden = false;
  }

  countdown(el.cont, friction.delaySeconds, (s) => (s == null ? "Continue" : `Continue in ${s}s`), () => {
    el.cont.disabled = false;
  });

  el.cont.addEventListener("click", async () => {
    if (el.cont.disabled) return;
    el.cont.disabled = true;
    const pass = await session.grantPass(domain, { countsTowardLimit: true });
    if (!pass) {
      el.listActions.hidden = true;
      el.wallLine.textContent = "No passes left today.";
      el.wallLine.hidden = false;
      return;
    }
    await amend({ outcome: "passed", intent: intentValue() });
    location.replace(originalUrl);
  });
}

// ---------------------------------------------------------------- wall

function showWall({ now, until }) {
  el.question.hidden = true;
  el.loopActions.hidden = true;
  el.listActions.hidden = true;
  el.ignoreRow.hidden = true;
  const midnight = nextLocalMidnight(now);
  if (until >= midnight) el.wallLine.textContent = "Back tomorrow.";
  else el.wallLine.textContent = `Session ends at ${formatClock(until)}.`;
  el.wallLine.hidden = false;
}

main().catch((err) => {
  console.error("[presence] pause page failed", err);
  el.page.hidden = false;
  el.count.textContent = "Something went wrong loading this page.";
});
