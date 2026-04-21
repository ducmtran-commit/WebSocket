const DEFAULT_REMOTE_SERVER = "https://your-render-service.onrender.com";
const isGitHubPages = window.location.hostname.endsWith("github.io");

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

const socket = socketServerUrl ? io(socketServerUrl) : io();
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

ctx.strokeStyle = myColor;
ctx.lineWidth = 3;
ctx.lineCap = "round";

function drawNameTag(x, y, username, color) {
  if (!username) return;
  ctx.font = "11px Arial";
  ctx.fillStyle = color || "#222";
  ctx.fillText(username, x + 6, y - 6);
}

function drawLine(x0, y0, x1, y1, color, size, username) {
  ctx.beginPath();
  ctx.strokeStyle = color || "#222";
  ctx.lineWidth = size || 3;
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  drawNameTag(x1, y1, username, color);
}

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

clearBtn.addEventListener("click", () => {
  socket.emit("clear-canvas");
});

brushSizeSlider.addEventListener("input", () => {
  brushSizeValue.textContent = brushSizeSlider.value;
});

socket.on("draw", (line) => {
  drawLine(line.x0, line.y0, line.x1, line.y1, line.color, line.size, line.username);
});

socket.on("load-canvas", (history) => {
  history.forEach((line) => {
    drawLine(line.x0, line.y0, line.x1, line.y1, line.color, line.size, line.username);
  });
});

socket.on("clear-canvas", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

socket.on("request-join", () => {
  const name = window.prompt("Enter your username:", "Student");
  myUsername = name && name.trim() ? name.trim().slice(0, 20) : "Anonymous";
  socket.emit("join-user", myUsername);
});

socket.on("user-profile", (profile) => {
  myUsername = profile.username;
  myColor = profile.color;
  userInfoEl.textContent = `User: ${myUsername}`;
  userInfoEl.style.color = myColor;
});

socket.on("user-count", (count) => {
  userCountEl.textContent = `Users online: ${count}`;
});

socket.on("connect_error", () => {
  userCountEl.textContent = "Users online: offline";
  userInfoEl.textContent = "User: connection failed";
});
