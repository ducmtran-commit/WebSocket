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
const autoHideBtn = document.getElementById("autoHideBtn");
const launchGate = document.getElementById("launchGate");
const launchLoadingBar = document.getElementById("launchLoadingBar");
const launchStartBtn = document.getElementById("launchStartBtn");
const launchJoinBtn = document.getElementById("launchJoinBtn");

let ws;
let reconnectAttempts = 0;
let reconnectTimer = null;
let latestState = { gridWidth: 256, gridHeight: 192, pixels: [], users: [], chat: [] };
let isPainting = false;
let isErasing = false;
/** Last grid cell painted while dragging (for line interpolation). */
let lastPaintGrid = null;
/** Pointer capture id while painting (keeps events if cursor leaves board briefly). */
let paintCapturePointerId = null;
/** Coalesce remote pixel updates to one apply pass per animation frame. */
const pendingRemotePixels = new Map();
let remotePixelFlushRaf = null;
const ERASE_COLOR = "#0b1220";
const BASE_PIXEL_SIZE = 8;
/** Must match `.board` border + padding in `style.css` (layout space, pre-transform). */
const BOARD_BORDER_PX = 1;
const BOARD_PADDING_PX = 8;
/** Grid `gap` between tracks (px). */
const BOARD_GRID_GAP_PX = 1;
const CELL_STRIDE_PX = BASE_PIXEL_SIZE + BOARD_GRID_GAP_PX;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.4;
let zoomLevel = 1;
/** Last pointer position over the board viewport (for zoom +/- / slider to zoom toward cursor). */
let boardZoomAnchorClient = null;
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
let workspaceHidden = false;
let workspaceHideTimer = null;
let hasEnteredBoard = false;
const LAUNCH_LOADING_PIXEL_MIN = 7;
const LAUNCH_LOADING_PIXEL_MAX = 14;
const LAUNCH_ENTER_ANIM_MS = 760;
let launchLoadingPixelCount = LAUNCH_LOADING_PIXEL_MAX;
let launchFilledPixels = 0;
let sectionReorder = null;
const SECTION_REORDER_SLOT_UNSET = Symbol("sectionReorderSlot");
/** Last drop target for placeholder; avoids repeat `insertBefore` / `appendChild` every mousemove. */
let sectionReorderInsertBefore = SECTION_REORDER_SLOT_UNSET;
const COLOR_HISTORY_KEY = "pixel-board-color-history";
const CLIENT_KEY_STORAGE = "pixel-board-client-key";
const MAX_COLOR_HISTORY = 10;
let recentColors = [];

/** Stable id for paint ownership across page refresh (server `ownerKey`). */
function getOrCreateClientKey() {
  try {
    let key = window.localStorage.getItem(CLIENT_KEY_STORAGE);
    if (typeof key === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(key)) return key;
    key =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(CLIENT_KEY_STORAGE, key);
    return key;
  } catch {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

let launchSfxCtx = null;

function playLaunchPixelSound(progress = 0) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!launchSfxCtx) launchSfxCtx = new Ctx();
  const ctx = launchSfxCtx;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime + 0.005;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.11, now + 0.015);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
  master.connect(ctx.destination);

  const voice = (freq, start, duration) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, now + start);
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.25, now + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.01);
  };
  const base = 300 + Math.floor(clamp(progress, 0, 1) * 260);
  voice(base, 0, 0.05);
  voice(base * 1.33, 0.045, 0.08);
}

function buildLaunchLoadingBar() {
  if (!(launchLoadingBar instanceof HTMLElement)) return;
  launchLoadingBar.innerHTML = "";
  launchLoadingPixelCount =
    Math.floor(Math.random() * (LAUNCH_LOADING_PIXEL_MAX - LAUNCH_LOADING_PIXEL_MIN + 1)) +
    LAUNCH_LOADING_PIXEL_MIN;
  launchFilledPixels = 0;
  const initialFilled = Math.floor(Math.random() * launchLoadingPixelCount);
  for (let i = 0; i < launchLoadingPixelCount; i += 1) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "loading-pixel";
    cell.setAttribute("aria-label", `Fill loading pixel ${i + 1}`);
    const shouldStartFilled = i < initialFilled;
    cell.dataset.filled = shouldStartFilled ? "1" : "0";
    if (shouldStartFilled) {
      cell.classList.add("filled");
      launchFilledPixels += 1;
    }
    launchLoadingBar.appendChild(cell);
  }
  const firstCell = launchLoadingBar.querySelector(".loading-pixel");
  if (firstCell instanceof HTMLElement) {
    firstCell.focus({ preventScroll: true });
  }
}

function fillNextLaunchPixel(sourceEvent = null) {
  if (hasEnteredBoard || !(launchLoadingBar instanceof HTMLElement)) return;
  const nextUnfilled = launchLoadingBar.querySelector('.loading-pixel[data-filled="0"]');
  if (!(nextUnfilled instanceof HTMLElement)) return;
  nextUnfilled.dataset.filled = "1";
  nextUnfilled.classList.add("filled");
  launchFilledPixels += 1;
  playLaunchPixelSound(launchFilledPixels / Math.max(1, launchLoadingPixelCount));
  if (launchFilledPixels >= launchLoadingPixelCount) {
    window.setTimeout(() => {
      enterBoardExperience(sourceEvent);
    }, 90);
  }
}

function fillAllLaunchPixels(sourceEvent = null) {
  if (hasEnteredBoard || !(launchLoadingBar instanceof HTMLElement)) return;
  while (launchFilledPixels < launchLoadingPixelCount) {
    fillNextLaunchPixel(sourceEvent);
  }
}

function setEnterOriginFromClick(sourceEvent) {
  if (!(document.body instanceof HTMLElement)) return;
  document.body.style.setProperty("--enter-origin-x", "50vw");
  document.body.style.setProperty("--enter-origin-y", "50vh");
}

function enterBoardExperience(sourceEvent = null) {
  if (hasEnteredBoard) return;
  hasEnteredBoard = true;
  setEnterOriginFromClick(sourceEvent);
  playLaunchPixelSound();
  if (document.body instanceof HTMLElement) {
    document.body.classList.remove("app-gated");
    document.body.classList.add("entering-canvas");
  }
  if (launchGate instanceof HTMLElement) {
    launchGate.classList.add("is-entering");
    window.setTimeout(() => {
      launchGate.classList.add("hidden");
    }, LAUNCH_ENTER_ANIM_MS);
  }
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  window.setTimeout(() => {
    if (document.body instanceof HTMLElement) {
      document.body.classList.remove("entering-canvas");
    }
  }, LAUNCH_ENTER_ANIM_MS);
  if (statusText instanceof HTMLElement) {
    statusText.textContent = "Status: connecting...";
  }
  connect();
}

function send(payload) {
  if (!(ws && ws.readyState === WebSocket.OPEN)) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
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

function addColorToHistory(colorValue, options = {}) {
  const color = normalizeHexColor(colorValue);
  if (!color || color === ERASE_COLOR) return;
  recentColors = [color, ...recentColors.filter((item) => item !== color)].slice(0, MAX_COLOR_HISTORY);
  saveColorHistory();
  if (!options.skipRender) {
    renderColorHistory();
  }
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

function isValidPixelGrid(pixels, height, width) {
  if (!Array.isArray(pixels) || pixels.length !== height) return false;
  for (let y = 0; y < height; y++) {
    if (!Array.isArray(pixels[y]) || pixels[y].length !== width) return false;
  }
  return true;
}

function clonePixelGridFrom(pixels, height, width) {
  const out = [];
  for (let y = 0; y < height; y++) {
    out[y] = [];
    const row = Array.isArray(pixels?.[y]) ? pixels[y] : null;
    for (let x = 0; x < width; x++) {
      const c = row?.[x];
      out[y][x] = typeof c === "string" && /^#[0-9a-fA-F]{6}$/i.test(c) ? c : ERASE_COLOR;
    }
  }
  return out;
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

function clientIsOverBoardViewport(clientX, clientY) {
  if (!(boardViewport instanceof HTMLElement)) return false;
  const r = boardViewport.getBoundingClientRect();
  return clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom;
}

function pickCellFromPoint(clientX, clientY) {
  if (!(board instanceof HTMLElement)) return null;
  const gw = latestState.gridWidth;
  const gh = latestState.gridHeight;
  if (!Number.isFinite(gw) || !Number.isFinite(gh) || gw <= 0 || gh <= 0) return null;

  const rect = board.getBoundingClientRect();
  const z = zoomLevel;
  if (!(z > 0)) return null;

  const localX = (clientX - rect.left) / z;
  const localY = (clientY - rect.top) / z;
  const innerX = localX - BOARD_BORDER_PX - BOARD_PADDING_PX;
  const innerY = localY - BOARD_BORDER_PX - BOARD_PADDING_PX;
  if (innerX < 0 || innerY < 0) return null;

  const xi = Math.floor(innerX / CELL_STRIDE_PX);
  const yi = Math.floor(innerY / CELL_STRIDE_PX);
  if (xi < 0 || yi < 0 || xi >= gw || yi >= gh) return null;

  const rx = innerX - xi * CELL_STRIDE_PX;
  const ry = innerY - yi * CELL_STRIDE_PX;
  if (rx >= BASE_PIXEL_SIZE || ry >= BASE_PIXEL_SIZE) return null;

  return cellEls[yi]?.[xi] ?? null;
}

function eachGridOnLine(x0, y0, x1, y1, visit) {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    visit(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function paintAtClient(clientX, clientY) {
  const cell = pickCellFromPoint(clientX, clientY);
  if (!cell) {
    lastPaintGrid = null;
    return;
  }
  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  const color = isErasing ? ERASE_COLOR : colorInput.value;

  const paintOne = (px, py) => {
    applyPixel(px, py, color);
    pendingPixels.set(`${px},${py}`, { x: px, y: py, color });
  };

  if (!lastPaintGrid) {
    paintOne(x, y);
    if (!isErasing) addColorToHistory(color, { skipRender: true });
    lastPaintGrid = { x, y };
    return;
  }

  eachGridOnLine(lastPaintGrid.x, lastPaintGrid.y, x, y, (px, py) => {
    paintOne(px, py);
  });
  lastPaintGrid = { x, y };
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
  const viewW = boardViewport.clientWidth;
  const viewH = boardViewport.clientHeight;
  const innerLeft = viewportRect.left + boardViewport.clientLeft;
  const innerTop = viewportRect.top + boardViewport.clientTop;
  const innerRight = innerLeft + viewW;
  const innerBottom = innerTop + viewH;

  const hasAnchor =
    typeof anchorClientX === "number" &&
    Number.isFinite(anchorClientX) &&
    typeof anchorClientY === "number" &&
    Number.isFinite(anchorClientY);

  const pivotX = hasAnchor
    ? clamp(anchorClientX, innerLeft, Math.max(innerLeft, innerRight - 1e-6))
    : innerLeft + viewW / 2;
  const pivotY = hasAnchor
    ? clamp(anchorClientY, innerTop, Math.max(innerTop, innerBottom - 1e-6))
    : innerTop + viewH / 2;

  const pivotRelX = pivotX - innerLeft;
  const pivotRelY = pivotY - innerTop;
  // Board-local coords from scroll-space (stable; avoids getBoundingClientRect vs scroll mismatch).
  const lx = (boardViewport.scrollLeft + pivotRelX) / prevZoom;
  const ly = (boardViewport.scrollTop + pivotRelY) / prevZoom;
  const ratio = clamped / prevZoom;

  zoomLevel = clamped;
  zoomInput.value = String(clamped);
  zoomText.textContent = `Zoom: ${Math.round(clamped * 100)}%`;
  board.style.transform = `scale(${zoomLevel})`;

  void board.offsetWidth;

  const nextScrollLeft = lx * clamped - pivotRelX;
  const nextScrollTop = ly * clamped - pivotRelY;

  const maxLeft = Math.max(0, boardViewport.scrollWidth - boardViewport.clientWidth);
  const maxTop = Math.max(0, boardViewport.scrollHeight - boardViewport.clientHeight);
  boardViewport.scrollLeft = clamp(nextScrollLeft, 0, maxLeft);
  boardViewport.scrollTop = clamp(nextScrollTop, 0, maxTop);

  if (ratio !== 1 && hasAnchor) {
    void board.offsetWidth;
    const br = board.getBoundingClientRect();
    const slipX = pivotX - (br.left + lx * clamped);
    const slipY = pivotY - (br.top + ly * clamped);
    if (Math.abs(slipX) > 0.5 || Math.abs(slipY) > 0.5) {
      const maxL2 = Math.max(0, boardViewport.scrollWidth - boardViewport.clientWidth);
      const maxT2 = Math.max(0, boardViewport.scrollHeight - boardViewport.clientHeight);
      boardViewport.scrollLeft = clamp(boardViewport.scrollLeft - slipX, 0, maxL2);
      boardViewport.scrollTop = clamp(boardViewport.scrollTop - slipY, 0, maxT2);
    }
  }
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

const WORKSPACE_FLICKER_MS = 190;
const WORKSPACE_TOGGLE_COOLDOWN_MS = 220;
let workspaceLastToggleAt = 0;

function clearWorkspaceHideTimer() {
  if (workspaceHideTimer != null) {
    window.clearTimeout(workspaceHideTimer);
    workspaceHideTimer = null;
  }
}

function setWorkspaceHidden(shouldHide) {
  if (!(workspacePanel instanceof HTMLElement)) return;
  const hide = Boolean(shouldHide);
  workspaceHidden = hide;
  clearWorkspaceHideTimer();
  workspacePanel.classList.remove("workspace-flicker-show", "workspace-flicker-hide");
  if (isPainting) {
    // Avoid extra animation/reflow cost while actively painting.
    workspacePanel.classList.toggle("workspace-hidden", hide);
    workspacePanel.setAttribute("aria-hidden", String(hide));
    return;
  }
  if (hide) {
    stopSectionReorder();
    if (workspaceDragging) {
      stopWorkspaceDrag();
    }
    workspacePanel.classList.remove("workspace-hidden");
    workspacePanel.setAttribute("aria-hidden", "false");
    void workspacePanel.offsetWidth;
    workspacePanel.classList.add("workspace-flicker-hide");
    workspaceHideTimer = window.setTimeout(() => {
      workspacePanel.classList.remove("workspace-flicker-hide");
      workspacePanel.classList.add("workspace-hidden");
      workspacePanel.setAttribute("aria-hidden", "true");
      workspaceHideTimer = null;
    }, WORKSPACE_FLICKER_MS);
    return;
  }
  workspacePanel.classList.remove("workspace-hidden");
  workspacePanel.setAttribute("aria-hidden", "false");
  void workspacePanel.offsetWidth;
  workspacePanel.classList.add("workspace-flicker-show");
  workspaceHideTimer = window.setTimeout(() => {
    workspacePanel.classList.remove("workspace-flicker-show");
    workspaceHideTimer = null;
  }, WORKSPACE_FLICKER_MS);
}

function toggleWorkspaceHidden() {
  const now = performance.now();
  if (now - workspaceLastToggleAt < WORKSPACE_TOGGLE_COOLDOWN_MS) return;
  workspaceLastToggleAt = now;
  setWorkspaceHidden(!workspaceHidden);
}

function toggleWorkspaceUiCollapsed() {
  if (!(workspacePanel instanceof HTMLElement)) return;
  stopSectionReorder();
  workspacePanel.classList.toggle("workspace-ui-collapsed");
  syncWorkspaceCollapseButton();
}

function isWorkspaceDblclickToggleTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("#workspaceHandle")) return false;
  if (target.closest("button")) return false;
  if (target.closest("input")) return false;
  if (target.closest("textarea")) return false;
  if (target.closest("select")) return false;
  if (target.closest("a")) return false;
  if (target.closest("label")) return false;
  if (target.closest(".chat-box")) return false;
  if (target.closest(".section-drag-handle")) return false;
  return true;
}

/** Fast double-tap / second-press window (ms). */
const WORKSPACE_DBL_TAP_MS = 180;
const WORKSPACE_DBL_TAP_PX = 34;
let workspaceFastTap = { t: 0, x: 0, y: 0 };
/** After a pointer double-tap toggle, ignore native `dblclick` briefly (same gesture). */
let workspaceSuppressNativeDblUntil = 0;

function tryWorkspaceFastDoubleTap(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return false;
  if (!(workspacePanel instanceof HTMLElement)) return false;
  if (!(event.target instanceof Node) || !workspacePanel.contains(event.target)) return false;
  if (!isWorkspaceDblclickToggleTarget(event.target)) {
    workspaceFastTap = { t: 0, x: 0, y: 0 };
    return false;
  }
  const now = performance.now();
  const dt = now - workspaceFastTap.t;
  const dx = event.clientX - workspaceFastTap.x;
  const dy = event.clientY - workspaceFastTap.y;
  const r = WORKSPACE_DBL_TAP_PX;
  if (workspaceFastTap.t > 0 && dt < WORKSPACE_DBL_TAP_MS && dx * dx + dy * dy < r * r) {
    if (workspaceDragging) {
      stopWorkspaceDrag();
    }
    workspaceFastTap = { t: 0, x: 0, y: 0 };
    workspaceSuppressNativeDblUntil = now + 450;
    toggleWorkspaceUiCollapsed();
    return true;
  }
  workspaceFastTap = { t: now, x: event.clientX, y: event.clientY };
  return false;
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

function startSectionReorder(section, clientY) {
  const row = section.closest(".workspace-section-row");
  const stack = workspaceSectionStack;
  if (!(row instanceof HTMLElement) || !(stack instanceof HTMLElement)) return;
  const rect = row.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "workspace-section-row workspace-section-placeholder";
  placeholder.innerHTML =
    '<div class="workspace-section-placeholder-dash" aria-hidden="true"></div>';
  placeholder.style.minHeight = `${rect.height}px`;
  stack.insertBefore(placeholder, row);
  row.classList.add("is-section-dragging");
  row.style.position = "fixed";
  row.style.left = `${rect.left}px`;
  row.style.top = `${rect.top}px`;
  row.style.width = `${rect.width}px`;
  row.style.zIndex = "60";
  row.style.marginBottom = "0";
  sectionReorderInsertBefore = SECTION_REORDER_SLOT_UNSET;
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

  const others = [...stack.querySelectorAll(".workspace-section-row")].filter(
    (el) => el !== row && !el.classList.contains("workspace-section-placeholder")
  );
  let insertBefore = null;
  for (const other of others) {
    const r = other.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) {
      insertBefore = other;
      break;
    }
  }
  if (insertBefore === sectionReorderInsertBefore) {
    return;
  }
  sectionReorderInsertBefore = insertBefore;
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
  sectionReorderInsertBefore = SECTION_REORDER_SLOT_UNSET;
  sectionReorder = null;
}

if (workspaceHandle instanceof HTMLElement) {
  workspaceHandle.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!(event.target instanceof HTMLElement) || event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    if (workspaceDragging) {
      stopWorkspaceDrag();
      return;
    }
    startWorkspaceDrag(event);
  });
}

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
    toggleWorkspaceUiCollapsed();
  });
}

if (workspacePanel instanceof HTMLElement) {
  workspacePanel.setAttribute("aria-keyshortcuts", "Tab");
  workspacePanel.addEventListener(
    "pointerdown",
    (event) => {
      if (tryWorkspaceFastDoubleTap(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
  workspacePanel.addEventListener("dblclick", (event) => {
    if (performance.now() < workspaceSuppressNativeDblUntil) {
      event.preventDefault();
      return;
    }
    if (!isWorkspaceDblclickToggleTarget(event.target)) return;
    event.preventDefault();
    if (workspaceDragging) {
      stopWorkspaceDrag();
    }
    toggleWorkspaceUiCollapsed();
  });
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
  const gw = Number(state.gridWidth) || latestState.gridWidth || 256;
  const gh = Number(state.gridHeight) || latestState.gridHeight || 192;
  let sourcePixels = state.pixels;
  if (!isValidPixelGrid(sourcePixels, gh, gw)) {
    sourcePixels = isValidPixelGrid(latestState.pixels, gh, gw) ? latestState.pixels : null;
  }
  const pixels =
    sourcePixels == null ? clonePixelGridFrom(null, gh, gw) : clonePixelGridFrom(sourcePixels, gh, gw);

  latestState = {
    ...state,
    gridWidth: gw,
    gridHeight: gh,
    pixels,
    users: Array.isArray(state.users) ? state.users : latestState.users || [],
    chat: Array.isArray(state.chat) ? state.chat : latestState.chat || [],
  };

  playersText.textContent = `Artists online: ${latestState.users.length}`;
  createBoard(latestState);
  window.requestAnimationFrame(() => {
    centerBoardViewport();
  });
  renderChat(latestState.chat);
  renderUsers(latestState.users);
}

function connect() {
  if (!hasEnteredBoard) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (remotePixelFlushRaf != null) {
    cancelAnimationFrame(remotePixelFlushRaf);
    remotePixelFlushRaf = null;
  }
  if (wheelZoomRaf != null) {
    cancelAnimationFrame(wheelZoomRaf);
    wheelZoomRaf = null;
  }
  wheelZoomAccum = 0;
  pendingRemotePixels.clear();
  releasePaintCapture();

  statusText.textContent = "Status: connecting...";
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    statusText.textContent = "Status: connected";
    send({
      type: "set-name",
      name: nameInput.value.trim() || "Student",
      clientKey: getOrCreateClientKey(),
    });
    if (pendingPixels.size > 0) {
      scheduleFlush();
    }
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
      if (pendingPixels.size > 0) {
        for (const pixel of pendingPixels.values()) {
          applyPixel(Number(pixel.x), Number(pixel.y), pixel.color);
        }
        scheduleFlush();
      }
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
      queueRemotePixels(msg.pixels);
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
  paintAtClient(event.clientX, event.clientY);
}

/** Max DOM updates per frame for merged `pixels-updated` batches (keeps UI responsive). */
const REMOTE_PIXEL_APPLY_CHUNK = 450;

function flushRemotePixelBatch() {
  remotePixelFlushRaf = null;
  if (pendingRemotePixels.size === 0) return;
  let n = 0;
  for (const key of pendingRemotePixels.keys()) {
    if (n >= REMOTE_PIXEL_APPLY_CHUNK) break;
    const pixel = pendingRemotePixels.get(key);
    pendingRemotePixels.delete(key);
    applyPixel(Number(pixel.x), Number(pixel.y), pixel.color);
    n += 1;
  }
  if (pendingRemotePixels.size > 0) {
    remotePixelFlushRaf = requestAnimationFrame(flushRemotePixelBatch);
  }
}

function queueRemotePixels(pixels) {
  for (const p of pixels) {
    if (!p) continue;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    pendingRemotePixels.set(`${x},${y}`, { x, y, color: p.color });
  }
  if (remotePixelFlushRaf == null) {
    remotePixelFlushRaf = requestAnimationFrame(flushRemotePixelBatch);
  }
}

const MAX_PAINT_BATCH = 360;

function flushPaintBatch() {
  flushTimer = null;
  if (pendingPixels.size === 0) return;
  if (!(ws && ws.readyState === WebSocket.OPEN)) {
    scheduleFlush();
    return;
  }
  const pixels = Array.from(pendingPixels.values());
  let allSent = true;
  for (let i = 0; i < pixels.length; i += MAX_PAINT_BATCH) {
    if (!send({ type: "paint-batch", pixels: pixels.slice(i, i + MAX_PAINT_BATCH) })) {
      allSent = false;
      break;
    }
  }
  if (allSent) {
    pendingPixels.clear();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = window.setTimeout(flushPaintBatch, 14);
}

function releasePaintCapture() {
  if (paintCapturePointerId == null) return;
  try {
    if (board.releasePointerCapture) {
      board.releasePointerCapture(paintCapturePointerId);
    }
  } catch {
    // Ignore if capture already released.
  }
  paintCapturePointerId = null;
}

function stopPainting() {
  if (!isPainting) return;
  isPainting = false;
  lastPaintGrid = null;
  releasePaintCapture();
  setToolboxDrawingHidden(false);
  flushPaintBatch();
  renderColorHistory();
}

board.addEventListener("mousedown", (event) => {
  if (shouldStartPanning(event)) return;
  if (event.button !== 0) return;
  event.preventDefault();
  lastPaintGrid = null;
  isPainting = true;
  setToolboxDrawingHidden(true);
  if (typeof event.pointerId === "number" && board.setPointerCapture) {
    try {
      board.setPointerCapture(event.pointerId);
      paintCapturePointerId = event.pointerId;
    } catch {
      paintCapturePointerId = null;
    }
  }
  paintCellFromEvent(event);
  scheduleFlush();
});

window.addEventListener("mouseup", () => {
  stopSectionReorder();
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
  if (isPainting && (event.buttons & 1) !== 1) {
    stopPainting();
  } else if (
    isPainting &&
    (event.buttons & 1) === 1 &&
    clientIsOverBoardViewport(event.clientX, event.clientY)
  ) {
    paintAtClient(event.clientX, event.clientY);
    scheduleFlush();
  }
  if (sectionReorder) {
    moveSectionReorder(event.clientY);
  } else if (workspaceDragging) {
    dragWorkspace(event);
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
  send({
    type: "set-name",
    name: nameInput.value.trim() || "Student",
    clientKey: getOrCreateClientKey(),
  });
});

eraserBtn.addEventListener("click", () => {
  isErasing = !isErasing;
  eraserBtn.textContent = `Eraser: ${isErasing ? "On" : "Off"}`;
  toolText.textContent = `Tool: ${isErasing ? "Eraser" : "Brush"}`;
});

function clearMyDrawingWithConfirm() {
  if (
    !window.confirm(
      "Clear only the pixels you painted on the shared board? Other artists’ pixels stay."
    )
  ) {
    return;
  }
  send({ type: "clear-board" });
}

clearBtn.addEventListener("click", () => {
  clearMyDrawingWithConfirm();
});

zoomInput.addEventListener("input", () => {
  if (boardZoomAnchorClient) {
    setZoom(zoomInput.value, boardZoomAnchorClient.x, boardZoomAnchorClient.y);
  } else {
    setZoom(zoomInput.value);
  }
});

zoomOutBtn.addEventListener("click", () => {
  if (boardZoomAnchorClient) {
    setZoom(zoomLevel - 0.05, boardZoomAnchorClient.x, boardZoomAnchorClient.y);
  } else {
    setZoom(zoomLevel - 0.05);
  }
});

zoomInBtn.addEventListener("click", () => {
  if (boardZoomAnchorClient) {
    setZoom(zoomLevel + 0.05, boardZoomAnchorClient.x, boardZoomAnchorClient.y);
  } else {
    setZoom(zoomLevel + 0.05);
  }
});

colorInput.addEventListener("change", () => {
  addColorToHistory(colorInput.value);
});

function wheelZoomStep(event) {
  let delta = event.deltaY;
  if (event.deltaMode === 1) {
    delta *= 16;
  } else if (event.deltaMode === 2) {
    delta *= boardViewport.clientHeight;
  }
  const sensitivity = 0.0012;
  return clamp(-delta * sensitivity, -0.12, 0.12);
}

/** One zoom apply per frame; keeps cursor-anchored math from fighting rapid wheel bursts. */
let wheelZoomAccum = 0;
let wheelZoomRaf = null;
let wheelZoomClientX = 0;
let wheelZoomClientY = 0;

function flushWheelZoomFrame() {
  wheelZoomRaf = null;
  if (wheelZoomAccum === 0) return;
  const step = clamp(wheelZoomAccum, -0.2, 0.2);
  wheelZoomAccum = 0;
  boardZoomAnchorClient = { x: wheelZoomClientX, y: wheelZoomClientY };
  setZoom(zoomLevel + step, wheelZoomClientX, wheelZoomClientY);
}

if (boardViewport instanceof HTMLElement) {
  boardViewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      const step = wheelZoomStep(event);
      if (step === 0) return;
      wheelZoomClientX = event.clientX;
      wheelZoomClientY = event.clientY;
      wheelZoomAccum += step;
      if (wheelZoomRaf == null) {
        wheelZoomRaf = requestAnimationFrame(flushWheelZoomFrame);
      }
    },
    { passive: false }
  );

  boardViewport.addEventListener("pointermove", (event) => {
    const r = boardViewport.getBoundingClientRect();
    const il = r.left + boardViewport.clientLeft;
    const it = r.top + boardViewport.clientTop;
    const iw = boardViewport.clientWidth;
    const ih = boardViewport.clientHeight;
    if (
      event.clientX >= il &&
      event.clientX < il + iw &&
      event.clientY >= it &&
      event.clientY < it + ih
    ) {
      boardZoomAnchorClient = { x: event.clientX, y: event.clientY };
    }
  });
  boardViewport.addEventListener("pointerleave", () => {
    boardZoomAnchorClient = null;
  });
}

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
  const canUseCanvasShortcut = shouldHandleCanvasShortcut(event);
  if (!hasEnteredBoard) return;
  if (event.code === "Tab" && canUseCanvasShortcut) {
    if (event.repeat) return;
    event.preventDefault();
    toggleWorkspaceHidden();
    return;
  }
  if (event.code === "Space" && canUseCanvasShortcut) {
    isSpaceHeld = true;
    event.preventDefault();
  }
  if (!canUseCanvasShortcut) return;
  const key = event.key.toLowerCase();
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "e") {
    event.preventDefault();
    isErasing = !isErasing;
    eraserBtn.textContent = `Eraser: ${isErasing ? "On" : "Off"}`;
    toolText.textContent = `Tool: ${isErasing ? "Eraser" : "Brush"}`;
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "x") {
    event.preventDefault();
    clearMyDrawingWithConfirm();
    return;
  }
  const isCmdOrCtrl = event.ctrlKey || event.metaKey;
  if (!isCmdOrCtrl) return;

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
if (statusText instanceof HTMLElement) {
  statusText.textContent = "Status: click anywhere to load";
}
if (launchLoadingBar instanceof HTMLElement) {
  buildLaunchLoadingBar();
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (hasEnteredBoard) return;
      if (!(document.body instanceof HTMLElement) || !document.body.classList.contains("app-gated")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      fillNextLaunchPixel(event);
    },
    true
  );
} else {
  enterBoardExperience();
}

const launchMenuButtons = [launchStartBtn, launchJoinBtn];
launchMenuButtons.forEach((button) => {
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener("click", (event) => {
    if (hasEnteredBoard) return;
    fillAllLaunchPixels(event);
  });
});

window.addEventListener("resize", () => {
  if (boardZoomAnchorClient) {
    setZoom(zoomLevel, boardZoomAnchorClient.x, boardZoomAnchorClient.y);
  } else {
    setZoom(zoomLevel);
  }
});
