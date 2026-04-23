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
const artistsPanel = document.getElementById("artistsPanel");
const artistsHandle = document.getElementById("artistsHandle");
const artistsFab = document.getElementById("artistsFab");

let ws;
let reconnectAttempts = 0;
let reconnectTimer = null;
let latestState = { gridWidth: 256, gridHeight: 192, pixels: [], users: [], chat: [] };
let isPainting = false;
let isErasing = false;
const ERASE_COLOR = "#0b1220";
const BASE_PIXEL_SIZE = 8;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.4;
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
let isArtistsMinimized = false;
let shouldAutoHideToolbox = true;
let activeDraggedPanel = null;
let panelDragOffsetX = 0;
let panelDragOffsetY = 0;
let panelDragMoved = false;
let dragStartedOnFab = false;
let dragLastX = 0;
let dragLastY = 0;
let activeDragGroup = [];
const panelLinks = new Map();
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

function getEffectiveMinZoom() {
  if (!(board instanceof HTMLElement) || !(boardViewport instanceof HTMLElement)) return MIN_ZOOM;
  const boardWidth = board.offsetWidth;
  const boardHeight = board.offsetHeight;
  if (boardWidth <= 0 || boardHeight <= 0) return MIN_ZOOM;

  const fitByWidth = boardViewport.clientWidth / boardWidth;
  const fitByHeight = boardViewport.clientHeight / boardHeight;
  const fitZoom = Math.max(fitByWidth, fitByHeight);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitZoom));
}

function setZoom(nextZoom, anchorClientX = null, anchorClientY = null) {
  const prevZoom = zoomLevel;
  const minZoom = getEffectiveMinZoom();
  zoomInput.min = String(minZoom);
  const clamped = Math.min(MAX_ZOOM, Math.max(minZoom, Number(nextZoom)));
  if (!Number.isFinite(clamped)) return;

  const viewportRect = boardViewport.getBoundingClientRect();
  const anchorX =
    typeof anchorClientX === "number" ? anchorClientX - viewportRect.left : boardViewport.clientWidth / 2;
  const anchorY =
    typeof anchorClientY === "number" ? anchorClientY - viewportRect.top : boardViewport.clientHeight / 2;
  const worldX = (boardViewport.scrollLeft + anchorX) / prevZoom;
  const worldY = (boardViewport.scrollTop + anchorY) / prevZoom;

  zoomLevel = clamped;
  zoomInput.value = String(clamped);
  zoomText.textContent = `Zoom: ${Math.round(clamped * 100)}%`;
  board.style.transform = `scale(${zoomLevel})`;

  const nextScrollLeft = worldX * zoomLevel - anchorX;
  const nextScrollTop = worldY * zoomLevel - anchorY;
  boardViewport.scrollLeft = Math.max(0, nextScrollLeft);
  boardViewport.scrollTop = Math.max(0, nextScrollTop);
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

function startPanelDrag(panel, event, startedOnFab = false) {
  if (!(panel instanceof HTMLElement)) return;
  activeDraggedPanel = panel;
  panelDragMoved = false;
  dragStartedOnFab = startedOnFab;
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  const rect = panel.getBoundingClientRect();
  panelDragOffsetX = event.clientX - rect.left;
  panelDragOffsetY = event.clientY - rect.top;
  activeDragGroup = getLinkedPanelGroup(panel);
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
  if (artistsFab instanceof HTMLElement) {
    artistsFab.setAttribute("aria-label", isArtistsMinimized ? "Open artists" : "Artists");
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

function setArtistsMinimized(nextState) {
  isArtistsMinimized = nextState;
  if (artistsPanel instanceof HTMLElement) {
    artistsPanel.classList.toggle("minimized", isArtistsMinimized);
  }
  syncToolboxButtons();
}

function dragActivePanel(event) {
  if (!(activeDraggedPanel instanceof HTMLElement)) return;
  panelDragMoved = true;
  const deltaX = event.clientX - dragLastX;
  const deltaY = event.clientY - dragLastY;
  dragLastX = event.clientX;
  dragLastY = event.clientY;

  const group = activeDragGroup.length > 0 ? activeDragGroup : [activeDraggedPanel];
  group.forEach((panel) => {
    movePanelBy(panel, deltaX, deltaY);
  });
}

function stopPanelDrag() {
  if (!(activeDraggedPanel instanceof HTMLElement)) return;
  activeDraggedPanel.classList.remove("is-dragging");
  attemptSnapConnections(activeDraggedPanel);
  activeDraggedPanel = null;
  activeDragGroup = [];
}

function fitPanelIntoViewport(panel) {
  if (!(panel instanceof HTMLElement)) return;
  const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
  const currentLeft = panel.offsetLeft;
  const currentTop = panel.offsetTop;
  panel.style.left = `${clamp(currentLeft, 0, maxLeft)}px`;
  panel.style.top = `${clamp(currentTop, 0, maxTop)}px`;
  panel.style.right = "auto";
}

function centerBoardViewport() {
  const maxLeft = Math.max(0, boardViewport.scrollWidth - boardViewport.clientWidth);
  const maxTop = Math.max(0, boardViewport.scrollHeight - boardViewport.clientHeight);
  boardViewport.scrollLeft = Math.round(maxLeft / 2);
  boardViewport.scrollTop = Math.round(maxTop / 2);
}

function panelArray() {
  return [toolbox, chatPanel, artistsPanel].filter((panel) => panel instanceof HTMLElement);
}

function movePanelBy(panel, deltaX, deltaY) {
  if (!(panel instanceof HTMLElement)) return;
  const maxLeft = window.innerWidth - panel.offsetWidth;
  const maxTop = window.innerHeight - panel.offsetHeight;
  const nextLeft = clamp(panel.offsetLeft + deltaX, 0, Math.max(0, maxLeft));
  const nextTop = clamp(panel.offsetTop + deltaY, 0, Math.max(0, maxTop));
  panel.style.left = `${nextLeft}px`;
  panel.style.top = `${nextTop}px`;
  panel.style.right = "auto";
}

function ensurePanelLinkEntry(panel) {
  if (!panelLinks.has(panel)) {
    panelLinks.set(panel, new Set());
  }
}

function linkPanels(a, b) {
  if (!(a instanceof HTMLElement) || !(b instanceof HTMLElement) || a === b) return;
  ensurePanelLinkEntry(a);
  ensurePanelLinkEntry(b);
  panelLinks.get(a).add(b);
  panelLinks.get(b).add(a);
}

function getLinkedPanelGroup(start) {
  if (!(start instanceof HTMLElement)) return [];
  const visited = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = panelLinks.get(current);
    if (!neighbors) continue;
    neighbors.forEach((next) => {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    });
  }
  return Array.from(visited);
}

function attemptSnapConnections(activePanel) {
  if (!(activePanel instanceof HTMLElement)) return;
  const SNAP_DISTANCE = 24;
  const activeRect = activePanel.getBoundingClientRect();

  panelArray().forEach((candidate) => {
    if (candidate === activePanel) return;
    const rect = candidate.getBoundingClientRect();

    const canSnapRight = Math.abs(activeRect.right - rect.left) <= SNAP_DISTANCE;
    const canSnapLeft = Math.abs(activeRect.left - rect.right) <= SNAP_DISTANCE;
    const canSnapBottom = Math.abs(activeRect.bottom - rect.top) <= SNAP_DISTANCE;
    const canSnapTop = Math.abs(activeRect.top - rect.bottom) <= SNAP_DISTANCE;

    if (canSnapRight) {
      const deltaX = rect.left - activeRect.right;
      movePanelBy(activePanel, deltaX, 0);
      linkPanels(activePanel, candidate);
      return;
    }
    if (canSnapLeft) {
      const deltaX = rect.right - activeRect.left;
      movePanelBy(activePanel, deltaX, 0);
      linkPanels(activePanel, candidate);
      return;
    }
    if (canSnapBottom) {
      const deltaY = rect.top - activeRect.bottom;
      movePanelBy(activePanel, 0, deltaY);
      linkPanels(activePanel, candidate);
      return;
    }
    if (canSnapTop) {
      const deltaY = rect.bottom - activeRect.top;
      movePanelBy(activePanel, 0, deltaY);
      linkPanels(activePanel, candidate);
    }
  });
}

function toggleToolboxMinimized() {
  setToolboxMinimized(!isToolboxMinimized);
}

function toggleChatMinimized() {
  setChatMinimized(!isChatMinimized);
}

function toggleArtistsMinimized() {
  setArtistsMinimized(!isArtistsMinimized);
}

function setupPanelInteractions(panel, handle, fab, toggleMinimized) {
  if (panel instanceof HTMLElement) {
    panel.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const isInteractive =
        Boolean(target.closest("button")) ||
        Boolean(target.closest("input")) ||
        Boolean(target.closest("textarea")) ||
        Boolean(target.closest("select")) ||
        target.isContentEditable;
      if (isInteractive) return;

      const isPanelMinimized = panel.classList.contains("minimized");
      if (isPanelMinimized) return;
      event.preventDefault();
      startPanelDrag(panel, event, false);
    });
  }

  if (panel instanceof HTMLElement) {
    panel.addEventListener("dblclick", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      toggleMinimized();
    });
  }

  if (handle instanceof HTMLElement) {
    handle.addEventListener("mousedown", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      if (event.button !== 0) return;
      event.preventDefault();
      startPanelDrag(panel, event, false);
    });
  }

  if (fab instanceof HTMLElement) {
    fab.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      startPanelDrag(panel, event, true);
    });
    fab.addEventListener("click", () => {
      if (dragStartedOnFab && panelDragMoved) {
        panelDragMoved = false;
        dragStartedOnFab = false;
        return;
      }
      dragStartedOnFab = false;
      toggleMinimized();
    });
  }
}

setupPanelInteractions(toolbox, toolboxHandle, toolboxFab, toggleToolboxMinimized);
setupPanelInteractions(chatPanel, chatHandle, chatFab, toggleChatMinimized);
setupPanelInteractions(artistsPanel, artistsHandle, artistsFab, toggleArtistsMinimized);

if (toolbox instanceof HTMLElement) {
  toolbox.style.left = "16px";
  toolbox.style.top = "16px";
  toolbox.style.right = "auto";
}

if (chatPanel instanceof HTMLElement) {
  chatPanel.style.left = `${Math.max(16, window.innerWidth - 68)}px`;
  chatPanel.style.top = "88px";
  chatPanel.style.right = "auto";
}

if (artistsPanel instanceof HTMLElement) {
  artistsPanel.style.left = `${Math.max(16, window.innerWidth - 84)}px`;
  artistsPanel.style.top = `${Math.max(16, window.innerHeight - 84)}px`;
  artistsPanel.style.right = "auto";
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
  const colorById = new Map(
    (latestState.users || []).map((user) => [String(user.id || ""), String(user.color || "#e2e8f0")])
  );
  const colorByName = new Map(
    (latestState.users || []).map((user) => [String(user.name || ""), String(user.color || "#e2e8f0")])
  );
  chat.forEach((entry) => {
    const line = document.createElement("div");
    line.className = "chat-line";

    const author = document.createElement("span");
    author.className = "chat-author";
    author.textContent = `${entry.author}:`;
    const authorColor =
      colorById.get(String(entry.authorId || "")) || colorByName.get(String(entry.author || ""));
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
  window.requestAnimationFrame(() => {
    centerBoardViewport();
  });
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
      renderChat(latestState.chat);
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

    if (msg.type === "pixels-updated" && Array.isArray(msg.pixels)) {
      msg.pixels.forEach((pixel) => {
        applyPixel(Number(pixel.x), Number(pixel.y), pixel.color);
      });
      return;
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
  send({ type: "clear-board" });
});

zoomInput.addEventListener("input", () => {
  setZoom(zoomInput.value);
});

zoomOutBtn.addEventListener("click", () => {
  setZoom(zoomLevel - 0.05);
});

zoomInBtn.addEventListener("click", () => {
  setZoom(zoomLevel + 0.05);
});

colorInput.addEventListener("change", () => {
  addColorToHistory(colorInput.value);
});

board.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const step = event.deltaY < 0 ? 0.05 : -0.05;
  setZoom(zoomLevel + step, event.clientX, event.clientY);
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
setArtistsMinimized(true);
syncToolboxButtons();
loadColorHistory();
addColorToHistory(colorInput.value);
connect();

window.addEventListener("resize", () => {
  setZoom(zoomLevel);
});
