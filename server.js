const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const GRID_SIZE = 14;
const SPAWN_POINTS = [
  { x: 0, y: 0 },
  { x: GRID_SIZE - 1, y: GRID_SIZE - 1 },
  { x: 0, y: GRID_SIZE - 1 },
  { x: GRID_SIZE - 1, y: 0 },
];

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const state = {
  players: new Map(),
  chat: [],
};

function randomColor() {
  const palette = ["#f97316", "#0ea5e9", "#22c55e", "#a855f7", "#ef4444", "#14b8a6", "#eab308"];
  return palette[Math.floor(Math.random() * palette.length)];
}

function nextSpawn() {
  const point = SPAWN_POINTS[state.players.size % SPAWN_POINTS.length];
  return { ...point };
}

function safeName(value) {
  if (typeof value !== "string") return "Player";
  const cleaned = value.trim().slice(0, 20);
  return cleaned || "Player";
}

function serializePlayers() {
  return Array.from(state.players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    x: player.x,
    y: player.y,
    score: player.score,
  }));
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function sendState() {
  broadcast({
    type: "state",
    gridSize: GRID_SIZE,
    players: serializePlayers(),
    chat: state.chat,
  });
}

function addChat(author, text) {
  state.chat.push({ author, text, at: Date.now() });
  if (state.chat.length > 30) state.chat.shift();
}

wss.on("connection", (ws) => {
  const playerId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const spawn = nextSpawn();
  const player = {
    id: playerId,
    name: "Player",
    color: randomColor(),
    x: spawn.x,
    y: spawn.y,
    score: 0,
  };

  state.players.set(playerId, player);
  ws.playerId = playerId;

  addChat("System", `${player.name} joined the arena.`);
  sendState();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;
    const current = state.players.get(ws.playerId);
    if (!current) return;

    if (msg.type === "set-name") {
      current.name = safeName(msg.name);
      addChat("System", `${current.name} updated their name.`);
      sendState();
      return;
    }

    if (msg.type === "move") {
      const dx = Number(msg.dx);
      const dy = Number(msg.dy);
      if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
      if (Math.abs(dx) + Math.abs(dy) !== 1) return;

      const nextX = current.x + dx;
      const nextY = current.y + dy;
      if (nextX < 0 || nextY < 0 || nextX >= GRID_SIZE || nextY >= GRID_SIZE) return;

      current.x = nextX;
      current.y = nextY;

      for (const [id, other] of state.players.entries()) {
        if (id !== current.id && other.x === current.x && other.y === current.y) {
          current.score += 1;
          addChat("System", `${current.name} tagged ${other.name} (+1 point).`);
          break;
        }
      }
      sendState();
      return;
    }

    if (msg.type === "chat") {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 120) : "";
      if (!text) return;
      addChat(current.name, text);
      sendState();
    }
  });

  ws.on("close", () => {
    const current = state.players.get(ws.playerId);
    if (current) {
      addChat("System", `${current.name} left the arena.`);
      state.players.delete(ws.playerId);
      sendState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Grid Arena server running on port ${PORT}`);
});
