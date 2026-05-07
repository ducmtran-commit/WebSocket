# PixTogether - Real-Time Multiplayer Pixel Board

PixTogether is a collaborative drawing app built with Node.js, Express, and WebSockets (`ws`).  
Multiple users can join the same room, draw on a shared board in real time, chat, and see who is actively drawing.

## What We Built

- Single Node.js server (`server.js`) handling HTTP + WebSocket traffic
- Shared live board (`256x192`) synchronized across all connected clients
- Public lobby + password-protected private rooms
- Real-time chat and artist presence list
- Distinct per-user identity colors
- Live username tags shown near the pixels currently being drawn by other users
- Undo/redo support and "clear my drawing only" behavior
- Performance-focused paint batching and smooth remote update playback
- Room persistence and automatic cleanup for inactive rooms

## Core Features

### Rooms and Access

- `LOBBY` is the public room
- Users can create private rooms with a password
- Join/create flow validates room names, capacity, and password rules

### Drawing Experience

- Brush + eraser tools
- Fast drag painting with line interpolation between pointer points
- Zoom controls: buttons, slider, and `Ctrl/Cmd + mouse wheel`
- Pan canvas using middle/right mouse or hold `Space` + left drag
- Mobile/tablet gestures:
  - 2-finger pinch to zoom
  - 2-finger double tap to undo
  - hold after 2-finger double tap for continuous undo
  - 3-finger double tap to redo
- Pencil Mode behavior:
  - when ON, finger touch is pan/zoom only
  - only stylus/pen input draws
- Keyboard shortcuts:
  - `E` toggle eraser
  - `Ctrl/Cmd + Z` undo
  - `Ctrl/Cmd + Y` or `Ctrl/Cmd + Shift + Z` redo
  - `Ctrl/Cmd + Shift + X` clear your own pixels
  - `Tab` hide/show workspace panel
  - `Esc` back to launch screen

### Real-Time Presence

- Artist list updates live as users join/leave
- Chat includes user color cues
- Active drawing tags appear near the latest pixel location of each drawing user

### Data and Retention

- Room state is saved to disk (`data/rooms/*.json`)
- Saved room data expires after retention window
- `LOBBY` retention floor is 72h
- `LOBBY` public idle wipe floor is 72h (`4320` minutes)
- Private rooms are deleted after idle timeout (default 1 hour)

### Launch and Session Resume

- New users (no valid saved session) see the launch screen first
- Returning users with an active board session resume directly into the board
- Returning resume skips the entrance dissolve animation for a faster refresh flow

## Run Locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two or more tabs/windows to test multiplayer behavior.

## Environment Variables

Optional configuration values:

- `PORT=3000`
- `NODE_ENV=production`
- `NODE_VERSION=18`
- `MAX_ROOMS=5`
- `MAX_USERS_PER_ROOM=30`
- `MAX_UNDO_ACTIONS=240`  
  Per-user undo/redo action history cap
- `BOARD_RETENTION_HOURS=72`  
  Keep saved room state for this long since last activity
- `BOARD_IDLE_WIPE_MINUTES=4320`  
  Public room idle timeout (wipe board only, floor is 4320)
- `PRIVATE_ROOM_IDLE_DELETE_MINUTES=60`  
  Private room idle timeout (delete room state)
- `BOARD_SAVE_DEBOUNCE_MS=12000`  
  Delay before persisting room changes
- `PAINT_BROADCAST_MERGE_MS=8`  
  Server merge window for outbound paint updates (lower = more real-time, higher = fewer packets)

## Deploy to Render

### Option A: Blueprint (recommended)

1. Push repo to GitHub
2. In Render, choose **New +** -> **Blueprint**
3. Select your repository
4. Render reads `render.yaml` and provisions the service
5. Open deployed URL and test with multiple clients

### Option B: Manual Web Service

- Build command: `npm install`
- Start command: `npm start`
- Environment: `Node`

## Tech Summary

- Backend: Node.js + Express + `ws`
- Frontend: Vanilla HTML/CSS/JS
- Transport: WebSocket event messages for board/chat/user sync
- Persistence: JSON snapshot files per room
