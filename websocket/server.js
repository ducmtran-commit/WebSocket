// server.js
// This file creates one Node.js server using Express + Socket.IO.
// It stores drawing history in memory and shares updates with all clients.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

// Serve the frontend files from the public folder.
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Keep all line segments in memory so new users can see existing drawing.
const strokes = [];
const users = new Map();

// Create a random color string like "#3fa9d2".
function randomColor() {
  const value = Math.floor(Math.random() * 0xffffff);
  return `#${value.toString(16).padStart(6, "0")}`;
}

function broadcastUserCount() {
  io.emit("user-count", users.size);
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Ask the new user to send their username first.
  socket.emit("request-join");

  // Send existing drawing history to the newly connected client only.
  socket.emit("load-canvas", strokes);
  broadcastUserCount();

  socket.on("join-user", (rawName) => {
    const username =
      typeof rawName === "string" && rawName.trim()
        ? rawName.trim().slice(0, 20)
        : "Anonymous";
    const color = randomColor();

    users.set(socket.id, { username, color });
    socket.emit("user-profile", { username, color });
    broadcastUserCount();
  });

  // Receive a new line segment and broadcast it to other users.
  socket.on("draw", (line) => {
    if (!line || typeof line !== "object") return;
    if (
      typeof line.x0 !== "number" ||
      typeof line.y0 !== "number" ||
      typeof line.x1 !== "number" ||
      typeof line.y1 !== "number"
    ) {
      return;
    }

    strokes.push(line);
    socket.broadcast.emit("draw", line);
  });

  // Clear shared history and tell all clients to clear their canvas.
  socket.on("clear-canvas", () => {
    strokes.length = 0;
    io.emit("clear-canvas");
  });

  socket.on("disconnect", () => {
    users.delete(socket.id);
    broadcastUserCount();
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.IO CORS origin: ${CLIENT_ORIGIN}`);
});
