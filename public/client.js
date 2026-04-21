const board = document.getElementById("board");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const statusText = document.getElementById("statusText");
const playersText = document.getElementById("playersText");
const scoreList = document.getElementById("scoreList");
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");

let ws;
let reconnectAttempts = 0;
let reconnectTimer = null;
let latestState = { gridSize: 14, players: [], chat: [] };

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function renderBoard(state) {
  board.innerHTML = "";
  board.style.gridTemplateColumns = `repeat(${state.gridSize}, 1fr)`;

  const playerByCell = new Map();
  for (const player of state.players) {
    playerByCell.set(`${player.x},${player.y}`, player);
  }

  for (let y = 0; y < state.gridSize; y += 1) {
    for (let x = 0; x < state.gridSize; x += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const occupant = playerByCell.get(`${x},${y}`);
      if (occupant) {
        cell.classList.add("player");
        cell.style.background = occupant.color;
        cell.title = `${occupant.name} (${occupant.score})`;
      }
      board.appendChild(cell);
    }
  }
}

function renderChat(chat) {
  chatBox.innerHTML = "";
  chat.forEach((entry) => {
    const line = document.createElement("div");
    line.textContent = `${entry.author}: ${entry.text}`;
    chatBox.appendChild(line);
  });
  chatBox.scrollTop = chatBox.scrollHeight;
}

function renderScores(players) {
  scoreList.innerHTML = "";
  players
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((player) => {
      const li = document.createElement("li");
      li.textContent = `${player.name}: ${player.score}`;
      li.style.color = player.color;
      scoreList.appendChild(li);
    });
}

function renderState(state) {
  latestState = state;
  playersText.textContent = `Players: ${state.players.length}`;
  renderBoard(state);
  renderChat(state.chat);
  renderScores(state.players);
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  statusText.textContent = "Status: connecting...";
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    statusText.textContent = "Status: connected";
    send({ type: "set-name", name: nameInput.value.trim() || "Student" });
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "state") {
      renderState(msg);
    }
  });

  ws.addEventListener("close", () => {
    statusText.textContent = "Status: disconnected, reconnecting...";
    const wait = Math.min(10000, 500 * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(connect, wait);
  });
}

window.addEventListener("keydown", (event) => {
  const moveMap = {
    ArrowUp: { dx: 0, dy: -1 },
    ArrowDown: { dx: 0, dy: 1 },
    ArrowLeft: { dx: -1, dy: 0 },
    ArrowRight: { dx: 1, dy: 0 },
  };
  const move = moveMap[event.key];
  if (!move) return;
  event.preventDefault();
  send({ type: "move", ...move });
});

setNameBtn.addEventListener("click", () => {
  send({ type: "set-name", name: nameInput.value.trim() || "Student" });
});

sendChatBtn.addEventListener("click", () => {
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  chatInput.value = "";
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  sendChatBtn.click();
});

renderState(latestState);
connect();
