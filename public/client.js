// client.js
// Frontend drawing logic + WebSocket communication with reconnection support.

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const roomInput = document.getElementById("roomInput");
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const colorInput = document.getElementById("colorInput");
const sizeInput = document.getElementById("sizeInput");
const sizeValue = document.getElementById("sizeValue");
const clearBtn = document.getElementById("clearBtn");
const statusBadge = document.getElementById("statusBadge");
const roomBadge = document.getElementById("roomBadge");
const countBadge = document.getElementById("countBadge");

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

let drawing = false;
let currentStrokeId = null;
let currentRoom = "main";
let hasLoadedState = false;

sizeValue.textContent = sizeInput.value;

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function setStatus(text) {
  statusBadge.textContent = `Status: ${text}`;
}

function sendJson(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function drawPoint(x, y, color, size) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, size / 2), 0, Math.PI * 2);
  ctx.fill();
}

function drawSegment(x0, y0, x1, y1, color, size) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function clearCanvasLocal() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// We store previous point by stroke id for replay of draw-move events.
const lastPointByStroke = new Map();

function handleDrawEvent(msg) {
  const { type, strokeId, x, y, color, size } = msg;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  if (type === "draw-start") {
    drawPoint(x, y, color, size);
    lastPointByStroke.set(strokeId, { x, y, color, size });
    return;
  }

  if (type === "draw-move") {
    const prev = lastPointByStroke.get(strokeId);
    if (prev) {
      drawSegment(prev.x, prev.y, x, y, color, size);
    } else {
      drawPoint(x, y, color, size);
    }
    lastPointByStroke.set(strokeId, { x, y, color, size });
    return;
  }

  if (type === "draw-end") {
    const prev = lastPointByStroke.get(strokeId);
    if (prev) {
      drawSegment(prev.x, prev.y, x, y, color, size);
    }
    lastPointByStroke.delete(strokeId);
  }
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  setStatus("connecting...");
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setStatus("connected");
    sendJson({
      type: "join-room",
      roomId: currentRoom,
      username: nameInput.value.trim() || "Anonymous",
    });
  });

  ws.addEventListener("message", (event) => {
    let msg = null;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "init-state") {
      // Only clear when first state arrives, so reconnects restore full state.
      clearCanvasLocal();
      lastPointByStroke.clear();
      (msg.strokes || []).forEach((stroke) => handleDrawEvent(stroke));
      hasLoadedState = true;
      countBadge.textContent = `Users: ${msg.count ?? 0}`;
      roomBadge.textContent = `Room: ${msg.roomId || currentRoom}`;
      return;
    }

    if (msg.type === "draw-start" || msg.type === "draw-move" || msg.type === "draw-end") {
      handleDrawEvent(msg);
      return;
    }

    if (msg.type === "clear-canvas") {
      clearCanvasLocal();
      lastPointByStroke.clear();
      return;
    }

    if (msg.type === "user-count") {
      if (msg.roomId && msg.roomId !== currentRoom) return;
      countBadge.textContent = `Users: ${msg.count}`;
    }
  });

  ws.addEventListener("close", () => {
    setStatus("disconnected, reconnecting...");
    hasLoadedState = false;
    const delay = Math.min(10000, 500 * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  });

  ws.addEventListener("error", () => {
    setStatus("connection error");
  });
}

function canvasPos(event) {
  const rect = canvas.getBoundingClientRect();
  const pointer = event.touches ? event.touches[0] : event;
  const x = ((pointer.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((pointer.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function beginStroke(event) {
  event.preventDefault();
  if (!hasLoadedState) return;
  drawing = true;
  currentStrokeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { x, y } = canvasPos(event);
  const color = colorInput.value;
  const size = Number(sizeInput.value);

  handleDrawEvent({ type: "draw-start", strokeId: currentStrokeId, x, y, color, size });
  sendJson({ type: "draw-start", strokeId: currentStrokeId, x, y, color, size });
}

function moveStroke(event) {
  if (!drawing) return;
  event.preventDefault();

  const { x, y } = canvasPos(event);
  const color = colorInput.value;
  const size = Number(sizeInput.value);

  handleDrawEvent({ type: "draw-move", strokeId: currentStrokeId, x, y, color, size });
  sendJson({ type: "draw-move", strokeId: currentStrokeId, x, y, color, size });
}

function endStroke(event) {
  if (!drawing) return;
  event.preventDefault();
  drawing = false;

  const { x, y } = canvasPos(event.changedTouches ? event.changedTouches[0] : event);
  const color = colorInput.value;
  const size = Number(sizeInput.value);

  handleDrawEvent({ type: "draw-end", strokeId: currentStrokeId, x, y, color, size });
  sendJson({ type: "draw-end", strokeId: currentStrokeId, x, y, color, size });
  currentStrokeId = null;
}

// Mouse + touch support.
canvas.addEventListener("mousedown", beginStroke);
canvas.addEventListener("mousemove", moveStroke);
window.addEventListener("mouseup", endStroke);

canvas.addEventListener("touchstart", beginStroke, { passive: false });
canvas.addEventListener("touchmove", moveStroke, { passive: false });
canvas.addEventListener("touchend", endStroke, { passive: false });

sizeInput.addEventListener("input", () => {
  sizeValue.textContent = sizeInput.value;
});

clearBtn.addEventListener("click", () => {
  clearCanvasLocal();
  lastPointByStroke.clear();
  sendJson({ type: "clear-canvas" });
});

joinBtn.addEventListener("click", () => {
  currentRoom = roomInput.value.trim() || "main";
  roomBadge.textContent = `Room: ${currentRoom}`;
  clearCanvasLocal();
  lastPointByStroke.clear();
  sendJson({
    type: "join-room",
    roomId: currentRoom,
    username: nameInput.value.trim() || "Anonymous",
  });
});

connect();
