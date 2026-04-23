const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const GRID_WIDTH = 256;
const GRID_HEIGHT = 192;
const DEFAULT_PIXEL = "#0b1220";

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const state = {
  users: new Map(),
  pixels: Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(DEFAULT_PIXEL)),
  owners: Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(null)),
  chat: [],
};

function randomColor() {
  const palette = ["#f97316", "#0ea5e9", "#22c55e", "#a855f7", "#ef4444", "#14b8a6", "#eab308"];
  return palette[Math.floor(Math.random() * palette.length)];
}

function safeName(value) {
  if (typeof value !== "string") return "Artist";
  const cleaned = value.trim().slice(0, 20);
  return cleaned || "Artist";
}

function serializeUsers() {
  return Array.from(state.users.values()).map((user) => ({
    id: user.id,
    name: user.name,
    color: user.color,
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

function sendInitState(ws) {
  ws.send(
    JSON.stringify({
      type: "init-state",
      gridWidth: GRID_WIDTH,
      gridHeight: GRID_HEIGHT,
      pixels: state.pixels,
      users: serializeUsers(),
      chat: state.chat,
    })
  );
}

function broadcastUsers() {
  broadcast({
    type: "users",
    users: serializeUsers(),
  });
}

function broadcastChat() {
  broadcast({
    type: "chat-history",
    chat: state.chat,
  });
}

function broadcastPixelsUpdated(pixels) {
  broadcast({
    type: "pixels-updated",
    pixels,
  });
}

function addChat(author, text) {
  state.chat.push({ author, text, at: Date.now() });
  if (state.chat.length > 30) state.chat.shift();
}

wss.on("connection", (ws) => {
  const userId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = {
    id: userId,
    name: "Artist",
    color: randomColor(),
  };

  state.users.set(userId, user);
  ws.userId = userId;
  ws.undoStack = [];
  ws.redoStack = [];

  addChat("System", `${user.name} joined the board.`);
  sendInitState(ws);
  broadcastUsers();
  broadcastChat();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;
    const current = state.users.get(ws.userId);
    if (!current) return;

    if (msg.type === "set-name") {
      current.name = safeName(msg.name);
      addChat("System", `${current.name} updated their name.`);
      broadcastUsers();
      broadcastChat();
      return;
    }

    if (msg.type === "paint-batch") {
      if (!Array.isArray(msg.pixels) || msg.pixels.length === 0) return;
      const seen = new Set();
      const changes = [];
      const updates = [];
      for (const item of msg.pixels) {
        const x = Number(item?.x);
        const y = Number(item?.y);
        const color = typeof item?.color === "string" ? item.color : current.color;
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        if (x < 0 || y < 0 || x >= GRID_WIDTH || y >= GRID_HEIGHT) continue;
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) continue;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const prevColor = state.pixels[y][x];
        const prevOwner = state.owners[y][x];
        if (prevColor === color) continue;
        changes.push({ x, y, from: prevColor, to: color, fromOwner: prevOwner, toOwner: ws.userId });
        state.pixels[y][x] = color;
        state.owners[y][x] = ws.userId;
        updates.push({ x, y, color });
      }
      if (changes.length > 0) {
        broadcastPixelsUpdated(updates);
        ws.undoStack.push({ changes });
        if (ws.undoStack.length > 80) ws.undoStack.shift();
        ws.redoStack = [];
      }
      return;
    }

    if (msg.type === "undo") {
      const action = ws.undoStack.pop();
      if (!action) return;
      const updates = [];
      for (const change of action.changes) {
        state.pixels[change.y][change.x] = change.from;
        state.owners[change.y][change.x] = change.fromOwner || null;
        updates.push({ x: change.x, y: change.y, color: change.from });
      }
      broadcastPixelsUpdated(updates);
      ws.redoStack.push(action);
      if (ws.redoStack.length > 80) ws.redoStack.shift();
      return;
    }

    if (msg.type === "redo") {
      const action = ws.redoStack.pop();
      if (!action) return;
      const updates = [];
      for (const change of action.changes) {
        state.pixels[change.y][change.x] = change.to;
        state.owners[change.y][change.x] = change.toOwner || null;
        updates.push({ x: change.x, y: change.y, color: change.to });
      }
      broadcastPixelsUpdated(updates);
      ws.undoStack.push(action);
      if (ws.undoStack.length > 80) ws.undoStack.shift();
      return;
    }

    if (msg.type === "clear-board") {
      const updates = [];
      for (let y = 0; y < GRID_HEIGHT; y += 1) {
        for (let x = 0; x < GRID_WIDTH; x += 1) {
          if (state.owners[y][x] !== ws.userId) continue;
          state.pixels[y][x] = DEFAULT_PIXEL;
          state.owners[y][x] = null;
          updates.push({ x, y, color: DEFAULT_PIXEL });
        }
      }
      if (updates.length > 0) {
        broadcastPixelsUpdated(updates);
      }
      ws.undoStack = [];
      ws.redoStack = [];
      addChat("System", `${current.name} cleared their drawing.`);
      broadcastChat();
      return;
    }

    if (msg.type === "chat") {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 120) : "";
      if (!text) return;
      addChat(current.name, text);
      broadcastChat();
    }
  });

  ws.on("close", () => {
    const current = state.users.get(ws.userId);
    if (current) {
      addChat("System", `${current.name} left the board.`);
      state.users.delete(ws.userId);
      broadcastUsers();
      broadcastChat();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pixel Board server running on port ${PORT}`);
});
