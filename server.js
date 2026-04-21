// server.js
// Node + Express + ws server for the Collaborative Canvas class project.

const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const USE_DB = Boolean(DATABASE_URL);
const pool = USE_DB
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })
  : null;

// Serve frontend files from /public.
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Room state is kept in memory:
// - strokes: full drawing history for that room
// - clients: currently connected sockets in that room
const rooms = new Map();
const pendingSaveTimers = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { strokes: [], clients: new Set() });
  }
  return rooms.get(roomId);
}

async function ensureDbSchema() {
  if (!USE_DB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canvas_rooms (
      room_id TEXT PRIMARY KEY,
      strokes JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function loadRoomStrokes(roomId) {
  if (!USE_DB) return null;
  const result = await pool.query("SELECT strokes FROM canvas_rooms WHERE room_id = $1", [roomId]);
  if (result.rowCount === 0) return [];
  return Array.isArray(result.rows[0].strokes) ? result.rows[0].strokes : [];
}

function scheduleRoomSave(roomId) {
  if (!USE_DB) return;
  if (pendingSaveTimers.has(roomId)) return;

  // Batch writes so draw-move does not hit DB on every message.
  const timer = setTimeout(async () => {
    pendingSaveTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (!room) return;
    try {
      await pool.query(
        `
        INSERT INTO canvas_rooms (room_id, strokes, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (room_id)
        DO UPDATE SET strokes = EXCLUDED.strokes, updated_at = NOW()
      `,
        [roomId, JSON.stringify(room.strokes)]
      );
    } catch (error) {
      console.error("Failed to persist room:", roomId, error.message);
    }
  }, 800);

  pendingSaveTimers.set(roomId, timer);
}

function broadcastToRoom(roomId, message, exceptClient = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const payload = JSON.stringify(message);
  for (const client of room.clients) {
    if (client === exceptClient) continue;
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function sendUserCount(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  broadcastToRoom(roomId, {
    type: "user-count",
    count: room.clients.size,
    roomId,
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

wss.on("connection", async (ws) => {
  // Set defaults until the client joins a room.
  ws.roomId = "main";
  ws.username = "Anonymous";

  // Put user in default room immediately so first-time users can collaborate.
  const room = getOrCreateRoom(ws.roomId);
  room.clients.add(ws);
  if (USE_DB && room.strokes.length === 0) {
    try {
      room.strokes = await loadRoomStrokes(ws.roomId);
    } catch (error) {
      console.error("Failed loading main room from DB:", error.message);
    }
  }

  // Send existing room drawing state to just this new user.
  ws.send(
    JSON.stringify({
      type: "init-state",
      roomId: ws.roomId,
      strokes: room.strokes,
      count: room.clients.size,
    })
  );

  sendUserCount(ws.roomId);

  ws.on("message", async (raw) => {
    const msg = parseJson(raw);
    if (!msg || typeof msg.type !== "string") return;

    // Optional room support:
    // client can switch/create rooms with a room id and name.
    if (msg.type === "join-room") {
      const nextRoomId =
        typeof msg.roomId === "string" && msg.roomId.trim()
          ? msg.roomId.trim().slice(0, 30)
          : "main";
      const nextUsername =
        typeof msg.username === "string" && msg.username.trim()
          ? msg.username.trim().slice(0, 24)
          : "Anonymous";

      const prevRoomId = ws.roomId;
      if (rooms.has(prevRoomId)) {
        rooms.get(prevRoomId).clients.delete(ws);
        sendUserCount(prevRoomId);
      }

      ws.roomId = nextRoomId;
      ws.username = nextUsername;
      const nextRoom = getOrCreateRoom(nextRoomId);
      if (USE_DB && nextRoom.strokes.length === 0) {
        try {
          nextRoom.strokes = await loadRoomStrokes(nextRoomId);
        } catch (error) {
          console.error("Failed loading room from DB:", nextRoomId, error.message);
        }
      }
      nextRoom.clients.add(ws);

      ws.send(
        JSON.stringify({
          type: "init-state",
          roomId: nextRoomId,
          strokes: nextRoom.strokes,
          count: nextRoom.clients.size,
        })
      );

      sendUserCount(nextRoomId);
      return;
    }

    const activeRoom = getOrCreateRoom(ws.roomId);

    if (msg.type === "draw-start" || msg.type === "draw-move" || msg.type === "draw-end") {
      const event = {
        type: msg.type,
        roomId: ws.roomId,
        username: ws.username,
        strokeId: typeof msg.strokeId === "string" ? msg.strokeId : "",
        x: Number(msg.x),
        y: Number(msg.y),
        color: typeof msg.color === "string" ? msg.color : "#111111",
        size: Number(msg.size) || 3,
      };

      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;

      // Save every drawing event so new users can replay full state.
      activeRoom.strokes.push(event);

      // Prevent unbounded memory growth for class project scale.
      if (activeRoom.strokes.length > 50000) {
        activeRoom.strokes.shift();
      }

      scheduleRoomSave(ws.roomId);
      broadcastToRoom(ws.roomId, event, ws);
      return;
    }

    if (msg.type === "clear-canvas") {
      activeRoom.strokes = [];
      scheduleRoomSave(ws.roomId);
      broadcastToRoom(ws.roomId, { type: "clear-canvas", roomId: ws.roomId });
    }
  });

  ws.on("close", () => {
    const activeRoom = rooms.get(ws.roomId);
    if (!activeRoom) return;
    activeRoom.clients.delete(ws);
    sendUserCount(ws.roomId);

    // Optional cleanup when room becomes empty.
    if (activeRoom.clients.size === 0) {
      rooms.delete(ws.roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Collaborative Canvas running on port ${PORT}`);
  console.log(USE_DB ? "Persistence: PostgreSQL enabled" : "Persistence: in-memory only");
});

ensureDbSchema().catch((error) => {
  console.error("Database schema setup failed:", error.message);
});
