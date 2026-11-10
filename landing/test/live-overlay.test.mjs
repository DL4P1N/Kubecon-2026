import { test } from "node:test";
import assert from "node:assert/strict";
import { levelStep, liveRoomRows, liveClusterRows, ROOM_LEVELS, ROOM_LEVEL_STEPS } from "../js/companion-api.js";

test("levelStep maps the three contract levels to 1..3 and anything else to 0", () => {
  assert.equal(ROOM_LEVEL_STEPS, 3);
  assert.deepEqual(["quiet", "some recent check-ins", "many recent check-ins"].map(levelStep), [1, 2, 3]);
  for (const bad of ["", "busy", "Quiet", "constructor", "__proto__", null, undefined, 3, {}]) assert.equal(levelStep(bad), 0);
  assert.equal(Object.isFrozen(ROOM_LEVELS), true);
});

test("liveRoomRows: API order, display names, unknown levels and bad rows dropped, no counts invented", () => {
  const rows = liveRoomRows(
    [{ room: "keynote", level: "many recent check-ins" }, { room: "Hall B", level: "quiet" }, { room: "room-a", level: "weird" }, { room: "", level: "quiet" }, null, { level: "quiet" }, { room: "room-c", level: "some recent check-ins" }],
    { keynote: "Keynote", "room-c": "Room C" },
  );
  assert.deepEqual(rows, [
    { room: "keynote", name: "Keynote", level: "many recent check-ins", step: 3, text: "Many" },
    { room: "Hall B", name: "Hall B", level: "quiet", step: 1, text: "Quiet" },
    { room: "room-c", name: "Room C", level: "some recent check-ins", step: 2, text: "Some" },
  ]);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["level", "name", "room", "step", "text"]);
  assert.deepEqual(liveRoomRows(undefined), []);
  assert.deepEqual(liveRoomRows("x"), []);
  assert.equal(liveRoomRows([{ room: "constructor", level: "quiet" }], {})[0].name, "constructor"); // no prototype lookups
});

test("liveClusterRows: top 6 by count, other kept apart, folded count only when positive", () => {
  const clusters = [
    ...[3, 9, 7, 5, 12, 6, 8, 10].map((count, i) => ({ id: `t${i}`, label: `Topic ${i}`, count })),
    { id: "other", label: "Other (groups under 5)", count: 4 },
  ];
  const out = liveClusterRows({ clusters, suppressedGroups: 3 });
  assert.deepEqual(out.rows.map((r) => r.count), [12, 10, 9, 8, 7, 6]);
  assert.equal(out.rows.length, 6);
  assert.deepEqual(out.other, { count: 4 });
  assert.equal(out.suppressedGroups, 3);

  const none = liveClusterRows({ clusters: [{ id: "a", label: "A", count: 5 }], suppressedGroups: 0 });
  assert.equal(none.other, null);
  assert.equal(none.suppressedGroups, 0);
  assert.equal(liveClusterRows({ clusters: [{ id: "a", label: "A", count: 5 }] }).suppressedGroups, 0);
  assert.equal(liveClusterRows({ clusters: [{ id: "a", label: "A", count: 5 }], suppressedGroups: "7" }).suppressedGroups, 0);
});

test("liveClusterRows: null when there is nothing to draw", () => {
  for (const bad of [null, undefined, {}, { clusters: [] }, { clusters: "x" }, { clusters: [{ id: "other", label: "o", count: 9 }] }, { clusters: [{ id: "a", label: "A", count: "5" }] }]) {
    assert.equal(liveClusterRows(bad), null);
  }
});
