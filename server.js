const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const BOARD_FILE = path.join(DATA_DIR, "board.json");
const RETENTION_MS = Math.max(1, Number(process.env.BOARD_RETENTION_HOURS || 48)) * 60 * 60 * 1000;
const IDLE_WIPE_MS = Math.max(1, Number(process.env.BOARD_IDLE_WIPE_MINUTES || 15)) * 60 * 1000;
const SAVE_DEBOUNCE_MS = Math.max(3000, Number(process.env.BOARD_SAVE_DEBOUNCE_MS || 12000));

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

let lastActivityAt = Date.now();
let boardDirty = false;
let saveDebounceTimer = null;
let idleWipeTimer = null;

function isValidSavedPixels(pixels) {
  if (!Array.isArray(pixels) || pixels.length !== GRID_HEIGHT) return false;
  for (let y = 0; y < GRID_HEIGHT; y++) {
    if (!Array.isArray(pixels[y]) || pixels[y].length !== GRID_WIDTH) return false;
  }
  return true;
}

function countOpenClients() {
  let n = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) n += 1;
  }
  return n;
}

function cancelIdleWipe() {
  if (idleWipeTimer) {
    clearTimeout(idleWipeTimer);
    idleWipeTimer = null;
  }
}

function resetBoardToEmpty() {
  state.pixels = Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(DEFAULT_PIXEL));
  state.owners = Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(null));
  state.chat = [];
}

function performIdleWipe() {
  idleWipeTimer = null;
  if (countOpenClients() > 0) return;
  resetBoardToEmpty();
  lastActivityAt = Date.now();
  boardDirty = false;
  try {
    fs.unlinkSync(BOARD_FILE);
  } catch {
    // File may not exist.
  }
  console.log("Board wiped: no clients connected for idle period.");
}

function scheduleIdleWipeIfEmpty() {
  if (countOpenClients() > 0) return;
  cancelIdleWipe();
  idleWipeTimer = setTimeout(performIdleWipe, IDLE_WIPE_MS);
}

function flushBoardSave() {
  saveDebounceTimer = null;
  if (!boardDirty) return;
  boardDirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({
      version: 1,
      lastActivityAt,
      pixels: state.pixels,
      chat: state.chat,
    });
    const tmp = `${BOARD_FILE}.tmp`;
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, BOARD_FILE);
  } catch (err) {
    console.warn("Board save failed:", err.message);
    boardDirty = true;
  }
}

function touchBoardActivity() {
  lastActivityAt = Date.now();
  boardDirty = true;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(flushBoardSave, SAVE_DEBOUNCE_MS);
}

function tryLoadBoardFromDisk() {
  try {
    if (!fs.existsSync(BOARD_FILE)) return;
    const raw = fs.readFileSync(BOARD_FILE, "utf8");
    const data = JSON.parse(raw);
    const savedAt = Number(data.lastActivityAt) || 0;
    if (Date.now() - savedAt > RETENTION_MS) {
      fs.unlinkSync(BOARD_FILE);
      console.log("Discarded saved board: older than retention window.");
      return;
    }
    if (!isValidSavedPixels(data.pixels)) {
      console.warn("Discarded saved board: invalid pixel grid.");
      return;
    }
    state.pixels = data.pixels;
    state.owners = Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(null));
    state.chat = Array.isArray(data.chat) ? data.chat.slice(-30) : [];
    lastActivityAt = savedAt;
    console.log("Restored board from disk (within retention window).");
  } catch (err) {
    console.warn("Board load failed:", err.message);
  }
}

tryLoadBoardFromDisk();

setInterval(() => {
  if (boardDirty && saveDebounceTimer == null) {
    flushBoardSave();
  }
}, 60000);

function shutdownPersist() {
  cancelIdleWipe();
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  if (boardDirty) flushBoardSave();
}

process.on("SIGINT", () => {
  shutdownPersist();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdownPersist();
  process.exit(0);
});

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

const paintBroadcastMerge = new Map();
let paintBroadcastTimer = null;

function flushPaintBroadcastMerge() {
  paintBroadcastTimer = null;
  if (paintBroadcastMerge.size === 0) return;
  const pixels = Array.from(paintBroadcastMerge.values());
  paintBroadcastMerge.clear();
  broadcastPixelsUpdated(pixels);
}

function mergePaintBroadcastPixels(updates) {
  for (const u of updates) {
    paintBroadcastMerge.set(`${u.x},${u.y}`, u);
  }
  if (paintBroadcastTimer == null) {
    paintBroadcastTimer = setTimeout(flushPaintBroadcastMerge, 20);
  }
}

function addChat(author, text, authorId = null) {
  state.chat.push({ author, authorId, text, at: Date.now() });
  if (state.chat.length > 30) state.chat.shift();
}

wss.on("connection", (ws) => {
  cancelIdleWipe();

  const userId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = {
    id: userId,
    name: "Artist",
    color: randomColor(),
  };

  state.users.set(userId, user);
  ws.userId = userId;
  /** Stable paint/clear identity; client sends `clientKey` in set-name to survive refresh. */
  ws.ownerKey = userId;
  ws.undoStack = [];
  ws.redoStack = [];

  addChat("System", `${user.name} joined the board.`);
  sendInitState(ws);
  broadcastUsers();
  broadcastChat();
  touchBoardActivity();

  function sanitizeClientKey(value) {
    if (typeof value !== "string") return null;
    const s = value.trim().slice(0, 64);
    if (s.length < 8 || s.length > 64) return null;
    return /^[a-zA-Z0-9_-]+$/.test(s) ? s : null;
  }

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
      const key = sanitizeClientKey(msg.clientKey);
      if (key) ws.ownerKey = key;
      addChat("System", `${current.name} updated their name.`);
      broadcastUsers();
      broadcastChat();
      touchBoardActivity();
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
        changes.push({ x, y, from: prevColor, to: color, fromOwner: prevOwner, toOwner: ws.ownerKey });
        state.pixels[y][x] = color;
        state.owners[y][x] = ws.ownerKey;
        updates.push({ x, y, color });
      }
      if (changes.length > 0) {
        mergePaintBroadcastPixels(updates);
        ws.undoStack.push({ changes });
        if (ws.undoStack.length > 80) ws.undoStack.shift();
        ws.redoStack = [];
        touchBoardActivity();
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
      touchBoardActivity();
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
      touchBoardActivity();
      return;
    }

    if (msg.type === "clear-board") {
      const updates = [];
      for (let y = 0; y < GRID_HEIGHT; y += 1) {
        for (let x = 0; x < GRID_WIDTH; x += 1) {
          if (state.owners[y][x] !== ws.ownerKey) continue;
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
      touchBoardActivity();
      return;
    }

    if (msg.type === "chat") {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 120) : "";
      if (!text) return;
      addChat(current.name, text, current.id);
      broadcastChat();
      touchBoardActivity();
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
    scheduleIdleWipeIfEmpty();
  });
});

server.listen(PORT, () => {
  console.log(`Pixel Board server running on port ${PORT}`);
  console.log(
    `Board disk: ${BOARD_FILE} (retention ${RETENTION_MS / 3600000}h, idle wipe after ${IDLE_WIPE_MS / 60000}m with no clients)`
  );
});
