// server.js
// Node + Express + ws server for the Collaborative Canvas class project.

const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve frontend files from /public.
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Room state is kept in memory:
// - strokes: full drawing history for that room
// - clients: currently connected sockets in that room
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { strokes: [], clients: new Set() });
  }
  return rooms.get(roomId);
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

wss.on("connection", (ws) => {
  // Set defaults until the client joins a room.
  ws.roomId = "main";
  ws.username = "Anonymous";

  // Put user in default room immediately so first-time users can collaborate.
  const room = getOrCreateRoom(ws.roomId);
  room.clients.add(ws);

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

  ws.on("message", (raw) => {
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

      broadcastToRoom(ws.roomId, event, ws);
      return;
    }

    if (msg.type === "clear-canvas") {
      activeRoom.strokes = [];
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
});
