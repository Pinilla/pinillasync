import { test } from "node:test";
import assert from "node:assert/strict";
import * as room from "../src/room.ts";

const item = (id: string) => ({ id, videoId: "dQw4w9WgXcQ", title: id, addedBy: "a" });

test("parseVideoId reads common link shapes", () => {
  const id = "dQw4w9WgXcQ";
  for (const input of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&si=abc`,
    `https://youtu.be/${id}?si=abc`,
    `youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) assert.equal(room.parseVideoId(input), id, input);
  for (const bad of ["", "hello", "https://example.com/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch?v=short", 42])
    assert.equal(room.parseVideoId(bad), null, String(bad));
});

test("the first item loads paused, later ones queue", () => {
  let s = room.emptyRoom(0);
  s = room.add(s, item("a"), 0);
  assert.equal(s.current?.id, "a");
  assert.equal(s.playing, false);
  s = room.add(s, item("b"), 0);
  assert.deepEqual(s.queue.map((i) => i.id), ["b"]);
});

test("position advances only while playing", () => {
  let s = room.add(room.emptyRoom(0), item("a"), 0);
  s = room.play(s, 10, 1000, 1000);
  assert.equal(room.positionAt(s, 4000), 13);
  s = room.pause(s, 13, 4000, 4000);
  assert.equal(room.positionAt(s, 9000), 13);
});

test("a client timestamp is trusted only within two seconds", () => {
  let s = room.add(room.emptyRoom(0), item("a"), 0);
  assert.equal(room.play(s, 0, 9500, 10000).updatedAt, 9500);
  assert.equal(room.play(s, 0, 1000, 10000).updatedAt, 10000);
  assert.equal(room.play(s, 0, 20000, 10000).updatedAt, 10000);
  assert.equal(room.play(s, -5, "x", 10000).position, 0);
});

test("ended advances once per item and keeps playing", () => {
  let s = room.add(room.emptyRoom(0), item("a"), 0);
  s = room.add(s, item("b"), 0);
  s = room.add(s, item("c"), 0);
  s = room.ended(s, "a", 5000);
  assert.equal(s.current?.id, "b");
  assert.equal(s.playing, true);
  assert.equal(room.ended(s, "a", 5100), s, "a second report for a is ignored");
});

test("the queue empties to nothing playing", () => {
  let s = room.play(room.add(room.emptyRoom(0), item("a"), 0), 0, 0, 0);
  s = room.next(s, 100);
  assert.equal(s.current, null);
  assert.equal(s.playing, false);
});

test("playNow and remove", () => {
  let s = room.add(room.emptyRoom(0), item("a"), 0);
  s = room.add(s, item("b"), 0);
  s = room.add(s, item("c"), 0);
  s = room.playNow(s, "c", 10);
  assert.equal(s.current?.id, "c");
  assert.equal(s.playing, true);
  assert.deepEqual(s.queue.map((i) => i.id), ["b"]);
  s = room.remove(s, "b");
  assert.deepEqual(s.queue, []);
});
