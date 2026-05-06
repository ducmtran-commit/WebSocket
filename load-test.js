const WebSocket = require("ws");
const crypto = require("crypto");

const SERVER = process.env.LOADTEST_SERVER || "ws://localhost:3000";
const ROOM = process.env.LOADTEST_ROOM || "lobby";
const MODE = process.env.LOADTEST_MODE || (ROOM === "lobby" ? "start" : "join");
const PASSWORD = process.env.LOADTEST_PASSWORD || "";
const CLIENTS = clampInt(process.env.LOADTEST_CLIENTS, 30, 1, 300);
const DURATION_S = clampInt(process.env.LOADTEST_DURATION_S, 30, 5, 3600);
const STROKES_PER_S = clampInt(process.env.LOADTEST_STROKES_PER_S, 10, 1, 120);
const PIXELS_PER_STROKE = clampInt(process.env.LOADTEST_PIXELS_PER_STROKE, 6, 1, 80);
const GRID_WIDTH = clampInt(process.env.LOADTEST_GRID_WIDTH, 256, 8, 1024);
const GRID_HEIGHT = clampInt(process.env.LOADTEST_GRID_HEIGHT, 192, 8, 1024);
const REPORT_EVERY_S = clampInt(process.env.LOADTEST_REPORT_EVERY_S, 5, 1, 60);

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wsUrl() {
  const url = new URL(SERVER);
  url.searchParams.set("room", ROOM);
  url.searchParams.set("mode", MODE);
  if (PASSWORD) {
    url.searchParams.set("password", PASSWORD);
  }
  return url.toString();
}

function randInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function randomColor() {
  const r = randInt(256).toString(16).padStart(2, "0");
  const g = randInt(256).toString(16).padStart(2, "0");
  const b = randInt(256).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function makeStroke() {
  const out = [];
  let x = randInt(GRID_WIDTH);
  let y = randInt(GRID_HEIGHT);
  const color = randomColor();
  for (let i = 0; i < PIXELS_PER_STROKE; i += 1) {
    x = Math.max(0, Math.min(GRID_WIDTH - 1, x + randInt(3) - 1));
    y = Math.max(0, Math.min(GRID_HEIGHT - 1, y + randInt(3) - 1));
    out.push({ x, y, color });
  }
  return out;
}

function shortId() {
  return crypto.randomBytes(6).toString("hex");
}

async function main() {
  const targetUrl = wsUrl();
  console.log(`Load test -> ${targetUrl}`);
  console.log(
    `clients=${CLIENTS}, duration=${DURATION_S}s, strokes/s/client=${STROKES_PER_S}, pixels/stroke=${PIXELS_PER_STROKE}`
  );

  const sockets = [];
  const stats = {
    connected: 0,
    closed: 0,
    sendPaintBatch: 0,
    recvPixelsUpdated: 0,
    recvChat: 0,
    recvUsers: 0,
    recvInit: 0,
    errors: 0,
  };

  let running = true;
  let reportTimer = null;

  function printStats(prefix = "stats") {
    console.log(
      `[${prefix}] connected=${stats.connected} closed=${stats.closed} sentPaintBatch=${stats.sendPaintBatch} recvPixelsUpdated=${stats.recvPixelsUpdated} recvUsers=${stats.recvUsers} recvChat=${stats.recvChat} recvInit=${stats.recvInit} errors=${stats.errors}`
    );
  }

  for (let i = 0; i < CLIENTS; i += 1) {
    const ws = new WebSocket(targetUrl);
    const clientName = `bot-${i + 1}`;
    const clientKey = `loadtest-${shortId()}`;
    const strokeMs = Math.max(8, Math.floor(1000 / STROKES_PER_S));
    let strokeTimer = null;

    ws.on("open", () => {
      stats.connected += 1;
      ws.send(
        JSON.stringify({
          type: "set-name",
          name: clientName,
          clientKey,
        })
      );
      strokeTimer = setInterval(() => {
        if (!running || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "paint-batch", pixels: makeStroke() }));
        stats.sendPaintBatch += 1;
      }, strokeMs);
    });

    ws.on("message", (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "init-state") stats.recvInit += 1;
      if (msg.type === "pixels-updated") stats.recvPixelsUpdated += 1;
      if (msg.type === "chat-history") stats.recvChat += 1;
      if (msg.type === "users") stats.recvUsers += 1;
    });

    ws.on("close", () => {
      stats.closed += 1;
      if (strokeTimer) clearInterval(strokeTimer);
    });

    ws.on("error", () => {
      stats.errors += 1;
    });

    sockets.push(ws);
    await sleep(18);
  }

  reportTimer = setInterval(() => {
    printStats("tick");
  }, REPORT_EVERY_S * 1000);

  const startedAt = Date.now();
  await sleep(DURATION_S * 1000);
  running = false;

  if (reportTimer) clearInterval(reportTimer);

  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(1000, "load-test-end");
      } catch {
        // ignore
      }
    }
  }

  await sleep(300);
  printStats("final");
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

main().catch((err) => {
  console.error("Load test failed:", err.message);
  process.exitCode = 1;
});
