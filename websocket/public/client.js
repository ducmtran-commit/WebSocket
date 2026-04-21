// client.js
// This file handles drawing on the canvas and sending/receiving live updates.

const socket = io(); // Connect to our Socket.IO server
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const clearBtn = document.getElementById("clearBtn");

let isDrawing = false;
let lastX = 0;
let lastY = 0;

// Basic brush style
ctx.strokeStyle = "#222";
ctx.lineWidth = 3;
ctx.lineCap = "round";

// Draw one line segment on the local canvas
function drawLine(x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

// Convert mouse position to canvas coordinates
function getCanvasPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

canvas.addEventListener("mousedown", (event) => {
  isDrawing = true;
  const pos = getCanvasPosition(event);
  lastX = pos.x;
  lastY = pos.y;
});

canvas.addEventListener("mousemove", (event) => {
  if (!isDrawing) return;

  const pos = getCanvasPosition(event);
  const line = { x0: lastX, y0: lastY, x1: pos.x, y1: pos.y };

  // Draw locally first, then broadcast
  drawLine(line.x0, line.y0, line.x1, line.y1);
  socket.emit("draw", line);

  lastX = pos.x;
  lastY = pos.y;
});

canvas.addEventListener("mouseup", () => {
  isDrawing = false;
});

canvas.addEventListener("mouseleave", () => {
  isDrawing = false;
});

// Ask server to clear for everyone
clearBtn.addEventListener("click", () => {
  socket.emit("clear-canvas");
});

// Draw lines received from any user
socket.on("draw", (line) => {
  drawLine(line.x0, line.y0, line.x1, line.y1);
});

// Load history when we first connect
socket.on("load-canvas", (history) => {
  history.forEach((line) => {
    drawLine(line.x0, line.y0, line.x1, line.y1);
  });
});

// Clear canvas when server says so
socket.on("clear-canvas", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});
