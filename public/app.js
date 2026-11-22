// pinillasync browser side.
//
// The server holds one room state: the current item, whether it's playing, and
// the position at a server timestamp. Each browser estimates its clock offset
// to the server, works out where playback should be right now, and keeps its
// YouTube player there. Small drift is fixed by nudging the playback rate,
// large drift by seeking. Play, pause and seek on the player are sent to the
// server, which tells everyone.

const $ = (s) => document.querySelector(s);
const YT_UNSTARTED = -1, YT_ENDED = 0, YT_PLAYING = 1, YT_PAUSED = 2, YT_BUFFERING = 3, YT_CUED = 5;

let ws = null;
let myId = null;
let state = null;
let offset = 0;           // server clock minus local clock, in ms
const pings = [];         // recent {rtt, offset} samples
let player = null;
let playerReady = false;
let apiReady = false;
let joined = false;
let loadedItem = null;    // item id currently loaded in the player
let quietUntil = 0;       // ignore player events we caused until this time
let lastObs = null;       // last {time, at} seen while playing, to spot user seeks
let pausedAt = null;      // player time when we last settled while paused
const drifts = [];        // recent drift samples in seconds
let rate = 1;
let rateWorks = null;     // whether the player accepts small rate changes
let seekLead = 0.15;      // seconds to seek ahead, learned from how long seeks take
let lastSeek = 0;
let pendingUntil = 0;   // after our own play/pause/seek, wait for the room to agree
let blocked = false;
let errorFor = null;

// ---- clock

const serverNow = () => Date.now() + offset;

function expected() {
  if (!state || !state.current) return 0;
  if (!state.playing) return state.position;
  return state.position + (serverNow() - state.updatedAt) / 1000;
}

function onPong(msg) {
  const now = Date.now();
  const rtt = now - msg.t0;
  pings.push({ rtt, offset: msg.serverTime - (msg.t0 + rtt / 2) });
  if (pings.length > 12) pings.shift();
  // The sample with the shortest round trip has the least room for error.
  offset = pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
}

function burstPings() {
  for (let i = 0; i < 6; i++) setTimeout(() => send({ type: "ping", t0: Date.now() }), i * 150);
}

// ---- connection

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  $("#conn").textContent = "Connecting…";
  ws.onopen = () => {
    $("#conn").textContent = "";
    pings.length = 0;
    burstPings();
    if (joined) send({ type: "hello", name: myName() });
  };
  ws.onclose = () => {
    $("#conn").textContent = "Disconnected. Reconnecting…";
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "welcome") myId = msg.id;
    else if (msg.type === "pong") onPong(msg);
    else if (msg.type === "state") { state = msg.state; pendingUntil = 0; drifts.length = 0; render(); tick(); }
    else if (msg.type === "presence") renderPeople(msg.users);
    else if (msg.type === "error") showMessage(msg.message);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Sends a play, pause or seek made on this player. Until the server answers,
// tick() leaves the player alone, or it would undo the click.
function sendAction(type, position) {
  pendingUntil = Date.now() + 2000;
  send({ type, position, at: serverNow() });
}

setInterval(() => send({ type: "ping", t0: Date.now() }), 10000);

// ---- player

window.onYouTubeIframeAPIReady = () => {
  apiReady = true;
  if (joined) makePlayer();
};

function makePlayer() {
  if (player) return;
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    playerVars: { playsinline: 1, rel: 0, autoplay: 0 },
    events: {
      onReady: () => { playerReady = true; tick(); },
      onStateChange: onPlayerState,
      onError: onPlayerError,
    },
  });
}

function quiet(ms = 1200) {
  quietUntil = Date.now() + ms;
}

function setRate(r) {
  if (r === rate) return;
  rate = r;
  player.setPlaybackRate(r);
  if (r !== 1 && rateWorks === null) {
    // YouTube ignores rates it doesn't support. Check whether this one stuck.
    setTimeout(() => {
      rateWorks = Math.abs(player.getPlaybackRate() - r) < 0.001;
      if (!rateWorks) rate = player.getPlaybackRate();
    }, 600);
  }
}

function seekTo(t) {
  quiet();
  lastSeek = Date.now();
  lastObs = null;
  drifts.length = 0;
  player.seekTo(Math.max(0, t), true);
}

function onPlayerState(e) {
  if (!state || !state.current) return;
  if (e.data === YT_ENDED) {
    send({ type: "ended", itemId: state.current.id });
    return;
  }
  if (Date.now() < quietUntil) return;
  const t = player.getCurrentTime();
  // Only report a change when the player disagrees with the room. Changes we
  // made to match the room agree with it, so they don't echo back.
  if (e.data === YT_PLAYING && !state.playing) {
    sendAction("play", t);
  } else if (e.data === YT_PAUSED && state.playing) {
    sendAction("pause", t);
  }
}

function onPlayerError(e) {
  if (!state || !state.current) return;
  const why = e.data === 101 || e.data === 150
    ? "The uploader doesn't allow this video to play on other sites."
    : "YouTube couldn't play this video.";
  errorFor = state.current.id;
  showMessage(`${why} Skipping it in a few seconds.`);
  const itemId = state.current.id;
  setTimeout(() => send({ type: "ended", itemId }), 4000);
}

// Runs four times a second and on every state change.
function tick() {
  if (!playerReady || !state) return;
  const cur = state.current;
  $("#empty").hidden = !!cur;

  if (!cur) {
    if (loadedItem) { quiet(); player.stopVideo(); loadedItem = null; }
    return;
  }

  if (loadedItem !== cur.id) {
    loadedItem = cur.id;
    errorFor = null;
    hideMessage();
    quiet(2500);
    lastObs = null;
    pausedAt = null;
    drifts.length = 0;
    if (state.playing) player.loadVideoById(cur.videoId, expected() + seekLead);
    else player.cueVideoById(cur.videoId, state.position);
    return;
  }
  if (errorFor === cur.id || Date.now() < pendingUntil) return;

  const ps = player.getPlayerState();
  const t = player.getCurrentTime();
  const now = Date.now();
  const isQuiet = now < quietUntil;

  if (state.playing) {
    pausedAt = null;
    if (ps === YT_ENDED) return;
    if (ps === YT_PAUSED || ps === YT_CUED || ps === YT_UNSTARTED) {
      if (isQuiet) return;
      quiet();
      if (Math.abs(t - expected()) > 0.3) player.seekTo(expected() + seekLead, true);
      player.playVideo();
      // If the browser blocks sound until a click, the player stays unstarted.
      setTimeout(() => {
        blocked = player.getPlayerState() === YT_UNSTARTED;
        if (blocked) showMessage("Your browser blocked playback. Click play on the video once.");
      }, 1500);
      return;
    }
    if (ps !== YT_PLAYING) { lastObs = null; return; }
    if (blocked) { blocked = false; hideMessage(); }

    // A jump the clock can't explain means someone used the seek bar.
    if (lastObs && !isQuiet) {
      const predicted = lastObs.time + ((now - lastObs.at) / 1000) * rate;
      if (Math.abs(t - predicted) > 1.5) {
        lastObs = { time: t, at: now };
        sendAction("seek", t);
        return;
      }
    }
    lastObs = { time: t, at: now };
    correctDrift(t - expected(), now);
  } else {
    lastObs = null;
    if (rate !== 1) setRate(1);
    if (ps === YT_PLAYING || ps === YT_BUFFERING) {
      if (isQuiet) return;
      quiet();
      player.pauseVideo();
      return;
    }
    if (ps !== YT_PAUSED && ps !== YT_CUED) return;
    // While paused, a moved seek bar is a user seek. Otherwise hold the room's spot.
    if (pausedAt !== null && !isQuiet && Math.abs(t - pausedAt) > 0.5) {
      pausedAt = t;
      sendAction("seek", t);
      return;
    }
    if (Math.abs(t - state.position) > 0.3 && !isQuiet) {
      seekTo(state.position);
      pausedAt = state.position;
      return;
    }
    if (!isQuiet) pausedAt = t;
  }
}

function correctDrift(drift, now) {
  drifts.push(drift);
  if (drifts.length > 6) drifts.shift();
  if (drifts.length < 3) return;
  const sorted = [...drifts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // The first samples after a seek show how far behind the seek landed.
  // Seek further ahead next time by that much.
  if (lastSeek && now - lastSeek < 4000 && drifts.length === 3) {
    seekLead = Math.min(1.5, Math.max(0, seekLead - median));
  }

  const seekAt = rateWorks === false ? 0.2 : 0.5;
  if (Math.abs(median) > seekAt && now - lastSeek > 2000) {
    seekTo(expected() + seekLead);
    return;
  }
  if (rateWorks === false) return;
  if (Math.abs(median) < 0.02) setRate(1);
  else if (Math.abs(median) > 0.05) setRate(median > 0 ? 0.95 : 1.05);
}

setInterval(tick, 250);

// Tell the room how this browser is doing, for the "Here now" list.
setInterval(() => {
  if (!joined) return;
  let status = "idle", drift = null;
  if (playerReady && state && state.current) {
    const ps = player.getPlayerState();
    if (errorFor) status = "error";
    else if (blocked) status = "blocked";
    else if (ps === YT_PLAYING) status = "playing";
    else if (ps === YT_BUFFERING) status = "buffering";
    else status = "paused";
    if (ps === YT_PLAYING && state.playing) drift = player.getCurrentTime() - expected();
  }
  send({ type: "report", status, drift });
}, 2000);

// ---- rendering

function render() {
  const cur = state.current;
  $("#now-title").textContent = cur ? cur.title : "Nothing playing";
  $("#now-by").textContent = cur ? `Added by ${cur.addedBy}` : "";
  $("#skip").disabled = !cur;
  document.title = cur ? `${cur.title} · Sync` : "Sync";

  const list = $("#queue");
  list.replaceChildren();
  for (const item of state.queue) {
    const li = document.createElement("li");
    const img = document.createElement("img");
    img.src = `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`;
    img.alt = "";
    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title;
    title.title = item.title;
    const by = document.createElement("div");
    by.className = "by";
    by.textContent = `Added by ${item.addedBy}`;
    info.append(title, by);
    const playBtn = button("Play", () => send({ type: "playNow", itemId: item.id }));
    const removeBtn = button("✕", () => send({ type: "remove", itemId: item.id }));
    removeBtn.title = "Remove";
    li.append(img, info, playBtn, removeBtn);
    list.append(li);
  }
  $("#queue-empty").hidden = state.queue.length > 0;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "plain";
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function renderPeople(users) {
  const list = $("#people");
  list.replaceChildren();
  for (const u of users) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    const dot = document.createElement("span");
    const synced = u.status === "playing" && u.drift !== null && Math.abs(u.drift) < 0.1;
    dot.className = "dot" + (synced || u.status === "paused" ? " good" : u.status === "idle" ? "" : " off");
    name.append(dot, u.name + (u.id === myId ? " (you)" : ""));
    const detail = document.createElement("span");
    detail.className = "muted";
    detail.textContent = describe(u);
    li.append(name, detail);
    list.append(li);
  }
  if (users.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nobody yet.";
    list.append(li);
  }
}

function describe(u) {
  if (u.status === "playing" && u.drift !== null) {
    const ms = Math.round(u.drift * 1000);
    return Math.abs(ms) < 15 ? "in sync" : `${ms > 0 ? "+" : ""}${ms} ms`;
  }
  return { playing: "playing", paused: "paused", buffering: "loading", blocked: "needs a click", error: "can't play this", idle: "idle" }[u.status] ?? u.status;
}

let messageTimer = null;
function showMessage(text) {
  const m = $("#message");
  m.textContent = text;
  m.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(hideMessage, 8000);
}
function hideMessage() {
  $("#message").hidden = true;
}

// ---- controls

function myName() {
  return $("#name").value.trim();
}

try { $("#name").value = localStorage.getItem("sync-name") ?? ""; } catch {}

$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!myName()) return;
  try { localStorage.setItem("sync-name", myName()); } catch {}
  joined = true;
  $("#join").hidden = true;
  send({ type: "hello", name: myName() });
  if (apiReady) makePlayer();
});

$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#add-input");
  if (!input.value.trim()) return;
  send({ type: "add", input: input.value });
  input.value = "";
});

$("#skip").addEventListener("click", () => send({ type: "next" }));

connect();
