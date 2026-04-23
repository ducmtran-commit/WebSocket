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
const workspacePanel = document.getElementById("workspacePanel");
const workspaceHandle = document.getElementById("workspaceHandle");
const workspaceScroll = document.getElementById("workspaceScroll");
const workspaceSectionStack = document.getElementById("workspaceSectionStack");
const workspaceCollapseBtn = document.getElementById("workspaceCollapseBtn");
const navScrollUp = document.getElementById("navScrollUp");
const navScrollDown = document.getElementById("navScrollDown");
const autoHideBtn = document.getElementById("autoHideBtn");

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
let shouldAutoHideToolbox = true;
let workspaceDragging = false;
let workspaceDragLastX = 0;
let workspaceDragLastY = 0;
let sectionReorder = null;
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

function syncToolboxButtons() {
  if (autoHideBtn instanceof HTMLElement) {
    autoHideBtn.textContent = `Auto-hide: ${shouldAutoHideToolbox ? "On" : "Off"}`;
  }
}

function syncWorkspaceCollapseButton() {
  if (!(workspaceCollapseBtn instanceof HTMLElement) || !(workspacePanel instanceof HTMLElement)) return;
  const collapsed = workspacePanel.classList.contains("workspace-ui-collapsed");
  workspaceCollapseBtn.textContent = collapsed ? "Expand" : "Collapse";
  workspaceCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
  workspaceCollapseBtn.setAttribute("aria-label", collapsed ? "Expand workspace" : "Collapse workspace");
}

function startWorkspaceDrag(event) {
  if (!(workspacePanel instanceof HTMLElement)) return;
  workspaceDragging = true;
  workspaceDragLastX = event.clientX;
  workspaceDragLastY = event.clientY;
  workspacePanel.classList.add("is-dragging");
}

function dragWorkspace(event) {
  if (!workspaceDragging || !(workspacePanel instanceof HTMLElement)) return;
  const deltaX = event.clientX - workspaceDragLastX;
  const deltaY = event.clientY - workspaceDragLastY;
  workspaceDragLastX = event.clientX;
  workspaceDragLastY = event.clientY;
  movePanelBy(workspacePanel, deltaX, deltaY);
}

function stopWorkspaceDrag() {
  if (!(workspacePanel instanceof HTMLElement)) return;
  workspaceDragging = false;
  workspacePanel.classList.remove("is-dragging");
}

function centerBoardViewport() {
  const maxLeft = Math.max(0, boardViewport.scrollWidth - boardViewport.clientWidth);
  const maxTop = Math.max(0, boardViewport.scrollHeight - boardViewport.clientHeight);
  boardViewport.scrollLeft = Math.round(maxLeft / 2);
  boardViewport.scrollTop = Math.round(maxTop / 2);
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

function scrollWorkspaceBy(deltaY) {
  if (!(workspaceScroll instanceof HTMLElement)) return;
  workspaceScroll.scrollTop = clamp(
    workspaceScroll.scrollTop + deltaY,
    0,
    Math.max(0, workspaceScroll.scrollHeight - workspaceScroll.clientHeight)
  );
}

function jumpToSection(sectionId) {
  const el = document.getElementById(sectionId);
  if (!(el instanceof HTMLElement)) return;
  const row = el.closest(".workspace-section-row");
  const target = row instanceof HTMLElement ? row : el;
  target.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function startSectionReorder(section, clientY) {
  const row = section.closest(".workspace-section-row");
  const stack = workspaceSectionStack;
  if (!(row instanceof HTMLElement) || !(stack instanceof HTMLElement)) return;
  const rect = row.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "workspace-align-row workspace-section-placeholder";
  placeholder.innerHTML =
    '<div class="workspace-nav-cell" aria-hidden="true"></div><div class="workspace-content-cell"><div class="workspace-section-placeholder-dash" aria-hidden="true"></div></div>';
  placeholder.style.minHeight = `${rect.height}px`;
  stack.insertBefore(placeholder, row);
  row.classList.add("is-section-dragging");
  row.style.position = "fixed";
  row.style.left = `${rect.left}px`;
  row.style.top = `${rect.top}px`;
  row.style.width = `${rect.width}px`;
  row.style.zIndex = "60";
  row.style.marginBottom = "0";
  sectionReorder = {
    row,
    placeholder,
    width: rect.width,
    lockLeft: rect.left,
    offsetY: clientY - rect.top,
  };
}

function moveSectionReorder(clientY) {
  if (!sectionReorder || !(workspaceSectionStack instanceof HTMLElement)) return;
  const { row, placeholder, width, lockLeft, offsetY } = sectionReorder;
  const stack = workspaceSectionStack;
  row.style.left = `${lockLeft}px`;
  row.style.top = `${clientY - offsetY}px`;
  row.style.width = `${width}px`;

  const others = [...stack.querySelectorAll(".workspace-section-row")].filter((el) => el !== row);
  let insertBefore = null;
  for (const other of others) {
    const r = other.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) {
      insertBefore = other;
      break;
    }
  }
  if (insertBefore) {
    stack.insertBefore(placeholder, insertBefore);
  } else {
    stack.appendChild(placeholder);
  }
}

function stopSectionReorder() {
  if (!sectionReorder || !(workspaceSectionStack instanceof HTMLElement)) return;
  const { row, placeholder } = sectionReorder;
  const stack = workspaceSectionStack;
  stack.insertBefore(row, placeholder);
  placeholder.remove();
  row.classList.remove("is-section-dragging");
  row.style.position = "";
  row.style.left = "";
  row.style.top = "";
  row.style.width = "";
  row.style.zIndex = "";
  row.style.marginBottom = "";
  sectionReorder = null;
}

if (workspaceHandle instanceof HTMLElement) {
  workspaceHandle.addEventListener("mousedown", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) return;
    if (event.button !== 0) return;
    event.preventDefault();
    startWorkspaceDrag(event);
  });
}

if (navScrollUp instanceof HTMLElement) {
  navScrollUp.addEventListener("click", () => scrollWorkspaceBy(-160));
}

if (navScrollDown instanceof HTMLElement) {
  navScrollDown.addEventListener("click", () => scrollWorkspaceBy(160));
}

document.querySelectorAll(".nav-jump").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-target");
    if (id) jumpToSection(id);
  });
});

if (workspaceScroll instanceof HTMLElement) {
  workspaceScroll.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const handle = target.closest(".section-drag-handle");
    if (!handle) return;
    if (event.button !== 0) return;
    const section = handle.closest(".workspace-section");
    if (!(section instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    startSectionReorder(section, event.clientY);
  });

  workspaceScroll.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest(".section-collapse-btn");
    if (!btn) return;
    const section = btn.closest(".workspace-section");
    if (!(section instanceof HTMLElement)) return;
    const collapsed = section.classList.toggle("section-collapsed");
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Expand section" : "Collapse section");
    btn.textContent = collapsed ? "▸" : "▾";
  });
}

if (workspaceCollapseBtn instanceof HTMLElement) {
  workspaceCollapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!(workspacePanel instanceof HTMLElement)) return;
    stopSectionReorder();
    workspacePanel.classList.toggle("workspace-ui-collapsed");
    syncWorkspaceCollapseButton();
  });
}

if (workspacePanel instanceof HTMLElement) {
  workspacePanel.style.left = "16px";
  workspacePanel.style.top = "16px";
  workspacePanel.style.right = "auto";
}

function setToolboxDrawingHidden(shouldHide) {
  if (!(workspacePanel instanceof HTMLElement)) return;
  if (!shouldAutoHideToolbox) {
    workspacePanel.classList.remove("auto-hidden");
    return;
  }
  workspacePanel.classList.toggle("auto-hidden", shouldHide);
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
  flushTimer = window.setTimeout(flushPaintBatch, 8);
}

function stopPainting() {
  if (!isPainting) return;
  isPainting = false;
  setToolboxDrawingHidden(false);
  flushPaintBatch();
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
  if ((event.buttons & 1) !== 1) {
    stopPainting();
    return;
  }
  paintCellFromEvent(event);
  scheduleFlush();
});

window.addEventListener("mouseup", () => {
  stopSectionReorder();
  stopWorkspaceDrag();
  if (isPanning) {
    isPanning = false;
    boardViewport.classList.remove("is-panning");
  }
  stopPainting();
});

boardViewport.addEventListener("mousedown", (event) => {
  if (!shouldStartPanning(event)) return;
  event.preventDefault();
  startPanning(event);
});

window.addEventListener("mousemove", (event) => {
  if (sectionReorder) {
    moveSectionReorder(event.clientY);
  } else {
    dragWorkspace(event);
  }
  if (isPainting && (event.buttons & 1) !== 1) {
    stopPainting();
  }
  if (!isPanning) return;
  const deltaX = event.clientX - panStartX;
  const deltaY = event.clientY - panStartY;
  boardViewport.scrollLeft = panScrollLeft - deltaX;
  boardViewport.scrollTop = panScrollTop - deltaY;
});

window.addEventListener("blur", () => {
  stopPainting();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    stopPainting();
  }
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
syncToolboxButtons();
syncWorkspaceCollapseButton();
loadColorHistory();
addColorToHistory(colorInput.value);
connect();

window.addEventListener("resize", () => {
  setZoom(zoomLevel);
});
