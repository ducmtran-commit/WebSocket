const board = document.getElementById("board");
const boardViewport = document.getElementById("boardViewport");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const colorInput = document.getElementById("colorInput");
const eraserBtn = document.getElementById("eraserBtn");
const clearBtn = document.getElementById("clearBtn");
const zoomInput = document.getElementById("zoomInput");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomText = document.getElementById("zoomText");
const toolText = document.getElementById("toolText");
const statusText = document.getElementById("statusText");
const playersText = document.getElementById("playersText");
const userList = document.getElementById("userList");
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");
const colorHistory = document.getElementById("colorHistory");
const toolbox = document.getElementById("toolboxPanel");
const toolboxHandle = document.getElementById("toolboxHandle");
const toolboxFab = document.getElementById("toolboxFab");
const autoHideBtn = document.getElementById("autoHideBtn");
const chatPanel = document.getElementById("chatPanel");
const chatHandle = document.getElementById("chatHandle");
const chatFab = document.getElementById("chatFab");

let ws;
let reconnectAttempts = 0;
let reconnectTimer = null;
let latestState = { gridWidth: 256, gridHeight: 192, pixels: [], users: [], chat: [] };
let isPainting = false;
let isErasing = false;
const ERASE_COLOR = "#0b1220";
const BASE_PIXEL_SIZE = 10;
let zoomLevel = 1;
let cellEls = [];
const pendingPixels = new Map();
let flushTimer = null;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panScrollLeft = 0;
let panScrollTop = 0;
let isSpaceHeld = false;
let isToolboxMinimized = false;
let isChatMinimized = false;
let shouldAutoHideToolbox = true;
let activeDraggedPanel = null;
let panelDragOffsetX = 0;
let panelDragOffsetY = 0;
const COLOR_HISTORY_KEY = "pixel-board-color-history";
const MAX_COLOR_HISTORY = 10;
let recentColors = [];

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function normalizeHexColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : null;
}

function saveColorHistory() {
  try {
    window.localStorage.setItem(COLOR_HISTORY_KEY, JSON.stringify(recentColors));
  } catch {
    // Ignore localStorage failures in restricted environments.
  }
}

function renderColorHistory() {
  colorHistory.innerHTML = "";
  recentColors.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-swatch";
    button.style.background = color;
    button.title = color;
    if (color === colorInput.value.toLowerCase()) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      colorInput.value = color;
      if (isErasing) {
        isErasing = false;
        eraserBtn.textContent = "Eraser: Off";
        toolText.textContent = "Tool: Brush";
      }
      renderColorHistory();
    });
    colorHistory.appendChild(button);
  });
}

function addColorToHistory(colorValue) {
  const color = normalizeHexColor(colorValue);
  if (!color || color === ERASE_COLOR) return;
  recentColors = [color, ...recentColors.filter((item) => item !== color)].slice(0, MAX_COLOR_HISTORY);
  saveColorHistory();
  renderColorHistory();
}

function loadColorHistory() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLOR_HISTORY_KEY) || "[]");
    if (!Array.isArray(parsed)) return;
    recentColors = parsed
      .map((value) => normalizeHexColor(value))
      .filter((value) => Boolean(value))
      .slice(0, MAX_COLOR_HISTORY);
  } catch {
    recentColors = [];
  }
}

function shouldHandleCanvasShortcut(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  const tag = target.tagName;
  return tag !== "INPUT" && tag !== "TEXTAREA" && !target.isContentEditable;
}

function createBoard(state) {
  board.innerHTML = "";
  cellEls = Array.from({ length: state.gridHeight }, () => Array(state.gridWidth).fill(null));
  board.style.gridTemplateColumns = `repeat(${state.gridWidth}, ${BASE_PIXEL_SIZE}px)`;
  board.style.gridAutoRows = `${BASE_PIXEL_SIZE}px`;

  for (let y = 0; y < state.gridHeight; y += 1) {
    for (let x = 0; x < state.gridWidth; x += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.style.background = state.pixels?.[y]?.[x] || "#0b1220";
      cellEls[y][x] = cell;
      board.appendChild(cell);
    }
  }
}

function applyPixel(x, y, color) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  const row = latestState.pixels[y];
  const cell = cellEls[y]?.[x];
  if (!row || !cell) return;
  row[x] = color;
  cell.style.background = color;
}

function clearBoardLocal() {
  for (let y = 0; y < latestState.gridHeight; y += 1) {
    for (let x = 0; x < latestState.gridWidth; x += 1) {
      applyPixel(x, y, ERASE_COLOR);
    }
  }
}

function setZoom(nextZoom) {
  const clamped = Math.min(2, Math.max(0.5, Number(nextZoom)));
  zoomLevel = clamped;
  zoomInput.value = String(clamped);
  zoomText.textContent = `Zoom: ${Math.round(clamped * 100)}%`;
  board.style.transform = `scale(${zoomLevel})`;
}

function shouldStartPanning(event) {
  const isMiddleOrRight = event.button === 1 || event.button === 2;
  const isSpaceAndLeft = isSpaceHeld && event.button === 0;
  return isMiddleOrRight || isSpaceAndLeft;
}

function startPanning(event) {
  isPanning = true;
  isPainting = false;
  panStartX = event.clientX;
  panStartY = event.clientY;
  panScrollLeft = boardViewport.scrollLeft;
  panScrollTop = boardViewport.scrollTop;
  boardViewport.classList.add("is-panning");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function startPanelDrag(panel, event) {
  if (!(panel instanceof HTMLElement)) return;
  activeDraggedPanel = panel;
  const rect = panel.getBoundingClientRect();
  panelDragOffsetX = event.clientX - rect.left;
  panelDragOffsetY = event.clientY - rect.top;
  panel.classList.add("is-dragging");
}

function syncToolboxButtons() {
  if (autoHideBtn instanceof HTMLElement) {
    autoHideBtn.textContent = `Auto-hide: ${shouldAutoHideToolbox ? "On" : "Off"}`;
  }
  if (toolboxFab instanceof HTMLElement) {
    toolboxFab.setAttribute("aria-label", isToolboxMinimized ? "Open toolbox" : "Toolbox");
  }
  if (chatFab instanceof HTMLElement) {
    chatFab.setAttribute("aria-label", isChatMinimized ? "Open chat" : "Chat");
  }
}

function setToolboxMinimized(nextState) {
  isToolboxMinimized = nextState;
  if (toolbox instanceof HTMLElement) {
    toolbox.classList.toggle("minimized", isToolboxMinimized);
    if (isToolboxMinimized) {
      toolbox.classList.remove("auto-hidden");
    }
  }
  syncToolboxButtons();
}

function setChatMinimized(nextState) {
  isChatMinimized = nextState;
  if (chatPanel instanceof HTMLElement) {
    chatPanel.classList.toggle("minimized", isChatMinimized);
  }
  syncToolboxButtons();
}

function dragActivePanel(event) {
  if (!(activeDraggedPanel instanceof HTMLElement)) return;
  const maxLeft = window.innerWidth - activeDraggedPanel.offsetWidth;
  const maxTop = window.innerHeight - activeDraggedPanel.offsetHeight;
  const nextLeft = clamp(event.clientX - panelDragOffsetX, 0, Math.max(0, maxLeft));
  const nextTop = clamp(event.clientY - panelDragOffsetY, 0, Math.max(0, maxTop));
  activeDraggedPanel.style.left = `${nextLeft}px`;
  activeDraggedPanel.style.top = `${nextTop}px`;
  if (activeDraggedPanel === chatPanel) {
    activeDraggedPanel.style.right = "auto";
  }
}

function stopPanelDrag() {
  if (!(activeDraggedPanel instanceof HTMLElement)) return;
  activeDraggedPanel.classList.remove("is-dragging");
  activeDraggedPanel = null;
}

function toggleToolboxMinimized() {
  setToolboxMinimized(!isToolboxMinimized);
}

function toggleChatMinimized() {
  setChatMinimized(!isChatMinimized);
}

function setupPanelInteractions(panel, handle, fab, toggleMinimized) {
  if (handle instanceof HTMLElement) {
    handle.addEventListener("mousedown", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      if (event.button !== 0) return;
      event.preventDefault();
      startPanelDrag(panel, event);
    });
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      toggleMinimized();
    });
  }

  if (fab instanceof HTMLElement) {
    fab.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (fab === toolboxFab) {
        setToolboxMinimized(false);
      } else if (fab === chatFab) {
        setChatMinimized(false);
      }
      startPanelDrag(panel, event);
    });
    fab.addEventListener("dblclick", (event) => {
      event.preventDefault();
      toggleMinimized();
    });
  }
}

setupPanelInteractions(toolbox, toolboxHandle, toolboxFab, toggleToolboxMinimized);
setupPanelInteractions(chatPanel, chatHandle, chatFab, toggleChatMinimized);

if (chatPanel instanceof HTMLElement) {
  const right = window.innerWidth - chatPanel.getBoundingClientRect().right;
  const safeRight = clamp(right, 0, window.innerWidth - chatPanel.offsetWidth);
  chatPanel.style.left = `${window.innerWidth - chatPanel.offsetWidth - safeRight}px`;
  chatPanel.style.right = "auto";
  chatPanel.style.top = "16px";
}

if (toolbox instanceof HTMLElement) {
  toolbox.style.left = "16px";
  toolbox.style.top = "16px";
}

function setToolboxDrawingHidden(shouldHide) {
  if (!(toolbox instanceof HTMLElement)) return;
  if (!shouldAutoHideToolbox || isToolboxMinimized) {
    toolbox.classList.remove("auto-hidden");
    return;
  }
  toolbox.classList.toggle("auto-hidden", shouldHide);
}

function renderChat(chat) {
  chatBox.innerHTML = "";
  const colorByName = new Map(
    (latestState.users || []).map((user) => [String(user.name || ""), String(user.color || "#e2e8f0")])
  );
  chat.forEach((entry) => {
    const line = document.createElement("div");
    line.className = "chat-line";

    const author = document.createElement("span");
    author.className = "chat-author";
    author.textContent = `${entry.author}:`;
    const authorColor = colorByName.get(String(entry.author || ""));
    if (authorColor) {
      author.style.color = authorColor;
    }

    const message = document.createElement("span");
    message.className = "chat-message";
    message.textContent = ` ${entry.text}`;

    line.appendChild(author);
    line.appendChild(message);
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
  createBoard(state);
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
    if (msg.type === "init-state") {
      renderState(msg);
      return;
    }

    if (msg.type === "users") {
      latestState.users = msg.users || [];
      playersText.textContent = `Artists online: ${latestState.users.length}`;
      renderUsers(latestState.users);
      return;
    }

    if (msg.type === "chat-history") {
      latestState.chat = msg.chat || [];
      renderChat(latestState.chat);
      return;
    }

    if (msg.type === "pixel-update") {
      applyPixel(Number(msg.x), Number(msg.y), msg.color);
      return;
    }

    if (msg.type === "board-cleared") {
      clearBoardLocal();
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
  const color = isErasing ? ERASE_COLOR : colorInput.value;
  if (!isErasing) addColorToHistory(color);
  applyPixel(x, y, color);
  pendingPixels.set(`${x},${y}`, { x, y, color });
}

function flushPaintBatch() {
  flushTimer = null;
  if (pendingPixels.size === 0) return;
  const pixels = Array.from(pendingPixels.values());
  pendingPixels.clear();
  send({ type: "paint-batch", pixels });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = window.setTimeout(flushPaintBatch, 16);
}

board.addEventListener("mousedown", (event) => {
  if (shouldStartPanning(event)) return;
  if (event.button !== 0) return;
  isPainting = true;
  setToolboxDrawingHidden(true);
  paintCellFromEvent(event);
  scheduleFlush();
});

board.addEventListener("mouseover", (event) => {
  if (!isPainting) return;
  paintCellFromEvent(event);
  scheduleFlush();
});

window.addEventListener("mouseup", () => {
  stopPanelDrag();
  if (isPanning) {
    isPanning = false;
    boardViewport.classList.remove("is-panning");
  }
  isPainting = false;
  setToolboxDrawingHidden(false);
  flushPaintBatch();
});

boardViewport.addEventListener("mousedown", (event) => {
  if (!shouldStartPanning(event)) return;
  event.preventDefault();
  startPanning(event);
});

window.addEventListener("mousemove", (event) => {
  dragActivePanel(event);
  if (!isPanning) return;
  const deltaX = event.clientX - panStartX;
  const deltaY = event.clientY - panStartY;
  boardViewport.scrollLeft = panScrollLeft - deltaX;
  boardViewport.scrollTop = panScrollTop - deltaY;
});

if (autoHideBtn instanceof HTMLElement) {
  autoHideBtn.addEventListener("click", () => {
    shouldAutoHideToolbox = !shouldAutoHideToolbox;
    setToolboxDrawingHidden(false);
    syncToolboxButtons();
  });
}

boardViewport.addEventListener("contextmenu", (event) => {
  if (!isPanning) return;
  event.preventDefault();
});

setNameBtn.addEventListener("click", () => {
  send({ type: "set-name", name: nameInput.value.trim() || "Student" });
});

eraserBtn.addEventListener("click", () => {
  isErasing = !isErasing;
  eraserBtn.textContent = `Eraser: ${isErasing ? "On" : "Off"}`;
  toolText.textContent = `Tool: ${isErasing ? "Eraser" : "Brush"}`;
});

clearBtn.addEventListener("click", () => {
  clearBoardLocal();
  send({ type: "clear-board" });
});

zoomInput.addEventListener("input", () => {
  setZoom(zoomInput.value);
});

zoomOutBtn.addEventListener("click", () => {
  setZoom(zoomLevel - 0.1);
});

zoomInBtn.addEventListener("click", () => {
  setZoom(zoomLevel + 0.1);
});

colorInput.addEventListener("change", () => {
  addColorToHistory(colorInput.value);
});

board.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const step = event.deltaY < 0 ? 0.1 : -0.1;
  setZoom(zoomLevel + step);
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

window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && shouldHandleCanvasShortcut(event)) {
    isSpaceHeld = true;
    event.preventDefault();
  }
  if (!shouldHandleCanvasShortcut(event)) return;
  const isCmdOrCtrl = event.ctrlKey || event.metaKey;
  if (!isCmdOrCtrl) return;

  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    flushPaintBatch();
    send({ type: "undo" });
    return;
  }

  if (key === "y" || (key === "z" && event.shiftKey)) {
    event.preventDefault();
    flushPaintBatch();
    send({ type: "redo" });
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    isSpaceHeld = false;
  }
});

renderState(latestState);
setZoom(0.9);
setToolboxMinimized(true);
setChatMinimized(true);
syncToolboxButtons();
loadColorHistory();
addColorToHistory(colorInput.value);
connect();
