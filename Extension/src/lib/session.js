// SessionSource: the one seam between the extension and "is a session on".
//
// Phase 1 has one implementation, StorageSessionSource, backed by
// storage.local plus the schedule. Phase 2 adds NativeSessionSource backed by
// the root daemon over native messaging. Every consumer (background, pause
// page, popup, options) talks to this interface and never to storage directly
// for session state.
//
// state = { active: boolean, endsAt: number|null, source: "schedule"|"manual"|null, startedAt: number|null }
//
// There is no stopSession(). There will not be one. See PLAN.md §5 and §8 Q5.

import * as store from "./store.js";
import { activeWindow } from "./schedule.js";
import { passesUsedToday } from "./attempts.js";

export class SessionSource {
  /** @returns {Promise<{active:boolean, endsAt:number|null, source:string|null, startedAt:number|null}>} */
  async getState() {
    throw new Error("not implemented");
  }
  /** Start (or extend) a manual session ending at `endsAt` (epoch ms). */
  async startSession(_endsAt) {
    throw new Error("not implemented");
  }
  /**
   * Grant a temporary pass for `host`. Returns { until } or null if the daily
   * limit is exhausted (only enforced when `countsTowardLimit` is true).
   */
  async grantPass(_host, _opts) {
    throw new Error("not implemented");
  }
  /** Active passes: [{ host, until }]. */
  async getPasses() {
    throw new Error("not implemented");
  }
  /** Friction settings + how many passes are left today. */
  async passBudget() {
    throw new Error("not implemented");
  }
}

export class StorageSessionSource extends SessionSource {
  /**
   * @param {{ onChange?: () => Promise<void>|void, now?: () => number }} [opts]
   *   onChange runs after any write so the caller can rebuild rules (background)
   *   or ask the background to (UI pages) before navigating.
   */
  constructor(opts = {}) {
    super();
    this.onChange = opts.onChange || (() => {});
    this.now = opts.now || (() => Date.now());
  }

  async getState() {
    const now = this.now();
    const { session, schedule } = await store.getMany(["session", "schedule"]);
    const win = activeWindow(schedule, now);
    const manual = session && typeof session.endsAt === "number" && session.endsAt > now ? session : null;
    if (!win && !manual) return { active: false, endsAt: null, source: null, startedAt: null };
    if (win && manual) {
      // Overlap: the later end wins.
      return manual.endsAt >= win.endsAt
        ? { active: true, endsAt: manual.endsAt, source: "manual", startedAt: manual.startedAt ?? null }
        : { active: true, endsAt: win.endsAt, source: "schedule", startedAt: win.startsAt };
    }
    if (manual) return { active: true, endsAt: manual.endsAt, source: "manual", startedAt: manual.startedAt ?? null };
    return { active: true, endsAt: win.endsAt, source: "schedule", startedAt: win.startsAt };
  }

  async startSession(endsAt) {
    const now = this.now();
    if (typeof endsAt !== "number" || !(endsAt > now)) throw new Error("endsAt must be in the future");
    const existing = await store.get("session");
    const next =
      existing && existing.endsAt > now
        ? { startedAt: existing.startedAt ?? now, endsAt: Math.max(existing.endsAt, endsAt) }
        : { startedAt: now, endsAt };
    await store.set("session", next);
    await this.onChange();
    return this.getState();
  }

  async getPasses() {
    const now = this.now();
    return (await store.get("passes")).filter((p) => p.until > now);
  }

  async passBudget() {
    const now = this.now();
    const { friction, attempts } = await store.getMany(["friction", "attempts"]);
    const used = passesUsedToday(attempts, now);
    const limit = friction.dailyPassLimit || 0;
    return {
      ...friction,
      used,
      limit,
      remaining: limit === 0 ? Infinity : Math.max(0, limit - used),
    };
  }

  /**
   * grantPass(host, { minutes, countsTowardLimit })
   * Loop-page "Yes" does not count toward the daily list-friction limit; the
   * limit is a friction setting for listed sites.
   */
  async grantPass(host, opts = {}) {
    const now = this.now();
    const { friction, passes } = await store.getMany(["friction", "passes"]);
    if (opts.countsTowardLimit) {
      const budget = await this.passBudget();
      if (budget.remaining <= 0) return null;
    }
    const minutes = opts.minutes ?? friction.passMinutes ?? 10;
    const until = now + minutes * 60_000;
    const live = passes.filter((p) => p.until > now && p.host !== host);
    live.push({ host, until });
    await store.set("passes", live);
    await this.onChange();
    return { host, until };
  }

  /** Drop expired passes. Returns true if anything changed. */
  async expirePasses() {
    const now = this.now();
    const passes = await store.get("passes");
    const live = passes.filter((p) => p.until > now);
    if (live.length !== passes.length) {
      await store.set("passes", live);
      return true;
    }
    return false;
  }
}

/** Factory so consumers don't name the implementation. Phase 2 branches here. */
export function createSessionSource(opts) {
  return new StorageSessionSource(opts);
}
