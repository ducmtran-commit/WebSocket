// server.js
// This file creates one Node.js server using Express + Socket.IO.
// It stores drawing history in memory and shares updates with all clients.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Serve the frontend files from the public folder.
app.use(express.static(path.join(__dirname, "public")));

// Keep all line segments in memory so new users can see existing drawing.
const strokes = [];

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send existing drawing history to the newly connected client only.
  socket.emit("load-canvas", strokes);

  // Receive a new line segment and broadcast it to other users.
  socket.on("draw", (line) => {
    strokes.push(line);
    socket.broadcast.emit("draw", line);
  });

  // Clear shared history and tell all clients to clear their canvas.
  socket.on("clear-canvas", () => {
    strokes.length = 0;
    io.emit("clear-canvas");
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
