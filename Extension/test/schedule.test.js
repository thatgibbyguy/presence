import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeWindow,
  validateWindow,
  parseHHMM,
  nextLocalMidnight,
  startOfLocalDay,
} from "../src/lib/schedule.js";

// Local-time construction so the tests hold in any zone.
// 2026-09-02 is a Wednesday (day 3).
const at = (h, m = 0, s = 0) => new Date(2026, 8, 2, h, m, s).getTime();
const sat = (h, m = 0) => new Date(2026, 8, 5, h, m).getTime(); // Saturday

const schedule = {
  enabled: true,
  windows: [
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00" },
    { days: [1, 2, 3, 4, 5], start: "13:00", end: "17:00" },
  ],
};

test("inside a window returns its endsAt", () => {
  const w = activeWindow(schedule, at(10, 30));
  assert.ok(w);
  assert.equal(w.endsAt, at(12, 0));
  assert.equal(w.startsAt, at(9, 0));
});

test("start boundary is active", () => {
  assert.ok(activeWindow(schedule, at(9, 0)));
  assert.equal(activeWindow(schedule, at(9, 0)).endsAt, at(12, 0));
});

test("end boundary is inactive", () => {
  assert.equal(activeWindow(schedule, at(12, 0)), null);
  assert.equal(activeWindow(schedule, at(17, 0)), null);
  // one second before the end is still inside
  assert.ok(activeWindow(schedule, at(11, 59, 59)));
});

test("gap between windows is inactive", () => {
  assert.equal(activeWindow(schedule, at(12, 30)), null);
});

test("wrong day is inactive", () => {
  assert.equal(activeWindow(schedule, sat(10, 0)), null);
});

test("disabled schedule is inactive", () => {
  assert.equal(activeWindow({ ...schedule, enabled: false }, at(10, 0)), null);
  assert.equal(activeWindow(null, at(10, 0)), null);
});

test("overlapping windows return the latest endsAt", () => {
  const s = {
    enabled: true,
    windows: [
      { days: [3], start: "09:00", end: "12:00" },
      { days: [3], start: "10:00", end: "15:00" },
    ],
  };
  assert.equal(activeWindow(s, at(11, 0)).endsAt, at(15, 0));
  assert.equal(activeWindow(s, at(9, 30)).endsAt, at(12, 0));
});

test("invalid windows are skipped, not fatal", () => {
  const s = {
    enabled: true,
    windows: [
      { days: [3], start: "22:00", end: "02:00" }, // crosses midnight → invalid
      { days: [3], start: "09:00", end: "12:00" },
    ],
  };
  assert.equal(activeWindow(s, at(23, 0)), null);
  assert.ok(activeWindow(s, at(10, 0)));
});

test("validateWindow", () => {
  assert.equal(validateWindow({ days: [1], start: "09:00", end: "12:00" }), null);
  assert.match(validateWindow({ days: [1], start: "12:00", end: "09:00" }), /before end/);
  assert.match(validateWindow({ days: [1], start: "09:00", end: "09:00" }), /before end/);
  assert.match(validateWindow({ days: [], start: "09:00", end: "12:00" }), /day/);
  assert.match(validateWindow({ days: [7], start: "09:00", end: "12:00" }), /0–6/);
  assert.match(validateWindow({ days: [1], start: "9am", end: "12:00" }), /HH:MM/);
});

test("parseHHMM", () => {
  assert.equal(parseHHMM("09:00"), 540);
  assert.equal(parseHHMM("9:05"), 545);
  assert.equal(parseHHMM("24:00"), 1440);
  assert.equal(parseHHMM("24:01"), null);
  assert.equal(parseHHMM("25:00"), null);
  assert.equal(parseHHMM("nope"), null);
});

test("midnight helpers", () => {
  const now = at(14, 33);
  assert.equal(startOfLocalDay(now), new Date(2026, 8, 2).getTime());
  assert.equal(nextLocalMidnight(now), new Date(2026, 8, 3).getTime());
  assert.equal(nextLocalMidnight(new Date(2026, 8, 2).getTime()), new Date(2026, 8, 3).getTime());
});
