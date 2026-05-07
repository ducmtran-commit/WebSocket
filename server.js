const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

function readEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const DATA_DIR =
  typeof process.env.BOARD_DATA_DIR === "string" && process.env.BOARD_DATA_DIR.trim()
    ? process.env.BOARD_DATA_DIR.trim()
    : path.join(__dirname, "data");
const ROOMS_DIR = path.join(DATA_DIR, "rooms");
const RETENTION_MS = Math.max(72, readEnvNumber("BOARD_RETENTION_HOURS", 72)) * 60 * 60 * 1000;
const PUBLIC_IDLE_WIPE_MS = Math.max(4320, readEnvNumber("BOARD_IDLE_WIPE_MINUTES", 4320)) * 60 * 1000;
const PRIVATE_IDLE_DELETE_MS =
  Math.max(5, readEnvNumber("PRIVATE_ROOM_IDLE_DELETE_MINUTES", 5)) * 60 * 1000;
const SAVE_DEBOUNCE_MS = Math.max(3000, Number(process.env.BOARD_SAVE_DEBOUNCE_MS || 12000));
const PAINT_BROADCAST_MERGE_MS = Math.max(4, Number(process.env.PAINT_BROADCAST_MERGE_MS || 8));
const MAX_ROOMS = Math.max(1, Number(process.env.MAX_ROOMS || 5));
const MAX_USERS_PER_ROOM = Math.max(1, Number(process.env.MAX_USERS_PER_ROOM || 30));
const MAX_UNDO_ACTIONS = Math.max(40, Number(process.env.MAX_UNDO_ACTIONS || 240));
const PUBLIC_ROOM_ID = "lobby";

const GRID_WIDTH = 256;
const GRID_HEIGHT = 192;
const DEFAULT_PIXEL = "#0b1220";

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/api/rooms", (_req, res) => {
  const payload = Array.from(rooms.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((room) => ({
      id: room.id,
      label: formatRoomLabel(room.id),
      users: countOpenClientsInRoom(room.id),
      capacity: MAX_USERS_PER_ROOM,
      isPublic: room.isPublic === true,
      isLocked: Boolean(room.password),
    }));
  res.json({
    maxRooms: MAX_ROOMS,
    maxUsersPerRoom: MAX_USERS_PER_ROOM,
    usedRooms: rooms.size,
    rooms: payload,
  });
});

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

function roomHasSavedState(roomId) {
  try {
    return fs.existsSync(roomFile(roomId));
  } catch {
    return false;
  }
}

function removeRoomSaveFile(roomId) {
  try {
    fs.unlinkSync(roomFile(roomId));
  } catch {
    // File may not exist.
  }
}

function formatRoomLabel(roomId) {
  if (roomId === PUBLIC_ROOM_ID) return "LOBBY";
  return String(roomId || "").replace(/-/g, " ").toUpperCase();
}

function normalizeRoomPassword(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 20);
}

function createRoomState(roomId, options = {}) {
  return {
    id: roomId,
    isPublic: Boolean(options.isPublic),
    password: normalizeRoomPassword(options.password),
    users: new Map(),
    pixels: createEmptyPixels(),
    owners: createEmptyOwners(),
    chat: [],
    lastActivityAt: Date.now(),
    boardDirty: false,
    saveInFlight: false,
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

function roomHasConnectedUsers(room) {
  if (!room || !(room.users instanceof Map)) return false;
  if (room.users.size > 0) return true;
  // Fallback for edge races while ws state catches up.
  return countOpenClientsInRoom(room.id) > 0;
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
  if (roomHasConnectedUsers(room)) return;
  const idleMs = room.isPublic ? PUBLIC_IDLE_WIPE_MS : PRIVATE_IDLE_DELETE_MS;
  const elapsedMs = Date.now() - Number(room.lastActivityAt || 0);
  if (elapsedMs < idleMs) {
    // Guard against stale/short timers from transient config/process mismatches.
    scheduleIdleWipeIfEmpty(roomId);
    return;
  }
  if (room.isPublic) {
    resetRoomToEmpty(room);
    room.lastActivityAt = Date.now();
    room.boardDirty = false;
    try {
      fs.unlinkSync(roomFile(roomId));
    } catch {
      // File may not exist.
    }
    console.log(`${formatRoomLabel(roomId)} wiped after idle timeout.`);
    return;
  }
  try {
    fs.unlinkSync(roomFile(roomId));
  } catch {
    // File may not exist.
  }
  rooms.delete(roomId);
  console.log(`${formatRoomLabel(roomId)} removed after idle timeout.`);
}

function scheduleIdleWipeIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (roomHasConnectedUsers(room)) return;
  cancelIdleWipe(room);
  const idleMs = room.isPublic ? PUBLIC_IDLE_WIPE_MS : PRIVATE_IDLE_DELETE_MS;
  console.log(
    `${formatRoomLabel(roomId)} idle timer scheduled for ${Math.round(idleMs / 60000)}m (users=${room.users.size}).`
  );
  room.idleWipeTimer = setTimeout(() => {
    performIdleWipe(roomId);
  }, idleMs);
}

function roomSavePayload(room) {
  return JSON.stringify({
    version: 1,
    roomId: room.id,
    isPublic: room.isPublic === true,
    roomPassword: room.password || "",
    lastActivityAt: room.lastActivityAt,
    pixels: room.pixels,
    chat: room.chat,
  });
}

async function flushRoomSave(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.saveDebounceTimer = null;
  if (!room.boardDirty) return;
  if (room.saveInFlight) return;
  room.boardDirty = false;
  room.saveInFlight = true;
  try {
    await fs.promises.mkdir(ROOMS_DIR, { recursive: true });
    const payload = roomSavePayload(room);
    const file = roomFile(roomId);
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, payload, "utf8");
    await fs.promises.rename(tmp, file);
  } catch (err) {
    console.warn(`${formatRoomLabel(roomId)} save failed:`, err.message);
    room.boardDirty = true;
  } finally {
    room.saveInFlight = false;
    if (room.boardDirty && room.saveDebounceTimer == null) {
      room.saveDebounceTimer = setTimeout(() => {
        void flushRoomSave(room.id);
      }, Math.min(1200, SAVE_DEBOUNCE_MS));
    }
  }
}

function flushRoomSaveSync(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.boardDirty) return;
  room.boardDirty = false;
  try {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    const payload = roomSavePayload(room);
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
    void flushRoomSave(room.id);
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
    room.isPublic = data.isPublic === true || room.id === PUBLIC_ROOM_ID;
    room.password = normalizeRoomPassword(data.roomPassword || room.password || "");
    room.lastActivityAt = savedAt;
    console.log(`${formatRoomLabel(room.id)} restored from disk.`);
  } catch (err) {
    console.warn(`${formatRoomLabel(room.id)} load failed:`, err.message);
  }
}

function ensureRoom(roomId, options = {}) {
  let room = rooms.get(roomId);
  if (room) {
    if (options.resetState === true) {
      resetRoomToEmpty(room);
      room.lastActivityAt = Date.now();
      room.boardDirty = false;
      room.users.clear();
      removeRoomSaveFile(roomId);
    }
    if (options.password) {
      room.password = normalizeRoomPassword(options.password);
    }
    if (options.isPublic === true) {
      room.isPublic = true;
    }
    return room;
  }
  room = createRoomState(roomId, options);
  if (options.skipLoadFromDisk !== true) {
    tryLoadRoomFromDisk(room);
  } else {
    removeRoomSaveFile(roomId);
  }
  if (options.password) {
    room.password = normalizeRoomPassword(options.password);
  }
  if (options.isPublic === true) {
    room.isPublic = true;
  }
  rooms.set(roomId, room);
  return room;
}

ensureRoom(PUBLIC_ROOM_ID, { isPublic: true });

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.boardDirty && room.saveDebounceTimer == null) {
      void flushRoomSave(room.id);
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
      flushRoomSaveSync(room.id);
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

const USER_COLOR_PALETTE = ["#f97316", "#0ea5e9", "#22c55e", "#a855f7", "#ef4444", "#14b8a6", "#eab308", "#f43f5e", "#06b6d4", "#84cc16"];

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hslToHex(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) {
    r = c;
    g = x;
  } else if (hh < 120) {
    r = x;
    g = c;
  } else if (hh < 180) {
    g = c;
    b = x;
  } else if (hh < 240) {
    g = x;
    b = c;
  } else if (hh < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function nextUserColor(room, seedText = "") {
  const used = new Set(
    Array.from(room.users.values())
      .map((u) => String(u.color || "").toLowerCase())
      .filter((c) => /^#[0-9a-f]{6}$/.test(c))
  );
  for (const color of USER_COLOR_PALETTE) {
    if (!used.has(color)) return color;
  }
  const seed = hashString(`${room.id}:${seedText}:${Date.now()}:${Math.random()}`);
  for (let i = 0; i < 30; i += 1) {
    const hue = (seed + i * 31) % 360;
    const color = hslToHex(hue, 78, 58).toLowerCase();
    if (!used.has(color)) return color;
  }
  return hslToHex(seed % 360, 70, 55).toLowerCase();
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
      roomPassword: room.password || "",
      isPublicRoom: room.isPublic === true,
      selfUserId: ws.userId,
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

function broadcastDrawingActivity(roomId, user, point) {
  if (!user || !point) return;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  broadcastToRoom(roomId, {
    type: "drawing-activity",
    user: {
      id: user.id,
      name: user.name,
      color: user.color,
    },
    point: {
      x,
      y,
      color: typeof point.color === "string" ? point.color : user.color,
    },
    at: Date.now(),
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
    }, PAINT_BROADCAST_MERGE_MS);
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
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  if (!cleaned) return null;
  if (!/^[a-z0-9][a-z0-9_-]{1,19}$/.test(cleaned)) return null;
  return cleaned;
}

function isPasswordValidForRoom(room, passwordInput) {
  const expected = normalizeRoomPassword(room.password || "");
  if (!expected) return true;
  const provided = normalizeRoomPassword(passwordInput);
  return expected === provided;
}

function canCreateNewRoom() {
  return rooms.size < MAX_ROOMS;
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
  const password = normalizeRoomPassword(query.get("password"));
  const existingRoom = requestedRoom ? rooms.get(requestedRoom) : null;

  if (mode === "start") {
    return { roomId: PUBLIC_ROOM_ID };
  }

  if (mode === "join") {
    if (!requestedRoom) {
      return {
        errorCode: 4003,
        errorMessage: "Invalid room name.",
      };
    }
    let roomForJoin = existingRoom;
    if (!roomForJoin && roomHasSavedState(requestedRoom)) {
      roomForJoin = ensureRoom(requestedRoom, {
        isPublic: requestedRoom === PUBLIC_ROOM_ID,
      });
    }
    if (!roomForJoin) {
      return {
        errorCode: 4006,
        errorMessage: "Room does not exist.",
      };
    }
    if (!isPasswordValidForRoom(roomForJoin, password)) {
      return {
        errorCode: 4005,
        errorMessage: "Invalid room password.",
      };
    }
    return { roomId: requestedRoom };
  }

  if (mode === "create") {
    if (!requestedRoom || requestedRoom === PUBLIC_ROOM_ID) {
      return {
        errorCode: 4003,
        errorMessage: "Choose a custom room name.",
      };
    }
    if (password.length < 4) {
      return {
        errorCode: 4007,
        errorMessage: "Password must be at least 4 characters.",
      };
    }
    if (existingRoom || roomHasSavedState(requestedRoom)) {
      return {
        errorCode: 4008,
        errorMessage: "Room already exists. Use Join Room.",
      };
    }
    if (!canCreateNewRoom()) {
      return {
        errorCode: 4004,
        errorMessage: `Room limit reached (${MAX_ROOMS}).`,
      };
    }
    return { roomId: requestedRoom, createPassword: password, createFresh: true };
  }

  return {
    errorCode: 4003,
    errorMessage: "Unsupported room mode.",
  };
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
  const room = ensureRoom(roomId, {
    isPublic: roomId === PUBLIC_ROOM_ID,
    password: resolved.createPassword || "",
    skipLoadFromDisk: resolved.createFresh === true,
    resetState: resolved.createFresh === true,
  });
  if (countOpenClientsInRoom(roomId) >= MAX_USERS_PER_ROOM) {
    const label = formatRoomLabel(roomId);
    const msg = `${label} is full (${MAX_USERS_PER_ROOM} max).`;
    ws.send(JSON.stringify({ type: "room-error", message: msg }));
    ws.close(4004, `${label} full`);
    return;
  }
  cancelIdleWipe(room);

  const userId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = {
    id: userId,
    name: "Artist",
    color: nextUserColor(room, userId),
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
        const now = Date.now();
        if (!ws.lastDrawingActivityBroadcastAt || now - ws.lastDrawingActivityBroadcastAt > 320) {
          ws.lastDrawingActivityBroadcastAt = now;
          broadcastDrawingActivity(currentRoom.id, current, updates[updates.length - 1]);
        }
        ws.undoStack.push({ changes });
        if (ws.undoStack.length > MAX_UNDO_ACTIONS) ws.undoStack.shift();
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
      if (ws.redoStack.length > MAX_UNDO_ACTIONS) ws.redoStack.shift();
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
      if (ws.undoStack.length > MAX_UNDO_ACTIONS) ws.undoStack.shift();
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
    `Rooms: ${MAX_ROOMS} total, ${MAX_USERS_PER_ROOM} users each. Saves: ${ROOMS_DIR} (retention ${RETENTION_MS / 3600000}h, public idle wipe ${PUBLIC_IDLE_WIPE_MS / 60000}m, private idle delete ${PRIVATE_IDLE_DELETE_MS / 60000}m).`
  );
});
