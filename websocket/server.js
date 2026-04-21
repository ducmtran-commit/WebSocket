const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const COLORS = [
  "#e63946",
  "#2a9d8f",
  "#e9c46a",
  "#264653",
  "#8338ec",
  "#ff6b35",
  "#06d6a0",
  "#118ab2",
];

const MAX_STROKES = 10000;
const strokeHistory = [];
let colorIndex = 0;

const app = express();
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(obj, except) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client === except) continue;
    if (client.readyState === 1) client.send(data);
  }
}

function broadcastAll(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on("connection", (ws) => {
  const userId = crypto.randomUUID();
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex += 1;

  ws.userId = userId;
  ws.userColor = color;

  ws.send(
    JSON.stringify({
      type: "welcome",
      userId,
      color,
      strokes: strokeHistory,
      peers: [...wss.clients]
        .filter((c) => c !== ws && c.readyState === 1)
        .map((c) => ({
          userId: c.userId,
          color: c.userColor,
          name: c.displayName || null,
        })),
    })
  );

  broadcast(
    {
      type: "join",
      userId,
      color,
    },
    ws
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "hello" && typeof msg.name === "string") {
      const name = msg.name.trim().slice(0, 24) || "Anonymous";
      ws.displayName = name;
      broadcastAll({
        type: "profile",
        userId,
        color,
        name,
      });
      return;
    }

    if (msg.type === "stroke") {
      const n = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
      const x0 = n(msg.x0);
      const y0 = n(msg.y0);
      const x1 = n(msg.x1);
      const y1 = n(msg.y1);
      const width = typeof msg.width === "number" && msg.width > 0 && msg.width <= 0.2 ? msg.width : 0.004;
      if (x0 === null || y0 === null || x1 === null || y1 === null) return;

      const stroke = {
        type: "stroke",
        userId,
        color: ws.userColor,
        x0,
        y0,
        x1,
        y1,
        width,
      };
      strokeHistory.push(stroke);
      if (strokeHistory.length > MAX_STROKES) strokeHistory.shift();
      broadcastAll(stroke);
      return;
    }

    if (msg.type === "clear") {
      strokeHistory.length = 0;
      broadcastAll({ type: "clear" });
      return;
    }

    if (msg.type === "cursor") {
      const nx = typeof msg.x === "number" ? Math.min(1, Math.max(0, msg.x)) : null;
      const ny = typeof msg.y === "number" ? Math.min(1, Math.max(0, msg.y)) : null;
      if (nx === null || ny === null) return;
      broadcast(
        {
          type: "cursor",
          userId,
          color: ws.userColor,
          name: ws.displayName || "Anonymous",
          x: nx,
          y: ny,
        },
        ws
      );
    }
  });

  ws.on("close", () => {
    broadcast({
      type: "leave",
      userId,
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Collab canvas at http://localhost:${PORT}`);
  console.log(`Open two browser windows to the same URL to draw together.`);
});
