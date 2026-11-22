# pinillasync

Play a YouTube video for two people at the same moment. Open the page, paste a link, and press play. Play, pause, seek and skip apply to everyone in the room. Videos added while one plays wait in a shared queue, and the next one starts for everyone when the current one ends.

There is one room and no login. Anyone with the URL can join and control playback.

## How the sync works

The server keeps the room state: the current video, whether it's playing, and its position at a server timestamp. Each browser measures its clock offset to the server from the fastest of its recent pings. It works out where the video should be and checks its player four times a second. A median drift over 50 ms changes the playback rate to 0.95 or 1.05 until it's back under 20 ms. A drift over 0.5 s makes it seek. If YouTube refuses those rates, it seeks at 0.2 s instead.

Things the app can't fix:

- Bluetooth headphones add their own delay, often 100 to 300 ms.
- Browsers block sound until you click the page, which is why the page asks you to join first.
- YouTube ads play separately for each person. Whoever gets one falls behind and catches up by seeking afterwards.
- Some videos, mostly label music videos, don't allow playing on other sites. The app shows a message and skips them.

## Running it

Node 24 or later runs the TypeScript directly, with no build step.

```sh
npm install
npm test
npm start          # http://127.0.0.1:3200
```

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to listen on |
| `PORT` | `3200` | Port to listen on |
| `SYNC_DATA` | `./data` | Folder for `state.json`, which keeps the queue across restarts |
| `SYNC_ORIGINS` | empty | Comma-separated page origins allowed to open the WebSocket. Empty allows any |

`deploy/` has the systemd unit, the nginx block and the deploy script used on server1.
