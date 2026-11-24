// pinillasync: watch and listen to YouTube in sync with a friend.
// One shared room. Serves the page from ../public and syncs over a WebSocket at /ws.

import { createServer } from "node:http";
import { readFile, readdir, writeFile, rename, mkdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import * as room from "./room.ts";
import type { RoomState, Item } from "./room.ts";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3200);
const DATA = process.env.SYNC_DATA ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data");
// Comma-separated list of allowed page origins for the WebSocket. Empty allows any,
// which is what local development wants.
const ORIGINS = (process.env.SYNC_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATE_FILE = join(DATA, "state.json");
const MAX_CLIENTS = 30;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "img-src 'self' https://i.ytimg.com data:",
  "style-src 'self'",
  "connect-src 'self'",
].join("; ");

// ---- state, saved to disk so a restart keeps the queue

let state: RoomState = room.emptyRoom(Date.now());
try {
  const saved = JSON.parse(await readFile(STATE_FILE, "utf8")) as RoomState;
  // Come back paused at the saved spot; nobody is listening after a restart.
  state = {
    ...saved,
    playing: false,
    position: room.positionAt(saved, Date.now()),
    updatedAt: Date.now(),
  };
} catch {
  // No saved state yet.
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave() {
  if (saveTimer) {
    return;
  }
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(DATA, { recursive: true });
      await writeFile(STATE_FILE + ".tmp", JSON.stringify(state));
      await rename(STATE_FILE + ".tmp", STATE_FILE);
    } catch (err) {
      console.error("Saving state failed:", err);
    }
  }, 1000);
}

// ---- titles from YouTube's oEmbed endpoint, which needs no API key

async function lookupTitle(videoId: string): Promise<string | null> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { title?: unknown };
    return typeof body.title === "string" ? body.title.slice(0, 200) : null;
  } catch {
    return null;
  }
}

// ---- HTTP: static files and a health check

const files = new Set(await readdir(PUBLIC));

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  const name = path === "/" ? "index.html" : path.slice(1);
  if (!files.has(name) || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
    return;
  }
  const body = await readFile(join(PUBLIC, name));
  res.writeHead(200, {
    "content-type": TYPES[extname(name)] ?? "application/octet-stream",
    "cache-control": "no-cache",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  });
  res.end(req.method === "HEAD" ? undefined : body);
});

// ---- WebSocket sync

type Client = {
  id: string;
  ws: WebSocket;
  name: string | null;
  drift: number | null;
  status: string;
  messages: number;
};

const clients = new Map<string, Client>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const origin = req.headers.origin ?? "";
  if (
    path !== "/ws" ||
    (ORIGINS.length > 0 && !ORIGINS.includes(origin)) ||
    clients.size >= MAX_CLIENTS
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg: unknown) {
  const text = JSON.stringify(msg);
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(text);
    }
  }
}

function stateMessage() {
  return { type: "state", state, serverTime: Date.now() };
}

function presenceMessage() {
  const users = [...clients.values()]
    .filter((c) => c.name)
    .map((c) => ({ id: c.id, name: c.name, drift: c.drift, status: c.status }));
  return { type: "presence", users };
}

function update(next: RoomState) {
  if (next === state) {
    return;
  }
  state = next;
  broadcast(stateMessage());
  scheduleSave();
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const n = name.replace(/\s+/g, " ").trim().slice(0, 30);
  return n || null;
}

let addChain: Promise<void> = Promise.resolve();

const STATUSES = new Set([
  "playing",
  "paused",
  "buffering",
  "idle",
  "blocked",
  "error",
  "no-api",
  "api-stuck",
  "api-pending",
  "loading-player",
]);

async function handle(c: Client, msg: Record<string, unknown>) {
  const now = Date.now();
  switch (msg.type) {
    case "ping":
      send(c.ws, { type: "pong", t0: msg.t0, serverTime: now });
      return;
    case "hello":
      c.name = cleanName(msg.name);
      broadcast(presenceMessage());
      return;
    case "report":
      c.drift =
        typeof msg.drift === "number" && Number.isFinite(msg.drift)
          ? Math.round(msg.drift * 1000) / 1000
          : null;
      c.status = typeof msg.status === "string" && STATUSES.has(msg.status) ? msg.status : "idle";
      broadcast(presenceMessage());
      return;
    case "play":
      return update(room.play(state, msg.position, msg.at, now));
    case "pause":
      return update(room.pause(state, msg.position, msg.at, now));
    case "seek":
      return update(room.seek(state, msg.position, msg.at, now));
    case "next":
      return update(room.next(state, now));
    case "ended":
      return update(room.ended(state, msg.itemId, now));
    case "remove":
      return update(room.remove(state, msg.itemId));
    case "playNow":
      return update(room.playNow(state, msg.itemId, now));
    case "add": {
      const videoId = room.parseVideoId(msg.input);
      if (!videoId) {
        send(c.ws, { type: "error", message: "That doesn't look like a YouTube link." });
        return;
      }
      // Look titles up in parallel, but add items in the order they arrived.
      const title = lookupTitle(videoId);
      const addedBy = c.name ?? "someone";
      addChain = addChain.then(async () => {
        const item: Item = { id: randomUUID(), videoId, title: (await title) ?? videoId, addedBy };
        update(room.add(state, item, Date.now()));
      });
      return addChain;
    }
  }
}

wss.on("connection", (ws) => {
  const c: Client = { id: randomUUID(), ws, name: null, drift: null, status: "idle", messages: 0 };
  clients.set(c.id, c);
  send(ws, { type: "welcome", id: c.id });
  send(ws, stateMessage());
  send(ws, presenceMessage());

  ws.on("message", (data) => {
    // A browser sends a few messages a second at most. Drop anything flooding.
    if (++c.messages > 60) {
      ws.close(1008, "Too many messages");
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg && typeof msg === "object") {
      handle(c, msg as Record<string, unknown>).catch((err) =>
        console.error("Message failed:", err),
      );
    }
  });

  ws.on("close", () => {
    clients.delete(c.id);
    broadcast(presenceMessage());
  });
});

setInterval(() => {
  for (const c of clients.values()) {
    c.messages = 0;
  }
}, 1000).unref();

server.listen(PORT, HOST, () => console.log(`pinillasync listening on http://${HOST}:${PORT}`));
