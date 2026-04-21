const board = document.getElementById("board");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const colorInput = document.getElementById("colorInput");
const clearBtn = document.getElementById("clearBtn");
const statusText = document.getElementById("statusText");
const playersText = document.getElementById("playersText");
const userList = document.getElementById("userList");
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");

let ws;
let reconnectAttempts = 0;
let reconnectTimer = null;
let latestState = { gridWidth: 32, gridHeight: 24, pixels: [], users: [], chat: [] };
let isPainting = false;

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
  board.style.gridTemplateColumns = `repeat(${state.gridWidth}, 1fr)`;

  for (let y = 0; y < state.gridHeight; y += 1) {
    for (let x = 0; x < state.gridWidth; x += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.style.background = state.pixels?.[y]?.[x] || "#0b1220";
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

function renderUsers(users) {
  userList.innerHTML = "";
  users.forEach((player) => {
      const li = document.createElement("li");
      li.textContent = player.name;
      li.style.color = player.color;
      userList.appendChild(li);
    });
}

function renderState(state) {
  latestState = state;
  playersText.textContent = `Artists online: ${state.users.length}`;
  renderBoard(state);
  renderChat(state.chat);
  renderUsers(state.users);
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

function paintCellFromEvent(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains("cell")) return;
  const x = Number(target.dataset.x);
  const y = Number(target.dataset.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  send({ type: "paint", x, y, color: colorInput.value });
}

board.addEventListener("mousedown", (event) => {
  isPainting = true;
  paintCellFromEvent(event);
});

board.addEventListener("mouseover", (event) => {
  if (!isPainting) return;
  paintCellFromEvent(event);
});

window.addEventListener("mouseup", () => {
  isPainting = false;
});

setNameBtn.addEventListener("click", () => {
  send({ type: "set-name", name: nameInput.value.trim() || "Student" });
});

clearBtn.addEventListener("click", () => {
  send({ type: "clear-board" });
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
