const board = document.getElementById("board");
const boardViewport = document.getElementById("boardViewport");
const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const colorInput = document.getElementById("colorInput");
const eraserBtn = document.getElementById("eraserBtn");
const clearBtn = document.getElementById("clearBtn");
const pencilModeBtn = document.getElementById("pencilModeBtn");
const zoomInput = document.getElementById("zoomInput");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomText = document.getElementById("zoomText");
const toolText = document.getElementById("toolText");
const statusText = document.getElementById("statusText");
const roomText = document.getElementById("roomText");
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
const shortcutHelpOpenBtn = document.getElementById("shortcutHelpOpenBtn");
const launchGate = document.getElementById("launchGate");
const launchShell = document.getElementById("launchShell");
const launchJoinBtn = document.getElementById("launchJoinBtn");
const launchCreateBtn = document.getElementById("launchCreateBtn");
const launchRoomInput = document.getElementById("launchRoomInput");
const launchRoomCodeInput = document.getElementById("launchRoomCodeInput");
const launchRoomHint = document.getElementById("launchRoomHint");
const launchRoomList = document.getElementById("launchRoomList");
const copyRoomCodeBtn = document.getElementById("copyRoomCodeBtn");
const workspaceRoomInput = document.getElementById("workspaceRoomInput");
const workspaceRoomPasswordInput = document.getElementById("workspaceRoomPasswordInput");
const workspaceJoinRoomBtn = document.getElementById("workspaceJoinRoomBtn");
const workspaceCreateRoomBtn = document.getElementById("workspaceCreateRoomBtn");
const workspaceBackToLaunchBtn = document.getElementById("workspaceBackToLaunchBtn");
const shortcutHelpOverlay = document.getElementById("shortcutHelpOverlay");
const shortcutHelpCloseBtn = document.getElementById("shortcutHelpCloseBtn");
let drawingTagLayer = null;

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
/** Active pointer id for touch/pen painting sessions. */
let activePaintPointerId = null;
/** Pointer type for current paint session ("mouse" | "touch" | "pen"). */
let activePaintPointerType = null;
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
const DESKTOP_MAX_ZOOM = 2.2;
const MOBILE_MAX_ZOOM = 2.2;
let zoomLevel = 1;
/** Last pointer position over board viewport for anchored zoom controls. */
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
let workspaceDragPointerId = null;
let workspaceHidden = false;
let workspaceHideTimer = null;
let hasEnteredBoard = false;
const LAUNCH_ENTER_ANIM_MS = 760;
let launchGateHideTimer = null;
let sectionReorder = null;
const SECTION_REORDER_SLOT_UNSET = Symbol("sectionReorderSlot");
/** Last drop target for placeholder; avoids repeat `insertBefore` / `appendChild` every mousemove. */
let sectionReorderInsertBefore = SECTION_REORDER_SLOT_UNSET;
const COLOR_HISTORY_KEY = "pixel-board-color-history";
const PENCIL_MODE_KEY = "pixel-board-pencil-mode";
const CLIENT_KEY_STORAGE = "pixel-board-client-key";
const BOARD_SESSION_KEY = "pixel-board-last-session";
const MAX_COLOR_HISTORY = 10;
let maxRoomCount = 5;
let maxUsersPerRoom = 30;
const PUBLIC_ROOM_ID = "lobby";
let selectedRoomId = PUBLIC_ROOM_ID;
let selectedRoomPassword = "";
let launchConnectMode = "start";
let shouldReconnect = true;
let roomPresencePollTimer = null;
let manualRoomSwitchInProgress = false;
let recentColors = [];
let pencilDrawingMode = false;
let colorPickerOpen = false;
let selfUserId = "";
const activeDrawingTags = new Map();
const DRAWING_TAG_MS = 1300;

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

function wsUrl(roomId = selectedRoomId, mode = launchConnectMode, roomPassword = selectedRoomPassword) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}`);
  if (typeof roomId === "string" && roomId) {
    url.searchParams.set("room", roomId);
  }
  if (typeof mode === "string" && mode) {
    url.searchParams.set("mode", mode);
  }
  if (typeof roomPassword === "string" && roomPassword) {
    url.searchParams.set("password", roomPassword);
  }
  return url.toString();
}

function normalizeRoomId(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  if (!cleaned) return null;
  if (!/^[a-z0-9][a-z0-9_-]{1,19}$/.test(cleaned)) return null;
  return cleaned;
}

function displayRoomLabel(roomId) {
  if (typeof roomId !== "string" || !roomId) return "LOBBY";
  return roomId.replace(/-/g, " ").toUpperCase();
}

function updateLaunchRoomHint(message, isError = false) {
  if (!(launchRoomHint instanceof HTMLElement)) return;
  launchRoomHint.textContent = message;
  launchRoomHint.classList.toggle("error", isError);
}

function setSelectedRoom(roomId) {
  selectedRoomId = roomId;
  if (launchRoomInput instanceof HTMLInputElement) {
    launchRoomInput.value = displayRoomLabel(roomId);
  }
  updateRoomUi();
}

function updateRoomUi() {
  if (roomText instanceof HTMLElement) {
    const label = selectedRoomId ? displayRoomLabel(selectedRoomId) : "-";
    roomText.textContent = `Room: ${label}`;
  }
  if (copyRoomCodeBtn instanceof HTMLButtonElement) {
    const workspaceCode =
      workspaceRoomPasswordInput instanceof HTMLInputElement
        ? normalizeRoomCode(workspaceRoomPasswordInput.value)
        : "";
    copyRoomCodeBtn.disabled = !(workspaceCode || selectedRoomPassword);
    copyRoomCodeBtn.textContent = "Copy";
  }
  syncWorkspaceRoomControls();
}

function setLaunchConnectMode(nextMode, options = {}) {
  const mode = nextMode === "create" ? "create" : nextMode === "join" ? "join" : "start";
  launchConnectMode = mode;
  const needsPassword = mode === "join" || mode === "create";
  if (launchShell instanceof HTMLElement) {
    launchShell.classList.toggle("join-mode", needsPassword);
    launchShell.classList.toggle("create-mode", mode === "create");
  }
  if (launchJoinBtn instanceof HTMLButtonElement) {
    launchJoinBtn.setAttribute("aria-pressed", String(mode === "join"));
  }
  if (launchCreateBtn instanceof HTMLButtonElement) {
    launchCreateBtn.setAttribute("aria-pressed", String(mode === "create"));
  }
  if (launchRoomCodeInput instanceof HTMLInputElement) {
    launchRoomCodeInput.disabled = !needsPassword;
    launchRoomCodeInput.required = needsPassword;
    if (!needsPassword) {
      launchRoomCodeInput.value = "";
      selectedRoomPassword = "";
    } else if (options.focusCode) {
      launchRoomCodeInput.focus({ preventScroll: true });
      launchRoomCodeInput.select();
    }
  }
  updateRoomUi();
}

function normalizeRoomCode(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 20);
}

function saveBoardSession() {
  const payload = {
    roomId: selectedRoomId,
    roomPassword: selectedRoomPassword,
    mode: launchConnectMode,
    inBoard: hasEnteredBoard,
    at: Date.now(),
  };
  try {
    window.localStorage.setItem(BOARD_SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Ignore localStorage errors.
  }
}

function loadBoardSession() {
  try {
    const raw = window.localStorage.getItem(BOARD_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.inBoard !== true) return null;
    const roomId =
      typeof data.roomId === "string" && data.roomId === PUBLIC_ROOM_ID
        ? PUBLIC_ROOM_ID
        : normalizeRoomId(data.roomId);
    if (!roomId) return null;
    return {
      roomId,
      roomPassword: normalizeRoomCode(data.roomPassword),
      mode: data.mode === "create" ? "create" : data.mode === "join" ? "join" : "start",
    };
  } catch {
    return null;
  }
}

function syncWorkspaceRoomControls() {
  if (workspaceRoomInput instanceof HTMLInputElement) {
    workspaceRoomInput.value = selectedRoomId || PUBLIC_ROOM_ID;
  }
  if (workspaceRoomPasswordInput instanceof HTMLInputElement) {
    workspaceRoomPasswordInput.value = selectedRoomPassword || "";
  }
}

function reconnectToCurrentRoom() {
  if (!hasEnteredBoard) {
    enterBoardExperience();
    return;
  }
  const currentWs = ws;
  manualRoomSwitchInProgress = true;
  shouldReconnect = false;
  const beginConnect = () => {
    manualRoomSwitchInProgress = false;
    shouldReconnect = true;
    connect();
  };
  if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
    try {
      currentWs.close(1000, "switch-room");
    } catch {
      // Ignore close failures and reconnect anyway.
    }
    window.setTimeout(beginConnect, 90);
    return;
  }
  beginConnect();
}

function clearLaunchGateHideTimer() {
  if (launchGateHideTimer == null) return;
  window.clearTimeout(launchGateHideTimer);
  launchGateHideTimer = null;
}

function isLaunchGateVisible() {
  return launchGate instanceof HTMLElement && !launchGate.classList.contains("hidden");
}

function closeLaunchOverlay() {
  if (!(launchGate instanceof HTMLElement)) return;
  clearLaunchGateHideTimer();
  launchGate.classList.remove("workspace-modal");
  launchGate.classList.remove("is-entering");
  launchGate.classList.add("hidden");
  if (hasEnteredBoard) {
    stopRoomPresencePolling();
  }
}

function openLaunchOverlayFromWorkspace(mode = "join") {
  if (!(launchGate instanceof HTMLElement)) return;
  clearLaunchGateHideTimer();
  const overlayMode = mode === "create" ? "create" : "join";
  const roomRaw = workspaceRoomInput instanceof HTMLInputElement ? workspaceRoomInput.value : "";
  const roomId = normalizeRoomId(roomRaw) || PUBLIC_ROOM_ID;
  const roomPassword = normalizeRoomCode(
    workspaceRoomPasswordInput instanceof HTMLInputElement ? workspaceRoomPasswordInput.value : ""
  );
  setSelectedRoom(roomId);
  selectedRoomPassword = roomPassword;
  updateRoomUi();
  launchGate.classList.remove("hidden");
  launchGate.classList.remove("is-entering");
  launchGate.classList.add("workspace-modal");
  if (document.body instanceof HTMLElement) {
    document.body.classList.remove("app-gated");
    document.body.classList.remove("entering-canvas");
  }
  setLaunchConnectMode(overlayMode, { focusCode: overlayMode !== "create" });
  updateLaunchRoomHint(
    overlayMode === "create"
      ? "Choose room + password, then press CREATE ROOM."
      : "Select available room, then press JOIN ROOM.",
    false
  );
  void refreshRoomPresence();
  startRoomPresencePolling();
  if (launchRoomInput instanceof HTMLInputElement && overlayMode === "create") {
    launchRoomInput.focus({ preventScroll: true });
    launchRoomInput.select();
  }
}

function returnToLaunchScreen() {
  if (!hasEnteredBoard) return;
  hasEnteredBoard = false;
  shouldReconnect = false;
  manualRoomSwitchInProgress = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try {
      ws.close(1000, "back-to-launch");
    } catch {
      // Ignore close failures while returning to launch.
    }
  }
  if (launchGate instanceof HTMLElement) {
    clearLaunchGateHideTimer();
    launchGate.classList.remove("workspace-modal");
    launchGate.classList.remove("hidden");
    launchGate.classList.remove("is-entering");
  }
  if (document.body instanceof HTMLElement) {
    document.body.classList.remove("entering-canvas");
    document.body.classList.add("app-gated");
  }
  setShortcutHelpOpen(false);
  saveBoardSession();
  updateRoomUi();
  updateLaunchRoomHint(`Choose a room to join or create.`, false);
  startRoomPresencePolling();
  void refreshRoomPresence();
  if (statusText instanceof HTMLElement) {
    statusText.textContent = "Status: choose room to connect";
  }
}

function renderRoomPresence(rooms = []) {
  if (!(launchRoomList instanceof HTMLElement)) return;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    launchRoomList.innerHTML = '<div class="launch-room-item"><span class="launch-room-item-label">Loading...</span></div>';
    return;
  }
  launchRoomList.innerHTML = "";
  rooms.forEach((room) => {
    const roomId = typeof room?.id === "string" ? room.id : "";
    const label = typeof room?.label === "string" ? room.label : displayRoomLabel(roomId);
    const users = Number.isInteger(room?.users) ? room.users : 0;
    const cap = Number.isInteger(room?.capacity) ? room.capacity : maxUsersPerRoom;
    const isPublic = Boolean(room?.isPublic);
    const isLocked = Boolean(room?.isLocked);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "launch-room-item";
    if (roomId === selectedRoomId) item.classList.add("is-selected");
    if (cap > 0 && users >= Math.max(1, Math.floor(cap * 0.8))) item.classList.add("is-near-cap");
    const accessText = isPublic ? "OPEN" : isLocked ? "LOCKED" : "PRIVATE";
    item.innerHTML =
      `<span class="launch-room-item-label">${label} (${accessText})</span>` +
      `<span class="launch-room-item-count">${users}/${cap}</span>`;
    item.addEventListener("click", () => {
      if (!roomId) return;
      setSelectedRoom(roomId);
      if (isPublic || roomId === PUBLIC_ROOM_ID) {
        setLaunchConnectMode("start");
        updateLaunchRoomHint(`Ready to join ${displayRoomLabel(roomId)}.`, false);
      } else {
        setLaunchConnectMode("join", { focusCode: true });
        updateLaunchRoomHint(`Enter password to join ${displayRoomLabel(roomId)}.`, false);
      }
    });
    launchRoomList.appendChild(item);
  });
}

async function refreshRoomPresence() {
  try {
    const res = await fetch("/api/rooms", { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    if (!payload || !Array.isArray(payload.rooms)) return;
    if (Number.isInteger(payload.maxRooms) && payload.maxRooms > 0) {
      maxRoomCount = payload.maxRooms;
    }
    if (Number.isInteger(payload.maxUsersPerRoom) && payload.maxUsersPerRoom > 0) {
      maxUsersPerRoom = payload.maxUsersPerRoom;
    }
    renderRoomPresence(payload.rooms);
  } catch {
    // Ignore transient fetch failures.
  }
}

function startRoomPresencePolling() {
  if (roomPresencePollTimer != null) return;
  void refreshRoomPresence();
  roomPresencePollTimer = window.setInterval(() => {
    if (hasEnteredBoard && !isLaunchGateVisible()) {
      stopRoomPresencePolling();
      return;
    }
    void refreshRoomPresence();
  }, 3500);
}

function stopRoomPresencePolling() {
  if (roomPresencePollTimer == null) return;
  window.clearInterval(roomPresencePollTimer);
  roomPresencePollTimer = null;
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

function setEnterOriginFromClick(sourceEvent) {
  if (!(document.body instanceof HTMLElement)) return;
  document.body.style.setProperty("--enter-origin-x", "50vw");
  document.body.style.setProperty("--enter-origin-y", "50vh");
}

function enterBoardExperience(sourceEvent = null) {
  if (hasEnteredBoard) return;
  hasEnteredBoard = true;
  saveBoardSession();
  stopRoomPresencePolling();
  setEnterOriginFromClick(sourceEvent);
  playLaunchPixelSound();
  if (document.body instanceof HTMLElement) {
    document.body.classList.remove("app-gated");
    document.body.classList.add("entering-canvas");
  }
  if (launchGate instanceof HTMLElement) {
    clearLaunchGateHideTimer();
    launchGate.classList.remove("workspace-modal");
    launchGate.classList.add("is-entering");
    launchGateHideTimer = window.setTimeout(() => {
      launchGate.classList.remove("is-entering");
      launchGate.classList.add("hidden");
      launchGateHideTimer = null;
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
      commitPendingPaintAction();
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

function syncPencilModeUi() {
  if (!(pencilModeBtn instanceof HTMLButtonElement)) return;
  pencilModeBtn.textContent = `Pencil Mode: ${pencilDrawingMode ? "On" : "Off"}`;
  pencilModeBtn.setAttribute("aria-pressed", String(pencilDrawingMode));
}

function savePencilModeSetting() {
  try {
    window.localStorage.setItem(PENCIL_MODE_KEY, pencilDrawingMode ? "1" : "0");
  } catch {
    // Ignore localStorage failures.
  }
}

function loadPencilModeSetting() {
  try {
    pencilDrawingMode = window.localStorage.getItem(PENCIL_MODE_KEY) === "1";
  } catch {
    pencilDrawingMode = false;
  }
  syncPencilModeUi();
}

function shouldHandleCanvasShortcut(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  const tag = target.tagName;
  return tag !== "INPUT" && tag !== "TEXTAREA" && !target.isContentEditable;
}

function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = String(target.getAttribute("type") || "text").toLowerCase();
  return (
    type === "text" ||
    type === "search" ||
    type === "email" ||
    type === "url" ||
    type === "tel" ||
    type === "password" ||
    type === "number"
  );
}

function openColorPicker() {
  if (!(colorInput instanceof HTMLInputElement)) return;
  colorPickerOpen = true;
  colorInput.focus({ preventScroll: true });
  if (typeof colorInput.showPicker === "function") {
    try {
      colorInput.showPicker();
      return;
    } catch {
      // Fall back to click if showPicker is blocked.
    }
  }
  colorInput.click();
}

function closeColorPicker() {
  colorPickerOpen = false;
  if (colorInput instanceof HTMLInputElement) {
    try {
      colorInput.blur();
    } catch {
      // Ignore blur failures.
    }
  }
}

function toggleColorPicker() {
  if (colorPickerOpen) {
    closeColorPicker();
    return;
  }
  openColorPicker();
}

function isShortcutHelpOpen() {
  return shortcutHelpOverlay instanceof HTMLElement && !shortcutHelpOverlay.classList.contains("hidden");
}

function setShortcutHelpOpen(shouldOpen) {
  if (!(shortcutHelpOverlay instanceof HTMLElement)) return;
  const open = Boolean(shouldOpen);
  shortcutHelpOverlay.classList.toggle("hidden", !open);
  shortcutHelpOverlay.setAttribute("aria-hidden", String(!open));
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
  clearDrawingActivityTags();
  board.innerHTML = "";
  drawingTagLayer = null;
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
  drawingTagLayer = document.createElement("div");
  drawingTagLayer.className = "drawing-tag-layer";
  drawingTagLayer.setAttribute("aria-hidden", "true");
  board.appendChild(drawingTagLayer);
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
  const maxZoom = getEffectiveMaxZoom();
  const boardWidth = board.offsetWidth;
  const boardHeight = board.offsetHeight;
  if (boardWidth <= 0 || boardHeight <= 0) return MIN_ZOOM;

  const fitByWidth = boardViewport.clientWidth / boardWidth;
  const fitByHeight = boardViewport.clientHeight / boardHeight;
  const fitZoom = Math.max(fitByWidth, fitByHeight);
  return Math.min(maxZoom, Math.max(MIN_ZOOM, fitZoom));
}

function getEffectiveMaxZoom() {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches
    ? MOBILE_MAX_ZOOM
    : DESKTOP_MAX_ZOOM;
}

function updateZoomSliderVisual() {
  if (!(zoomInput instanceof HTMLInputElement)) return;
  const min = Number(zoomInput.min);
  const max = Number(zoomInput.max);
  const value = Number(zoomInput.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(value) || max <= min) {
    zoomInput.style.setProperty("--range-fill", "0%");
    return;
  }
  const percent = clamp(((value - min) / (max - min)) * 100, 0, 100);
  zoomInput.style.setProperty("--range-fill", `${percent}%`);
}

function setZoom(nextZoom, anchorClientX = null, anchorClientY = null) {
  const prevZoom = Math.max(1e-6, zoomLevel);
  const minZoom = getEffectiveMinZoom();
  const maxZoom = getEffectiveMaxZoom();
  zoomInput.min = String(minZoom);
  zoomInput.max = String(maxZoom);
  const clamped = Math.min(maxZoom, Math.max(minZoom, Number(nextZoom)));
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
  const localX = (boardViewport.scrollLeft + pivotRelX) / prevZoom;
  const localY = (boardViewport.scrollTop + pivotRelY) / prevZoom;

  zoomLevel = clamped;
  zoomInput.value = String(clamped);
  updateZoomSliderVisual();
  zoomText.textContent = `Zoom: ${Math.round(clamped * 100)}%`;
  board.style.transform = `scale(${zoomLevel})`;
  void board.offsetWidth;

  const nextScrollLeft = localX * clamped - pivotRelX;
  const nextScrollTop = localY * clamped - pivotRelY;
  const maxLeft = Math.max(0, boardViewport.scrollWidth - boardViewport.clientWidth);
  const maxTop = Math.max(0, boardViewport.scrollHeight - boardViewport.clientHeight);
  boardViewport.scrollLeft = clamp(nextScrollLeft, 0, maxLeft);
  boardViewport.scrollTop = clamp(nextScrollTop, 0, maxTop);
}

function applyZoomKeepingLocalPoint(nextZoom, localX, localY, anchorClientX, anchorClientY) {
  const minZoom = getEffectiveMinZoom();
  const maxZoom = getEffectiveMaxZoom();
  const clamped = Math.min(maxZoom, Math.max(minZoom, Number(nextZoom)));
  if (!Number.isFinite(clamped)) return;
  const viewportRect = boardViewport.getBoundingClientRect();
  const innerLeft = viewportRect.left + boardViewport.clientLeft;
  const innerTop = viewportRect.top + boardViewport.clientTop;
  const viewW = boardViewport.clientWidth;
  const viewH = boardViewport.clientHeight;
  const pivotX = clamp(anchorClientX, innerLeft, innerLeft + Math.max(0, viewW - 1e-6));
  const pivotY = clamp(anchorClientY, innerTop, innerTop + Math.max(0, viewH - 1e-6));
  const pivotRelX = pivotX - innerLeft;
  const pivotRelY = pivotY - innerTop;

  zoomInput.min = String(minZoom);
  zoomInput.max = String(maxZoom);
  zoomLevel = clamped;
  zoomInput.value = String(clamped);
  updateZoomSliderVisual();
  zoomText.textContent = `Zoom: ${Math.round(clamped * 100)}%`;
  board.style.transform = `scale(${zoomLevel})`;
  void board.offsetWidth;

  const nextScrollLeft = localX * clamped - pivotRelX;
  const nextScrollTop = localY * clamped - pivotRelY;
  const maxLeft = Math.max(0, boardViewport.scrollWidth - boardViewport.clientWidth);
  const maxTop = Math.max(0, boardViewport.scrollHeight - boardViewport.clientHeight);
  boardViewport.scrollLeft = clamp(nextScrollLeft, 0, maxLeft);
  boardViewport.scrollTop = clamp(nextScrollTop, 0, maxTop);
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

function edgeGuardedScrollTarget(current, target, max) {
  if (!(max > 0)) return 0;
  const clamped = clamp(target, 0, max);
  const nearMin = current <= ZOOM_EDGE_GUARD_PX;
  const nearMax = current >= max - ZOOM_EDGE_GUARD_PX;
  const wantsPastMin = target < 0;
  const wantsPastMax = target > max;
  if ((nearMin && wantsPastMin) || (nearMax && wantsPastMax)) {
    return current;
  }
  return clamped;
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
  setWorkspaceUiCollapsed(!workspacePanel.classList.contains("workspace-ui-collapsed"));
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
let workspaceSwipeStart = null;
let multiFingerTapCandidate = null;
let lastTwoFingerTapAt = 0;
let lastThreeFingerTapAt = 0;
let activeBoardTouchCount = 0;
let blockTouchPaintUntil = 0;
let lastPenUseAt = 0;
let touchPanState = null;
let touchPinchState = null;
const TWO_FINGER_TAP_MAX_MS = 380;
const TWO_FINGER_TAP_MAX_MOVE_PX = 36;
const TWO_FINGER_PAN_CANCEL_PX = 14;
const TWO_FINGER_DOUBLE_TAP_MS = 650;
const THREE_FINGER_DOUBLE_TAP_MS = 650;
const ZOOM_EDGE_GUARD_PX = 10;

function isMobileWorkspaceDockMode() {
  return window.matchMedia("(max-width: 700px)").matches;
}

function setWorkspaceUiCollapsed(shouldCollapse) {
  if (!(workspacePanel instanceof HTMLElement)) return;
  stopSectionReorder();
  workspacePanel.classList.toggle("workspace-ui-collapsed", Boolean(shouldCollapse));
  syncWorkspaceCollapseButton();
}

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
  if (isMobileWorkspaceDockMode()) return;
  workspaceDragging = true;
  workspaceDragLastX = event.clientX;
  workspaceDragLastY = event.clientY;
  workspaceDragPointerId = typeof event.pointerId === "number" ? event.pointerId : null;
  workspacePanel.classList.add("is-dragging");
  if (workspaceHandle instanceof HTMLElement && workspaceDragPointerId != null && workspaceHandle.setPointerCapture) {
    try {
      workspaceHandle.setPointerCapture(workspaceDragPointerId);
    } catch {
      // Ignore capture errors in non-pointer contexts.
    }
  }
}

function isWorkspaceDragPointerMatch(pointerId) {
  if (workspaceDragPointerId == null) return true;
  if (typeof pointerId !== "number") return true;
  return pointerId === workspaceDragPointerId;
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
  if (workspaceHandle instanceof HTMLElement && workspaceDragPointerId != null && workspaceHandle.releasePointerCapture) {
    try {
      workspaceHandle.releasePointerCapture(workspaceDragPointerId);
    } catch {
      // Ignore if pointer capture already released.
    }
  }
  workspaceDragPointerId = null;
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
  workspaceHandle.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceDragging) {
      stopWorkspaceDrag();
    }
    toggleWorkspaceUiCollapsed();
  });
  workspaceHandle.addEventListener("pointerdown", (event) => {
    if (isMobileWorkspaceDockMode()) return;
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
  workspaceHandle.addEventListener(
    "touchstart",
    (event) => {
      if (!isMobileWorkspaceDockMode()) return;
      if (event.touches.length !== 1) {
        workspaceSwipeStart = null;
        return;
      }
      const t = event.touches[0];
      workspaceSwipeStart = { x: t.clientX, y: t.clientY };
    },
    { passive: true }
  );
  workspaceHandle.addEventListener(
    "touchmove",
    (event) => {
      if (!isMobileWorkspaceDockMode() || !workspaceSwipeStart) return;
      if (event.touches.length !== 1) {
        workspaceSwipeStart = null;
        return;
      }
      const t = event.touches[0];
      const dx = t.clientX - workspaceSwipeStart.x;
      const dy = t.clientY - workspaceSwipeStart.y;
      if (dy > 18 && Math.abs(dx) < 56) {
        event.preventDefault();
      }
    },
    { passive: false }
  );
  workspaceHandle.addEventListener(
    "touchend",
    (event) => {
      if (!isMobileWorkspaceDockMode() || !workspaceSwipeStart) return;
      const t = event.changedTouches?.[0];
      if (!t) {
        workspaceSwipeStart = null;
        return;
      }
      const dx = t.clientX - workspaceSwipeStart.x;
      const dy = t.clientY - workspaceSwipeStart.y;
      workspaceSwipeStart = null;
      if (dy > 54 && Math.abs(dx) < 64) {
        setWorkspaceUiCollapsed(true);
      }
    },
    { passive: true }
  );
  workspaceHandle.addEventListener("lostpointercapture", () => {
    if (workspaceDragging) {
      stopWorkspaceDrag();
    }
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
    btn.textContent = collapsed ? "+" : "-";
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
      const isSelf = String(player.id || "") === String(selfUserId || "");
      li.textContent = isSelf ? `${player.name} (You)` : player.name;
      li.style.color = player.color;
      userList.appendChild(li);
    });
}

function clearDrawingActivityTags() {
  for (const state of activeDrawingTags.values()) {
    if (state?.timerId != null) {
      window.clearTimeout(state.timerId);
    }
  }
  activeDrawingTags.clear();
  if (drawingTagLayer instanceof HTMLElement) {
    drawingTagLayer.innerHTML = "";
  }
}

function positionDrawingTag(el, x, y) {
  if (!(el instanceof HTMLElement)) return;
  const px = BOARD_BORDER_PX + BOARD_PADDING_PX + x * CELL_STRIDE_PX + BASE_PIXEL_SIZE / 2;
  const py = BOARD_BORDER_PX + BOARD_PADDING_PX + y * CELL_STRIDE_PX;
  el.style.left = `${px}px`;
  el.style.top = `${py}px`;
}

function removeDrawingTag(userId) {
  const key = String(userId || "");
  if (!key) return;
  const state = activeDrawingTags.get(key);
  if (!state) return;
  if (state.timerId != null) {
    window.clearTimeout(state.timerId);
  }
  activeDrawingTags.delete(key);
  const el = state.el;
  if (!(el instanceof HTMLElement)) return;
  el.classList.add("is-fading");
  window.setTimeout(() => {
    if (el.parentElement) el.remove();
  }, 190);
}

function showDrawingActivityTag(user, point) {
  if (!(drawingTagLayer instanceof HTMLElement) || !user || !point) return;
  const id = String(user.id || "");
  if (!id || id === String(selfUserId || "")) return;
  const name = String(user.name || "Artist");
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  const brushColor = normalizeHexColor(point.color) || normalizeHexColor(user.color) || "#94a3b8";
  const existing = activeDrawingTags.get(id);
  let el = existing?.el;
  if (!(el instanceof HTMLElement)) {
    el = document.createElement("div");
    el.className = "drawing-tag";
    el.dataset.userId = id;
    drawingTagLayer.appendChild(el);
  } else {
    el.classList.remove("is-fading");
  }
  el.textContent = name;
  el.style.borderColor = `${brushColor}cc`;
  el.style.boxShadow = `0 0 0 1px ${brushColor}33, 0 3px 12px rgba(2, 6, 23, 0.45)`;
  positionDrawingTag(el, x, y);
  let timerId = existing?.timerId;
  if (timerId != null) {
    window.clearTimeout(timerId);
  }
  timerId = window.setTimeout(() => {
    removeDrawingTag(id);
  }, DRAWING_TAG_MS);
  activeDrawingTags.set(id, { el, timerId });
}

function pruneDrawingTagsForUsers(users) {
  const present = new Set((Array.isArray(users) ? users : []).map((u) => String(u?.id || "")));
  for (const id of activeDrawingTags.keys()) {
    if (!present.has(id)) {
      removeDrawingTag(id);
    }
  }
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
  pruneDrawingTagsForUsers(latestState.users);
}

function connect() {
  if (!hasEnteredBoard) return;
  shouldReconnect = true;
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
  clearDrawingActivityTags();

  statusText.textContent = "Status: connecting...";
  ws = new WebSocket(wsUrl(selectedRoomId, launchConnectMode, selectedRoomPassword));

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    const roomLabel = selectedRoomId ? displayRoomLabel(selectedRoomId) : "RANDOM";
    statusText.textContent = `Status: connected (${roomLabel})`;
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
      if (typeof msg.roomId === "string") {
        setSelectedRoom(msg.roomId);
      }
      if (typeof msg.roomPassword === "string") {
        selectedRoomPassword = normalizeRoomCode(msg.roomPassword);
      }
      updateRoomUi();
      setLaunchConnectMode(msg.isPublicRoom ? "start" : "join");
      selfUserId = typeof msg.selfUserId === "string" ? msg.selfUserId : "";
      saveBoardSession();
      updateLaunchRoomHint(`Connected to ${displayRoomLabel(selectedRoomId)}.`, false);
      renderState(msg);
      if (pendingPixels.size > 0) {
        for (const pixel of pendingPixels.values()) {
          applyPixel(Number(pixel.x), Number(pixel.y), pixel.color);
        }
        scheduleFlush();
      }
      return;
    }

    if (msg.type === "room-error") {
      const reason = typeof msg.message === "string" ? msg.message : "Room unavailable.";
      updateLaunchRoomHint(reason, true);
      statusText.textContent = `Status: ${reason}`;
      shouldReconnect = false;
      return;
    }

    if (msg.type === "users") {
      latestState.users = msg.users || [];
      playersText.textContent = `Artists online: ${latestState.users.length}`;
      renderUsers(latestState.users);
      pruneDrawingTagsForUsers(latestState.users);
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

    if (msg.type === "drawing-activity" && msg.user && msg.point) {
      showDrawingActivityTag(msg.user, msg.point);
      return;
    }
  });

  ws.addEventListener("close", (event) => {
    if (manualRoomSwitchInProgress) return;
    if (
      event.code === 4003 ||
      event.code === 4004 ||
      event.code === 4005 ||
      event.code === 4006 ||
      event.code === 4007 ||
      event.code === 4008
    ) {
      const reason = event.reason || "Room unavailable.";
      updateLaunchRoomHint(reason, true);
      statusText.textContent = `Status: ${reason}`;
      shouldReconnect = false;
      return;
    }
    if (!shouldReconnect) return;
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
const REMOTE_PIXEL_APPLY_CHUNK = 900;
/** Time budget (ms) for remote pixel apply each frame. */
const REMOTE_PIXEL_APPLY_BUDGET_MS = 6;
/** Small remote updates are applied immediately to reduce perceived lag. */
const REMOTE_PIXEL_IMMEDIATE_APPLY_MAX = 120;

function applyPendingRemotePixels(limit, budgetMs) {
  const start = performance.now();
  let applied = 0;
  for (const key of pendingRemotePixels.keys()) {
    if (applied >= limit) break;
    if (performance.now() - start >= budgetMs) break;
    const pixel = pendingRemotePixels.get(key);
    pendingRemotePixels.delete(key);
    applyPixel(Number(pixel.x), Number(pixel.y), pixel.color);
    applied += 1;
  }
}

function flushRemotePixelBatch() {
  remotePixelFlushRaf = null;
  if (pendingRemotePixels.size === 0) return;
  applyPendingRemotePixels(REMOTE_PIXEL_APPLY_CHUNK, REMOTE_PIXEL_APPLY_BUDGET_MS);
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
  if (pendingRemotePixels.size <= REMOTE_PIXEL_IMMEDIATE_APPLY_MAX) {
    applyPendingRemotePixels(REMOTE_PIXEL_IMMEDIATE_APPLY_MAX, 3.5);
  }
  if (pendingRemotePixels.size === 0) return;
  if (remotePixelFlushRaf == null) {
    remotePixelFlushRaf = requestAnimationFrame(flushRemotePixelBatch);
  }
}

const MAX_PAINT_BATCH = 360;
const PAINT_SEND_INTERVAL_MS = 8;

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

function commitPendingPaintAction() {
  if (pendingPixels.size === 0) return;
  flushPaintBatch();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = window.setTimeout(flushPaintBatch, PAINT_SEND_INTERVAL_MS);
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

function beginPainting(clientX, clientY, pointerId = null, pointerType = "mouse") {
  lastPaintGrid = null;
  isPainting = true;
  activePaintPointerId = typeof pointerId === "number" ? pointerId : null;
  activePaintPointerType = typeof pointerType === "string" ? pointerType : "mouse";
  setToolboxDrawingHidden(true);
  paintAtClient(clientX, clientY);
  scheduleFlush();
}

function shouldUseFingerPanMode() {
  return pencilDrawingMode || performance.now() - lastPenUseAt < 12000;
}

function continuePainting(clientX, clientY) {
  paintAtClient(clientX, clientY);
  scheduleFlush();
}

function stopPainting() {
  if (!isPainting) return;
  isPainting = false;
  activePaintPointerId = null;
  activePaintPointerType = null;
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
  beginPainting(event.clientX, event.clientY, null, "mouse");
});

board.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse") return;
  if (isPanning) return;
  if (event.pointerType === "pen") {
    lastPenUseAt = performance.now();
  } else if (multiFingerTapCandidate) {
    return;
  }
  if (event.pointerType === "touch") {
    if (activeBoardTouchCount > 1) return;
    if (performance.now() < blockTouchPaintUntil) return;
    if (shouldUseFingerPanMode()) return;
  }
  event.preventDefault();
  if (board.setPointerCapture) {
    try {
      board.setPointerCapture(event.pointerId);
      paintCapturePointerId = event.pointerId;
    } catch {
      paintCapturePointerId = null;
    }
  }
  beginPainting(event.clientX, event.clientY, event.pointerId, event.pointerType);
});

board.addEventListener("pointermove", (event) => {
  if (!isPainting) return;
  if (event.pointerType === "mouse") return;
  if (event.pointerType === "touch" && activePaintPointerType === "touch" && activeBoardTouchCount > 1) {
    stopPainting();
    return;
  }
  if (activePaintPointerId != null && event.pointerId !== activePaintPointerId) return;
  event.preventDefault();
  continuePainting(event.clientX, event.clientY);
});

board.addEventListener("pointerup", (event) => {
  if (event.pointerType === "mouse") return;
  if (activePaintPointerId != null && event.pointerId !== activePaintPointerId) return;
  stopPainting();
});

board.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "mouse") return;
  if (activePaintPointerId != null && event.pointerId !== activePaintPointerId) return;
  stopPainting();
});

window.addEventListener("mouseup", () => {
  stopSectionReorder();
  if (workspaceDragging) {
    stopWorkspaceDrag();
  }
  if (isPanning) {
    isPanning = false;
    boardViewport.classList.remove("is-panning");
  }
  stopPainting();
});

window.addEventListener("pointerup", (event) => {
  if (workspaceDragging && isWorkspaceDragPointerMatch(event.pointerId)) {
    stopWorkspaceDrag();
  }
});

window.addEventListener("pointermove", (event) => {
  if (!workspaceDragging) return;
  if (!isWorkspaceDragPointerMatch(event.pointerId)) return;
  dragWorkspace(event);
});

window.addEventListener("pointercancel", (event) => {
  if (workspaceDragging && isWorkspaceDragPointerMatch(event.pointerId)) {
    stopWorkspaceDrag();
  }
});

boardViewport.addEventListener("mousedown", (event) => {
  if (!shouldStartPanning(event)) return;
  event.preventDefault();
  startPanning(event);
});

window.addEventListener("mousemove", (event) => {
  if (!isPanning && isSpaceHeld && (event.buttons & 1) === 1 && clientIsOverBoardViewport(event.clientX, event.clientY)) {
    startPanning(event);
  }

  if (isPanning && event.buttons === 0) {
    isPanning = false;
    boardViewport.classList.remove("is-panning");
  }

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
  }
  if (!isPanning) return;
  const deltaX = event.clientX - panStartX;
  const deltaY = event.clientY - panStartY;
  boardViewport.scrollLeft = panScrollLeft - deltaX;
  boardViewport.scrollTop = panScrollTop - deltaY;
});

window.addEventListener("blur", () => {
  if (workspaceDragging) {
    stopWorkspaceDrag();
  }
  stopPainting();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    if (workspaceDragging) {
      stopWorkspaceDrag();
    }
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
  commitPendingPaintAction();
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

if (pencilModeBtn instanceof HTMLButtonElement) {
  pencilModeBtn.addEventListener("click", () => {
    pencilDrawingMode = !pencilDrawingMode;
    if (pencilDrawingMode && activePaintPointerType === "touch") {
      stopPainting();
    }
    syncPencilModeUi();
    savePencilModeSetting();
  });
}

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
  commitPendingPaintAction();
  if (isErasing) {
    isErasing = false;
    eraserBtn.textContent = "Eraser: Off";
    toolText.textContent = "Tool: Brush";
  }
  addColorToHistory(colorInput.value);
  colorPickerOpen = false;
});

colorInput.addEventListener("focus", () => {
  colorPickerOpen = true;
});

colorInput.addEventListener("blur", () => {
  colorPickerOpen = false;
});

colorInput.addEventListener(
  "pointerdown",
  (event) => {
    if (!colorPickerOpen) return;
    event.preventDefault();
    closeColorPicker();
  },
  { passive: false }
);

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

function touchDistance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function touchesContainStylus(touches) {
  if (!touches) return false;
  for (const t of touches) {
    if (t && typeof t.touchType === "string" && t.touchType.toLowerCase() === "stylus") {
      return true;
    }
  }
  return false;
}

if (boardViewport instanceof HTMLElement) {
  boardViewport.addEventListener(
    "touchstart",
    (event) => {
      if (touchesContainStylus(event.touches)) {
        return;
      }
      const fingers = event.touches.length;
      activeBoardTouchCount = fingers;
      touchPinchState = null;
      if (fingers === 1 && shouldUseFingerPanMode()) {
        const t = event.touches[0];
        touchPanState = {
          x: t.clientX,
          y: t.clientY,
          left: boardViewport.scrollLeft,
          top: boardViewport.scrollTop,
        };
        event.preventDefault();
      } else {
        touchPanState = null;
      }
      if (fingers === 2) {
        const a = event.touches[0];
        const b = event.touches[1];
        const centerX = (a.clientX + b.clientX) / 2;
        const centerY = (a.clientY + b.clientY) / 2;
        const vr = boardViewport.getBoundingClientRect();
        const innerLeft = vr.left + boardViewport.clientLeft;
        const innerTop = vr.top + boardViewport.clientTop;
        const pivotRelX = centerX - innerLeft;
        const pivotRelY = centerY - innerTop;
        touchPinchState = {
          startDistance: Math.max(1, touchDistance(a, b)),
          startZoom: zoomLevel,
          moved: false,
          localX: (boardViewport.scrollLeft + pivotRelX) / Math.max(1e-6, zoomLevel),
          localY: (boardViewport.scrollTop + pivotRelY) / Math.max(1e-6, zoomLevel),
        };
      }
      if (fingers !== 2 && fingers !== 3) {
        multiFingerTapCandidate = null;
        return;
      }
      blockTouchPaintUntil = performance.now() + 220;
      stopPainting();
      const a = event.touches[0];
      const b = event.touches[1];
      multiFingerTapCandidate = {
        fingers,
        at: performance.now(),
        centerX: (a.clientX + b.clientX) / 2,
        centerY: (a.clientY + b.clientY) / 2,
      };
    },
    { passive: false }
  );
  boardViewport.addEventListener(
    "touchmove",
    (event) => {
      if (touchesContainStylus(event.touches)) {
        return;
      }
      activeBoardTouchCount = event.touches.length;
      if (touchPanState && event.touches.length === 1) {
        const t = event.touches[0];
        const dx = t.clientX - touchPanState.x;
        const dy = t.clientY - touchPanState.y;
        boardViewport.scrollLeft = touchPanState.left - dx;
        boardViewport.scrollTop = touchPanState.top - dy;
        event.preventDefault();
        return;
      }
      if (touchPinchState && event.touches.length === 2) {
        const a = event.touches[0];
        const b = event.touches[1];
        const nextDistance = Math.max(1, touchDistance(a, b));
        const ratio = nextDistance / touchPinchState.startDistance;
        if (Math.abs(ratio - 1) > 0.02) {
          touchPinchState.moved = true;
        }
        const centerX = (a.clientX + b.clientX) / 2;
        const centerY = (a.clientY + b.clientY) / 2;
        applyZoomKeepingLocalPoint(
          touchPinchState.startZoom * ratio,
          touchPinchState.localX,
          touchPinchState.localY,
          centerX,
          centerY
        );
        event.preventDefault();
      }
      if (!multiFingerTapCandidate || event.touches.length !== multiFingerTapCandidate.fingers) return;
      if (touchPinchState?.moved && multiFingerTapCandidate.fingers === 2) {
        multiFingerTapCandidate = null;
        return;
      }
      const a = event.touches[0];
      const b = event.touches[1];
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      const dx = cx - multiFingerTapCandidate.centerX;
      const dy = cy - multiFingerTapCandidate.centerY;
      const moveSq = dx * dx + dy * dy;
      const cancelPx =
        multiFingerTapCandidate.fingers === 2 ? TWO_FINGER_PAN_CANCEL_PX : TWO_FINGER_TAP_MAX_MOVE_PX;
      if (moveSq > cancelPx * cancelPx) {
        multiFingerTapCandidate = null;
      }
    },
    { passive: false }
  );
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

  boardViewport.addEventListener(
    "touchend",
    (event) => {
      if (touchesContainStylus(event.changedTouches)) {
        return;
      }
      activeBoardTouchCount = event.touches.length;
      if (event.touches.length <= 1) {
        touchPinchState = null;
      }
      if (event.touches.length === 1 && shouldUseFingerPanMode()) {
        const t = event.touches[0];
        touchPanState = {
          x: t.clientX,
          y: t.clientY,
          left: boardViewport.scrollLeft,
          top: boardViewport.scrollTop,
        };
      } else if (event.touches.length === 0) {
        touchPanState = null;
      }
      if (!multiFingerTapCandidate) return;
      if (event.touches.length > 0) return;
      const now = performance.now();
      const dt = now - multiFingerTapCandidate.at;
      const fingers = multiFingerTapCandidate.fingers;
      multiFingerTapCandidate = null;
      if (dt > TWO_FINGER_TAP_MAX_MS) return;
      if (fingers === 2) {
        if (now - lastTwoFingerTapAt <= TWO_FINGER_DOUBLE_TAP_MS) {
          event.preventDefault();
          lastTwoFingerTapAt = 0;
          flushPaintBatch();
          send({ type: "undo" });
          return;
        }
        lastTwoFingerTapAt = now;
        return;
      }
      if (fingers === 3) {
        if (now - lastThreeFingerTapAt <= THREE_FINGER_DOUBLE_TAP_MS) {
          event.preventDefault();
          lastThreeFingerTapAt = 0;
          flushPaintBatch();
          send({ type: "redo" });
          return;
        }
        lastThreeFingerTapAt = now;
      }
    },
    { passive: false }
  );
  boardViewport.addEventListener(
    "touchcancel",
    () => {
      activeBoardTouchCount = 0;
      touchPanState = null;
      touchPinchState = null;
      multiFingerTapCandidate = null;
      stopPainting();
    },
    { passive: true }
  );
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

if (shortcutHelpCloseBtn instanceof HTMLButtonElement) {
  shortcutHelpCloseBtn.addEventListener("click", () => {
    setShortcutHelpOpen(false);
  });
}

if (shortcutHelpOpenBtn instanceof HTMLButtonElement) {
  shortcutHelpOpenBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setShortcutHelpOpen(true);
  });
}

if (shortcutHelpOverlay instanceof HTMLElement) {
  shortcutHelpOverlay.addEventListener("click", (event) => {
    if (event.target !== shortcutHelpOverlay) return;
    setShortcutHelpOpen(false);
  });
}

window.addEventListener("keydown", (event) => {
  if (!hasEnteredBoard) return;
  const textEntryFocused = isTextEntryTarget(event.target);
  if (
    event.code === "Space" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !textEntryFocused
  ) {
    isSpaceHeld = true;
    event.preventDefault();
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote") {
    event.preventDefault();
    setShortcutHelpOpen(!isShortcutHelpOpen());
    return;
  }
  if (isShortcutHelpOpen()) {
    if (event.code === "Escape") {
      event.preventDefault();
      setShortcutHelpOpen(false);
    }
    return;
  }
  const canUseCanvasShortcut = shouldHandleCanvasShortcut(event);
  if (event.code === "Escape" && canUseCanvasShortcut) {
    event.preventDefault();
    if (isLaunchGateVisible()) {
      closeLaunchOverlay();
      return;
    }
    returnToLaunchScreen();
    return;
  }
  if (event.code === "Tab" && canUseCanvasShortcut) {
    if (event.repeat) return;
    event.preventDefault();
    toggleWorkspaceHidden();
    return;
  }
  if (!canUseCanvasShortcut) return;
  const key = event.key.toLowerCase();
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "c") {
    event.preventDefault();
    commitPendingPaintAction();
    if (isErasing) {
      isErasing = false;
      eraserBtn.textContent = "Eraser: Off";
      toolText.textContent = "Tool: Brush";
    }
    toggleColorPicker();
    return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "e") {
    event.preventDefault();
    commitPendingPaintAction();
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
loadPencilModeSetting();
if (statusText instanceof HTMLElement) {
  statusText.textContent = "Status: pick a room and join";
}
const lastSession = loadBoardSession();
if (lastSession) {
  setSelectedRoom(lastSession.roomId);
  selectedRoomPassword = lastSession.roomPassword;
  setLaunchConnectMode(lastSession.mode);
  updateRoomUi();
  updateLaunchRoomHint(`Resuming ${displayRoomLabel(lastSession.roomId)}...`, false);
  enterBoardExperience();
} else {
  setLaunchConnectMode("start");
  updateLaunchRoomHint(`Up to ${maxRoomCount} rooms total, ${maxUsersPerRoom} users each.`, false);
  setSelectedRoom(PUBLIC_ROOM_ID);
  updateRoomUi();
  startRoomPresencePolling();
}

if (launchJoinBtn instanceof HTMLButtonElement) {
  launchJoinBtn.addEventListener("click", (event) => {
    const requested = normalizeRoomId(launchRoomInput instanceof HTMLInputElement ? launchRoomInput.value : "");
    if (!requested || requested === PUBLIC_ROOM_ID) {
      setLaunchConnectMode("start");
      setSelectedRoom(PUBLIC_ROOM_ID);
      selectedRoomPassword = "";
      updateRoomUi();
      updateLaunchRoomHint("Joining LOBBY...", false);
      if (hasEnteredBoard) {
        saveBoardSession();
        closeLaunchOverlay();
        reconnectToCurrentRoom();
      } else {
        enterBoardExperience(event);
      }
      return;
    }
    setLaunchConnectMode("join", { focusCode: true });
    const password = normalizeRoomCode(
      launchRoomCodeInput instanceof HTMLInputElement ? launchRoomCodeInput.value : ""
    );
    if (!password) {
      updateLaunchRoomHint("Room password required.", true);
      return;
    }
    setSelectedRoom(requested);
    selectedRoomPassword = password;
    updateRoomUi();
    updateLaunchRoomHint(`Joining ${displayRoomLabel(requested)}...`, false);
    if (hasEnteredBoard) {
      saveBoardSession();
      closeLaunchOverlay();
      reconnectToCurrentRoom();
    } else {
      enterBoardExperience(event);
    }
  });
}

if (launchCreateBtn instanceof HTMLButtonElement) {
  launchCreateBtn.addEventListener("click", (event) => {
    setLaunchConnectMode("create", { focusCode: true });
    const requested = normalizeRoomId(launchRoomInput instanceof HTMLInputElement ? launchRoomInput.value : "");
    if (!requested || requested === PUBLIC_ROOM_ID) {
      updateLaunchRoomHint("Choose a custom room name (not LOBBY).", true);
      return;
    }
    const password = normalizeRoomCode(
      launchRoomCodeInput instanceof HTMLInputElement ? launchRoomCodeInput.value : ""
    );
    if (password.length < 4) {
      updateLaunchRoomHint("Password must be at least 4 characters.", true);
      return;
    }
    setSelectedRoom(requested);
    selectedRoomPassword = password;
    updateRoomUi();
    updateLaunchRoomHint(`Creating ${displayRoomLabel(requested)}...`, false);
    void refreshRoomPresence();
    if (hasEnteredBoard) {
      saveBoardSession();
      closeLaunchOverlay();
      reconnectToCurrentRoom();
    } else {
      enterBoardExperience(event);
    }
  });
}

if (launchRoomInput instanceof HTMLInputElement) {
  launchRoomInput.addEventListener("input", () => {
    launchRoomInput.value = launchRoomInput.value.toLowerCase();
    const next = normalizeRoomId(launchRoomInput.value);
    if (next) {
      setSelectedRoom(next);
      updateLaunchRoomHint(`Ready for ${displayRoomLabel(next)}.`, false);
      void refreshRoomPresence();
    } else {
      updateLaunchRoomHint("Use 2-20 chars: a-z, 0-9, - or _.", true);
    }
  });
}

if (launchRoomCodeInput instanceof HTMLInputElement) {
  launchRoomCodeInput.addEventListener("input", () => {
    selectedRoomPassword = normalizeRoomCode(launchRoomCodeInput.value);
    updateRoomUi();
  });
}

if (copyRoomCodeBtn instanceof HTMLButtonElement) {
  copyRoomCodeBtn.addEventListener("click", async () => {
    const codeFromInput =
      workspaceRoomPasswordInput instanceof HTMLInputElement
        ? normalizeRoomCode(workspaceRoomPasswordInput.value)
        : "";
    const code = codeFromInput || selectedRoomPassword;
    if (!code) {
      updateLaunchRoomHint("Room password unavailable yet. Connect first.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      copyRoomCodeBtn.textContent = "Copied";
      window.setTimeout(() => {
        updateRoomUi();
      }, 1200);
    } catch {
      updateLaunchRoomHint("Could not copy automatically. Please copy manually.", true);
    }
  });
}

function switchRoomFromWorkspace(targetMode) {
  const mode = targetMode === "create" ? "create" : targetMode === "join" ? "join" : "start";
  if (mode === "join") {
    openLaunchOverlayFromWorkspace("join");
    return;
  }
  if (mode === "create") {
    openLaunchOverlayFromWorkspace("create");
    return;
  }
  if (mode === "start") {
    setSelectedRoom(PUBLIC_ROOM_ID);
    selectedRoomPassword = "";
    setLaunchConnectMode("start");
    updateLaunchRoomHint("Switching to LOBBY...", false);
    saveBoardSession();
    reconnectToCurrentRoom();
    return;
  }

  const roomRaw = workspaceRoomInput instanceof HTMLInputElement ? workspaceRoomInput.value : "";
  const roomId = normalizeRoomId(roomRaw);
  if (!roomId || roomId === PUBLIC_ROOM_ID) {
    updateLaunchRoomHint("Use a custom room name (not LOBBY).", true);
    return;
  }
  const roomPassword = normalizeRoomCode(
    workspaceRoomPasswordInput instanceof HTMLInputElement ? workspaceRoomPasswordInput.value : ""
  );
  if (!roomPassword) {
    updateLaunchRoomHint("Password is required.", true);
    return;
  }
  if (mode === "create" && roomPassword.length < 4) {
    updateLaunchRoomHint("Password must be at least 4 characters.", true);
    return;
  }
  setSelectedRoom(roomId);
  selectedRoomPassword = roomPassword;
  setLaunchConnectMode(mode);
  updateLaunchRoomHint(
    mode === "create" ? `Creating ${displayRoomLabel(roomId)}...` : `Joining ${displayRoomLabel(roomId)}...`,
    false
  );
  saveBoardSession();
  reconnectToCurrentRoom();
}

if (workspaceJoinRoomBtn instanceof HTMLButtonElement) {
  workspaceJoinRoomBtn.addEventListener("click", () => {
    switchRoomFromWorkspace("join");
  });
}

if (workspaceCreateRoomBtn instanceof HTMLButtonElement) {
  workspaceCreateRoomBtn.addEventListener("click", () => {
    switchRoomFromWorkspace("create");
  });
}

if (workspaceBackToLaunchBtn instanceof HTMLButtonElement) {
  workspaceBackToLaunchBtn.addEventListener("click", () => {
    returnToLaunchScreen();
  });
}

if (workspaceRoomInput instanceof HTMLInputElement) {
  workspaceRoomInput.addEventListener("input", () => {
    workspaceRoomInput.value = workspaceRoomInput.value.toLowerCase();
  });
}

if (workspaceRoomPasswordInput instanceof HTMLInputElement) {
  workspaceRoomPasswordInput.addEventListener("input", () => {
    selectedRoomPassword = normalizeRoomCode(workspaceRoomPasswordInput.value);
    updateRoomUi();
  });
}

if (launchGate instanceof HTMLElement) {
  launchGate.addEventListener("click", (event) => {
    if (!hasEnteredBoard) return;
    if (!launchGate.classList.contains("workspace-modal")) return;
    if (event.target !== launchGate) return;
    closeLaunchOverlay();
  });
}

window.addEventListener("resize", () => {
  if (boardZoomAnchorClient) {
    setZoom(zoomLevel, boardZoomAnchorClient.x, boardZoomAnchorClient.y);
  } else {
    setZoom(zoomLevel);
  }
});
