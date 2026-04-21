// client.js
// This file handles drawing on the canvas and sending/receiving live updates.

const DEFAULT_REMOTE_SERVER = "https://your-render-service.onrender.com";
const isGitHubPages = window.location.hostname.endsWith("github.io");

// On localhost we use same-origin.
// On GitHub Pages we ask once for your backend URL and save it.
let socketServerUrl = "";
if (isGitHubPages) {
  socketServerUrl = localStorage.getItem("socketServerUrl") || DEFAULT_REMOTE_SERVER;
  if (socketServerUrl === DEFAULT_REMOTE_SERVER) {
    const enteredUrl = window.prompt(
      "Enter your deployed backend URL (example: https://my-draw-app.onrender.com):",
      socketServerUrl
    );
    if (enteredUrl && enteredUrl.trim()) {
      socketServerUrl = enteredUrl.trim();
      localStorage.setItem("socketServerUrl", socketServerUrl);
    }
  }
}

const socket = socketServerUrl ? io(socketServerUrl) : io(); // Connect to Socket.IO server
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const clearBtn = document.getElementById("clearBtn");
const brushSizeSlider = document.getElementById("brushSize");
const brushSizeValue = document.getElementById("brushSizeValue");
const userCountEl = document.getElementById("userCount");
const userInfoEl = document.getElementById("userInfo");

let isDrawing = false;
let lastX = 0;
let lastY = 0;
let myColor = "#222";
let myUsername = "Anonymous";

// Basic brush style
ctx.strokeStyle = myColor;
ctx.lineWidth = 3;
ctx.lineCap = "round";

// Draw a tiny colored name tag near the stroke endpoint.
function drawNameTag(x, y, username, color) {
  if (!username) return;
  ctx.font = "11px Arial";
  ctx.fillStyle = color || "#222";
  ctx.fillText(username, x + 6, y - 6);
}

// Draw one line segment on the local canvas.
function drawLine(x0, y0, x1, y1, color, size, username) {
  ctx.beginPath();
  ctx.strokeStyle = color || "#222";
  ctx.lineWidth = size || 3;
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  drawNameTag(x1, y1, username, color);
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
  const line = {
    x0: lastX,
    y0: lastY,
    x1: pos.x,
    y1: pos.y,
    color: myColor,
    size: Number(brushSizeSlider.value),
    username: myUsername,
  };

  // Draw locally first, then broadcast
  drawLine(line.x0, line.y0, line.x1, line.y1, line.color, line.size, line.username);
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

// Update brush-size label when slider changes.
brushSizeSlider.addEventListener("input", () => {
  brushSizeValue.textContent = brushSizeSlider.value;
});

// Draw lines received from any user
socket.on("draw", (line) => {
  drawLine(line.x0, line.y0, line.x1, line.y1, line.color, line.size, line.username);
});

// Load history when we first connect
socket.on("load-canvas", (history) => {
  history.forEach((line) => {
    drawLine(line.x0, line.y0, line.x1, line.y1, line.color, line.size, line.username);
  });
});

// Clear canvas when server says so
socket.on("clear-canvas", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

// Ask for username when joining and send it to server.
socket.on("request-join", () => {
  const name = window.prompt("Enter your username:", "Student");
  myUsername = name && name.trim() ? name.trim().slice(0, 20) : "Anonymous";
  socket.emit("join-user", myUsername);
});

// Receive profile info including random color assigned by server.
socket.on("user-profile", (profile) => {
  myUsername = profile.username;
  myColor = profile.color;
  userInfoEl.textContent = `User: ${myUsername}`;
  userInfoEl.style.color = myColor;
});

// Show how many users are connected.
socket.on("user-count", (count) => {
  userCountEl.textContent = `Users online: ${count}`;
});

socket.on("connect_error", () => {
  userCountEl.textContent = "Users online: offline";
  userInfoEl.textContent = "User: connection failed";
});
