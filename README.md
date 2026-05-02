# Co-op Pixel Board (WebSocket Class Project)

Co-op Pixel Board is a real-time multiplayer drawing app. Multiple users join the same board, paint pixels together, erase mistakes, zoom in/out, and chat live. All interactions are synchronized through WebSockets.

## Why This Fits The Assignment

- Uses one Node.js server (`server.js`)
- Uses WebSockets (`ws`) for real-time communication
- Multiple clients connect to shared live state
- Ready to deploy to Render as one web service

## Features

- Shared pixel board (`96x72`)
- Live co-op drawing and erasing
- Zoom controls (`+`, `-`, slider, and `Ctrl + mouse wheel`)
- Live chat and online artist list
- Faster drawing via incremental/batched WebSocket updates

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in two browser tabs/windows to test collaboration.

## Deploy To Render (Exact Steps)

1. Push this repo to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Select your GitHub repo.
4. Render auto-detects `render.yaml` and creates the service.
5. Wait for deploy to finish, then open your app URL (`https://...onrender.com`).
6. Share that URL with classmates so they can join.

## If Blueprint Is Not Available

Create a **Web Service** manually with:

- Build Command: `npm install`
- Start Command: `npm start`
- Environment: `Node`

Optional env vars:

- `NODE_ENV=production`
- `NODE_VERSION=18`
- `BOARD_RETENTION_HOURS=72` (keep saved board for 72 hours since last activity)
- `BOARD_IDLE_WIPE_MINUTES=4320` (wipe in-memory board only after 3 days with no connected clients)

## Submission Text (Example)

I built Co-op Pixel Board using Node.js, Express, and the `ws` WebSocket library. The server manages a shared pixel grid and broadcasts updates in real time so everyone can draw on the same board together. The app supports drawing, erasing, zooming, and chat, and is deployed on Render for public multi-user access.
