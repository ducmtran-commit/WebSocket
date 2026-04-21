# Grid Arena (WebSocket Class Project)

Grid Arena is a real-time multiplayer interaction app. Multiple users join the same board, move with arrow keys, tag each other for points, and chat live. Every interaction is synchronized through WebSockets.

## Why This Fits The Assignment

- Uses a Node.js server (`server.js`)
- Uses WebSockets (`ws`) for real-time communication
- Two or more clients can connect and interact on shared state
- Ready to deploy to Render as one web service

## Interaction Design

Each connected user is represented by a colored square on a shared 14x14 grid.

- Press arrow keys to move
- When you move onto another player tile, you tag them and earn a point
- Chat updates in real time for all players
- Scoreboard updates live for everyone

This makes the shared interaction obvious and easy to demo in class with two browser windows.

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in two tabs/windows to test multi-user interaction.

## Deploy On Render

1. Push this project to GitHub
2. Create a new **Web Service** on Render
3. Set commands:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Deploy and open the generated Render URL

## Suggested Submission Text

I built Grid Arena using Node.js, Express, and the `ws` WebSocket library. The server keeps a shared multiplayer state and broadcasts updates so all connected clients see movement, chat, and score changes instantly. The app demonstrates real-time multi-user interaction by letting players move on the same grid and tag each other for points.
