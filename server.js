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
const ROOMS_DIR = path.join(DATA_DIR, "rooms");
const RETENTION_MS = Math.max(1, Number(process.env.BOARD_RETENTION_HOURS || 48)) * 60 * 60 * 1000;
const IDLE_WIPE_MS = Math.max(1, Number(process.env.BOARD_IDLE_WIPE_MINUTES || 4320)) * 60 * 1000;
const SAVE_DEBOUNCE_MS = Math.max(3000, Number(process.env.BOARD_SAVE_DEBOUNCE_MS || 12000));
const MAX_ROOMS = Math.max(1, Number(process.env.MAX_ROOMS || 5));
const MAX_USERS_PER_ROOM = Math.max(1, Number(process.env.MAX_USERS_PER_ROOM || 30));

const GRID_WIDTH = 256;
const GRID_HEIGHT = 192;
const DEFAULT_PIXEL = "#0b1220";
const ROOM_IDS = Array.from({ length: MAX_ROOMS }, (_unused, i) => `room-${i + 1}`);

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const rooms = new Map();

function createEmptyPixels() {
  return Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(DEFAULT_PIXEL));
}

function createEmptyOwners() {
  return Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(null));
}

function roomFile(roomId) {
  return path.join(ROOMS_DIR, `${roomId}.json`);
}

function formatRoomLabel(roomId) {
  const n = Number(String(roomId).split("-")[1]);
  return Number.isInteger(n) ? `ROOM-${n}` : roomId.toUpperCase();
}

function createRoomState(roomId) {
  return {
    id: roomId,
    users: new Map(),
    pixels: createEmptyPixels(),
    owners: createEmptyOwners(),
    chat: [],
    lastActivityAt: Date.now(),
    boardDirty: false,
    saveDebounceTimer: null,
    idleWipeTimer: null,
    paintBroadcastMerge: new Map(),
    paintBroadcastTimer: null,
  };
}

function isValidSavedPixels(pixels) {
  if (!Array.isArray(pixels) || pixels.length !== GRID_HEIGHT) return false;
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    if (!Array.isArray(pixels[y]) || pixels[y].length !== GRID_WIDTH) return false;
  }
  return true;
}

function countOpenClientsInRoom(roomId) {
  let n = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomId) n += 1;
  }
  return n;
}

function cancelIdleWipe(room) {
  if (room.idleWipeTimer) {
    clearTimeout(room.idleWipeTimer);
    room.idleWipeTimer = null;
  }
}

function resetRoomToEmpty(room) {
  room.pixels = createEmptyPixels();
  room.owners = createEmptyOwners();
  room.chat = [];
}

function performIdleWipe(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.idleWipeTimer = null;
  if (countOpenClientsInRoom(roomId) > 0) return;
  resetRoomToEmpty(room);
  room.lastActivityAt = Date.now();
  room.boardDirty = false;
  try {
    fs.unlinkSync(roomFile(roomId));
  } catch {
    // File may not exist.
  }
  console.log(`${formatRoomLabel(roomId)} wiped after idle timeout.`);
}

function scheduleIdleWipeIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (countOpenClientsInRoom(roomId) > 0) return;
  cancelIdleWipe(room);
  room.idleWipeTimer = setTimeout(() => {
    performIdleWipe(roomId);
  }, IDLE_WIPE_MS);
}

function flushRoomSave(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.saveDebounceTimer = null;
  if (!room.boardDirty) return;
  room.boardDirty = false;
  try {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    const payload = JSON.stringify({
      version: 1,
      roomId: room.id,
      lastActivityAt: room.lastActivityAt,
      pixels: room.pixels,
      chat: room.chat,
    });
    const file = roomFile(roomId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`${formatRoomLabel(roomId)} save failed:`, err.message);
    room.boardDirty = true;
  }
}

function touchRoomActivity(room) {
  room.lastActivityAt = Date.now();
  room.boardDirty = true;
  if (room.saveDebounceTimer) clearTimeout(room.saveDebounceTimer);
  room.saveDebounceTimer = setTimeout(() => {
    flushRoomSave(room.id);
  }, SAVE_DEBOUNCE_MS);
}

function tryLoadRoomFromDisk(room) {
  try {
    const file = roomFile(room.id);
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    const savedAt = Number(data.lastActivityAt) || 0;
    if (Date.now() - savedAt > RETENTION_MS) {
      fs.unlinkSync(file);
      console.log(`${formatRoomLabel(room.id)} save expired by retention window.`);
      return;
    }
    if (!isValidSavedPixels(data.pixels)) {
      console.warn(`${formatRoomLabel(room.id)} save discarded: invalid grid.`);
      return;
    }
    room.pixels = data.pixels;
    room.owners = createEmptyOwners();
    room.chat = Array.isArray(data.chat) ? data.chat.slice(-30) : [];
    room.lastActivityAt = savedAt;
    console.log(`${formatRoomLabel(room.id)} restored from disk.`);
  } catch (err) {
    console.warn(`${formatRoomLabel(room.id)} load failed:`, err.message);
  }
}

function ensureRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;
  room = createRoomState(roomId);
  tryLoadRoomFromDisk(room);
  rooms.set(roomId, room);
  return room;
}

for (const roomId of ROOM_IDS) {
  ensureRoom(roomId);
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.boardDirty && room.saveDebounceTimer == null) {
      flushRoomSave(room.id);
    }
  }
}, 60000);

function shutdownPersist() {
  for (const room of rooms.values()) {
    cancelIdleWipe(room);
    if (room.saveDebounceTimer) {
      clearTimeout(room.saveDebounceTimer);
      room.saveDebounceTimer = null;
    }
    if (room.paintBroadcastTimer) {
      clearTimeout(room.paintBroadcastTimer);
      room.paintBroadcastTimer = null;
    }
    if (room.boardDirty) {
      flushRoomSave(room.id);
    }
  }
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

function serializeUsers(room) {
  return Array.from(room.users.values()).map((user) => ({
    id: user.id,
    name: user.name,
    color: user.color,
  }));
}

function broadcastToRoom(roomId, payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
      client.send(message);
    }
  }
}

function sendInitState(ws, room) {
  ws.send(
    JSON.stringify({
      type: "init-state",
      roomId: room.id,
      gridWidth: GRID_WIDTH,
      gridHeight: GRID_HEIGHT,
      pixels: room.pixels,
      users: serializeUsers(room),
      chat: room.chat,
    })
  );
}

function broadcastUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  broadcastToRoom(roomId, {
    type: "users",
    users: serializeUsers(room),
  });
}

function broadcastChat(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  broadcastToRoom(roomId, {
    type: "chat-history",
    chat: room.chat,
  });
}

function broadcastPixelsUpdated(roomId, pixels) {
  broadcastToRoom(roomId, {
    type: "pixels-updated",
    pixels,
  });
}

function flushPaintBroadcastMerge(room) {
  room.paintBroadcastTimer = null;
  if (room.paintBroadcastMerge.size === 0) return;
  const pixels = Array.from(room.paintBroadcastMerge.values());
  room.paintBroadcastMerge.clear();
  broadcastPixelsUpdated(room.id, pixels);
}

function mergePaintBroadcastPixels(room, updates) {
  for (const u of updates) {
    room.paintBroadcastMerge.set(`${u.x},${u.y}`, u);
  }
  if (room.paintBroadcastTimer == null) {
    room.paintBroadcastTimer = setTimeout(() => {
      flushPaintBroadcastMerge(room);
    }, 20);
  }
}

function addChat(room, author, text, authorId = null) {
  room.chat.push({ author, authorId, text, at: Date.now() });
  if (room.chat.length > 30) room.chat.shift();
}

function sanitizeClientKey(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().slice(0, 64);
  if (s.length < 8 || s.length > 64) return null;
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : null;
}

function normalizeRequestedRoomId(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase();
  const roomMatch = cleaned.match(/^room-(\d{1,2})$/);
  const digitMatch = cleaned.match(/^(\d{1,2})$/);
  const n = Number(roomMatch?.[1] || digitMatch?.[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROOMS) return null;
  return `room-${n}`;
}

function assignAvailableRoom() {
  let best = null;
  let bestLoad = Number.POSITIVE_INFINITY;
  for (const roomId of ROOM_IDS) {
    const load = countOpenClientsInRoom(roomId);
    if (load >= MAX_USERS_PER_ROOM) continue;
    if (load < bestLoad) {
      best = roomId;
      bestLoad = load;
    }
  }
  return best;
}

function resolveRoomForConnection(req) {
  let query = null;
  try {
    query = new URL(req.url || "/", "http://localhost").searchParams;
  } catch {
    query = new URL("http://localhost").searchParams;
  }
  const mode = String(query.get("mode") || "").toLowerCase();
  const requestedRoom = normalizeRequestedRoomId(query.get("room"));

  if (mode === "join") {
    if (!requestedRoom) {
      return {
        errorCode: 4003,
        errorMessage: `Invalid room. Use ROOM-1 to ROOM-${MAX_ROOMS}.`,
      };
    }
    return { roomId: requestedRoom };
  }

  if (requestedRoom) {
    return { roomId: requestedRoom };
  }

  const assigned = assignAvailableRoom();
  if (!assigned) {
    return {
      errorCode: 4004,
      errorMessage: "All rooms are full. Try again later.",
    };
  }
  return { roomId: assigned };
}

wss.on("connection", (ws, req) => {
  const resolved = resolveRoomForConnection(req);
  if (!resolved.roomId) {
    ws.send(
      JSON.stringify({
        type: "room-error",
        message: resolved.errorMessage || "Unable to assign room.",
      })
    );
    ws.close(resolved.errorCode || 4003, "Room unavailable");
    return;
  }

  const roomId = resolved.roomId;
  if (countOpenClientsInRoom(roomId) >= MAX_USERS_PER_ROOM) {
    const label = formatRoomLabel(roomId);
    const msg = `${label} is full (${MAX_USERS_PER_ROOM} max).`;
    ws.send(JSON.stringify({ type: "room-error", message: msg }));
    ws.close(4004, `${label} full`);
    return;
  }

  const room = ensureRoom(roomId);
  cancelIdleWipe(room);

  const userId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = {
    id: userId,
    name: "Artist",
    color: randomColor(),
  };

  room.users.set(userId, user);
  ws.userId = userId;
  ws.roomId = roomId;
  ws.ownerKey = userId;
  ws.undoStack = [];
  ws.redoStack = [];

  addChat(room, "System", `${user.name} joined ${formatRoomLabel(roomId)}.`);
  sendInitState(ws, room);
  broadcastUsers(roomId);
  broadcastChat(roomId);
  touchRoomActivity(room);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    const currentRoom = rooms.get(ws.roomId);
    if (!currentRoom) return;
    const current = currentRoom.users.get(ws.userId);
    if (!current) return;

    if (msg.type === "set-name") {
      current.name = safeName(msg.name);
      const key = sanitizeClientKey(msg.clientKey);
      if (key) ws.ownerKey = key;
      addChat(currentRoom, "System", `${current.name} updated their name.`);
      broadcastUsers(currentRoom.id);
      broadcastChat(currentRoom.id);
      touchRoomActivity(currentRoom);
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
        const prevColor = currentRoom.pixels[y][x];
        const prevOwner = currentRoom.owners[y][x];
        if (prevColor === color) continue;
        changes.push({ x, y, from: prevColor, to: color, fromOwner: prevOwner, toOwner: ws.ownerKey });
        currentRoom.pixels[y][x] = color;
        currentRoom.owners[y][x] = ws.ownerKey;
        updates.push({ x, y, color });
      }
      if (changes.length > 0) {
        mergePaintBroadcastPixels(currentRoom, updates);
        ws.undoStack.push({ changes });
        if (ws.undoStack.length > 80) ws.undoStack.shift();
        ws.redoStack = [];
        touchRoomActivity(currentRoom);
      }
      return;
    }

    if (msg.type === "undo") {
      const action = ws.undoStack.pop();
      if (!action) return;
      const updates = [];
      for (const change of action.changes) {
        currentRoom.pixels[change.y][change.x] = change.from;
        currentRoom.owners[change.y][change.x] = change.fromOwner || null;
        updates.push({ x: change.x, y: change.y, color: change.from });
      }
      broadcastPixelsUpdated(currentRoom.id, updates);
      ws.redoStack.push(action);
      if (ws.redoStack.length > 80) ws.redoStack.shift();
      touchRoomActivity(currentRoom);
      return;
    }

    if (msg.type === "redo") {
      const action = ws.redoStack.pop();
      if (!action) return;
      const updates = [];
      for (const change of action.changes) {
        currentRoom.pixels[change.y][change.x] = change.to;
        currentRoom.owners[change.y][change.x] = change.toOwner || null;
        updates.push({ x: change.x, y: change.y, color: change.to });
      }
      broadcastPixelsUpdated(currentRoom.id, updates);
      ws.undoStack.push(action);
      if (ws.undoStack.length > 80) ws.undoStack.shift();
      touchRoomActivity(currentRoom);
      return;
    }

    if (msg.type === "clear-board") {
      const updates = [];
      for (let y = 0; y < GRID_HEIGHT; y += 1) {
        for (let x = 0; x < GRID_WIDTH; x += 1) {
          if (currentRoom.owners[y][x] !== ws.ownerKey) continue;
          currentRoom.pixels[y][x] = DEFAULT_PIXEL;
          currentRoom.owners[y][x] = null;
          updates.push({ x, y, color: DEFAULT_PIXEL });
        }
      }
      if (updates.length > 0) {
        broadcastPixelsUpdated(currentRoom.id, updates);
      }
      ws.undoStack = [];
      ws.redoStack = [];
      addChat(currentRoom, "System", `${current.name} cleared their drawing.`);
      broadcastChat(currentRoom.id);
      touchRoomActivity(currentRoom);
      return;
    }

    if (msg.type === "chat") {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 120) : "";
      if (!text) return;
      addChat(currentRoom, current.name, text, current.id);
      broadcastChat(currentRoom.id);
      touchRoomActivity(currentRoom);
    }
  });

  ws.on("close", () => {
    const currentRoom = rooms.get(ws.roomId);
    if (!currentRoom) return;
    const current = currentRoom.users.get(ws.userId);
    if (current) {
      addChat(currentRoom, "System", `${current.name} left ${formatRoomLabel(currentRoom.id)}.`);
      currentRoom.users.delete(ws.userId);
      broadcastUsers(currentRoom.id);
      broadcastChat(currentRoom.id);
    }
    scheduleIdleWipeIfEmpty(currentRoom.id);
  });
});

server.listen(PORT, () => {
  console.log(`Pixel Board server running on port ${PORT}`);
  console.log(
    `Rooms: ${MAX_ROOMS} total, ${MAX_USERS_PER_ROOM} users each. Saves: ${ROOMS_DIR} (retention ${RETENTION_MS / 3600000}h, idle wipe ${IDLE_WIPE_MS / 60000}m).`
  );
});
