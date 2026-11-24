// The shared room: what's playing, where it is, and what's queued.
// Pure state changes with the clock passed in, so tests can drive it.

export type Item = {
  id: string;
  videoId: string;
  title: string;
  addedBy: string;
};

export type RoomState = {
  current: Item | null;
  queue: Item[];
  playing: boolean;
  // Position in seconds at the server time `updatedAt` (milliseconds).
  position: number;
  updatedAt: number;
};

export const MAX_QUEUE = 200;

export function emptyRoom(now: number): RoomState {
  return { current: null, queue: [], playing: false, position: 0, updatedAt: now };
}

export function positionAt(state: RoomState, now: number): number {
  if (!state.current) {
    return 0;
  }
  if (!state.playing) {
    return state.position;
  }
  return state.position + (now - state.updatedAt) / 1000;
}

function cleanPosition(position: unknown): number {
  const n = Number(position);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(n, 24 * 3600);
}

// A client stamps an action with its estimate of server time. Trust it only
// within the last two seconds, so a bad clock can't move playback far.
function cleanTime(at: unknown, now: number): number {
  const n = Number(at);
  if (!Number.isFinite(n) || n > now || n < now - 2000) {
    return now;
  }
  return n;
}

export function play(state: RoomState, position: unknown, at: unknown, now: number): RoomState {
  if (!state.current) {
    return state;
  }
  return {
    ...state,
    playing: true,
    position: cleanPosition(position),
    updatedAt: cleanTime(at, now),
  };
}

export function pause(state: RoomState, position: unknown, at: unknown, now: number): RoomState {
  if (!state.current) {
    return state;
  }
  return {
    ...state,
    playing: false,
    position: cleanPosition(position),
    updatedAt: cleanTime(at, now),
  };
}

export function seek(state: RoomState, position: unknown, at: unknown, now: number): RoomState {
  if (!state.current) {
    return state;
  }
  return { ...state, position: cleanPosition(position), updatedAt: cleanTime(at, now) };
}

// A new item starts right away when nothing is loaded. It starts paused, so
// whoever added it presses play when both people are ready.
export function add(state: RoomState, item: Item, now: number): RoomState {
  if (!state.current) {
    return { ...state, current: item, playing: false, position: 0, updatedAt: now };
  }
  if (state.queue.length >= MAX_QUEUE) {
    return state;
  }
  return { ...state, queue: [...state.queue, item] };
}

// Moves to the next queued item. Playback keeps playing if it was playing.
export function next(state: RoomState, now: number, keepPlaying = state.playing): RoomState {
  const [upNext, ...rest] = state.queue;
  return {
    current: upNext ?? null,
    queue: rest,
    playing: upNext ? keepPlaying : false,
    position: 0,
    updatedAt: now,
  };
}

// Both browsers report the end of a video. Only the first report for the
// current item advances, so the queue doesn't skip twice.
export function ended(state: RoomState, itemId: unknown, now: number): RoomState {
  if (!state.current || state.current.id !== itemId) {
    return state;
  }
  return next(state, now, true);
}

export function remove(state: RoomState, itemId: unknown): RoomState {
  return { ...state, queue: state.queue.filter((i) => i.id !== itemId) };
}

export function playNow(state: RoomState, itemId: unknown, now: number): RoomState {
  const item = state.queue.find((i) => i.id === itemId);
  if (!item) {
    return state;
  }
  return {
    current: item,
    queue: state.queue.filter((i) => i.id !== itemId),
    playing: true,
    position: 0,
    updatedAt: now,
  };
}

const ID = /^[A-Za-z0-9_-]{11}$/;

// Accepts a bare video ID or any common YouTube link, including youtu.be,
// /shorts/, /embed/, /live/ and music.youtube.com.
export function parseVideoId(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const text = input.trim();
  if (ID.test(text)) {
    return text;
  }
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    candidate = url.searchParams.get("v");
    if (!candidate) {
      const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      candidate = m ? m[2] : null;
    }
  }
  return candidate && ID.test(candidate) ? candidate : null;
}
