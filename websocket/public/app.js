(() => {
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const nameInput = document.getElementById("name");
  const saveNameBtn = document.getElementById("saveName");
  const clearBtn = document.getElementById("clear");
  const youLabel = document.getElementById("youLabel");
  const peerList = document.getElementById("peerList");
  const cursorsLayer = document.getElementById("cursors");

  let ws;
  let myId = null;
  let myColor = "#888";
  let drawing = false;
  let last = null;
  const peers = new Map();
  const remoteCursorEls = new Map();

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.classList.remove("ok", "bad");
    if (kind) statusEl.classList.add(kind);
  }

  function wsUrl() {
    const { protocol, host } = window.location;
    const p = protocol === "https:" ? "wss:" : "ws:";
    return `${p}//${host}`;
  }

  function renderPeerList() {
    peerList.innerHTML = "";
    const items = [{ id: myId, color: myColor, name: "You", self: true }];
    peers.forEach((p, id) => {
      if (id === myId) return;
      items.push({ id, color: p.color, name: p.name || "Anonymous", self: false });
    });
    items.forEach((row) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch" style="background:${row.color}"></span><span>${row.self ? `<strong>${row.name}</strong>` : escapeHtml(row.name)}</span>`;
      peerList.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function resizeCanvasCss() {
    const wrap = canvas.parentElement;
    const maxW = Math.max(320, wrap.clientWidth - 16);
    const scale = Math.min(1, maxW / canvas.width);
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
  }

  window.addEventListener("resize", resizeCanvasCss);
  resizeCanvasCss();

  function canvasPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    return {
      nx: x / canvas.width,
      ny: y / canvas.height,
    };
  }

  function drawSegment(stroke) {
    const { x0, y0, x1, y1, color, width } = stroke;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * Math.min(canvas.width, canvas.height));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
    ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
    ctx.stroke();
  }

  function redrawAll(strokes) {
    ctx.fillStyle = "#faf9f6";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    strokes.forEach(drawSegment);
  }

  function ensureRemoteCursor(userId, color, name) {
    let el = remoteCursorEls.get(userId);
    if (!el) {
      el = document.createElement("div");
      el.className = "remote-cursor";
      cursorsLayer.appendChild(el);
      remoteCursorEls.set(userId, el);
    }
    el.style.background = color;
    el.style.borderTopColor = color;
    el.textContent = name || "…";
    return el;
  }

  function positionRemoteCursor(userId, nx, ny, color, name) {
    const el = ensureRemoteCursor(userId, color, name);
    const rect = canvas.getBoundingClientRect();
    const wrapRect = cursorsLayer.getBoundingClientRect();
    const left = rect.left - wrapRect.left + nx * rect.width;
    const top = rect.top - wrapRect.top + ny * rect.height;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function removeRemoteCursor(userId) {
    const el = remoteCursorEls.get(userId);
    if (el) {
      el.remove();
      remoteCursorEls.delete(userId);
    }
  }

  function handleMessage(data) {
    switch (data.type) {
      case "welcome":
        myId = data.userId;
        myColor = data.color;
        youLabel.innerHTML = `You are <strong style="color:${myColor}">${myId.slice(0, 8)}…</strong>`;
        redrawAll(data.strokes || []);
        (data.peers || []).forEach((p) => {
          peers.set(p.userId, { color: p.color, name: p.name });
        });
        renderPeerList();
        setStatus("Connected — draw with others", "ok");
        break;
      case "join":
        if (data.userId !== myId) {
          peers.set(data.userId, { color: data.color, name: null });
          renderPeerList();
        }
        break;
      case "profile":
        peers.set(data.userId, { color: data.color, name: data.name });
        renderPeerList();
        break;
      case "leave":
        peers.delete(data.userId);
        removeRemoteCursor(data.userId);
        renderPeerList();
        break;
      case "stroke":
        drawSegment(data);
        break;
      case "clear":
        ctx.fillStyle = "#faf9f6";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        break;
      case "cursor":
        if (data.userId === myId) break;
        positionRemoteCursor(data.userId, data.x, data.y, data.color, data.name);
        break;
      default:
        break;
    }
  }

  function connect() {
    setStatus("Connecting…");
    ws = new WebSocket(wsUrl());

    ws.addEventListener("open", () => {
      const saved = localStorage.getItem("collabName");
      if (saved) {
        nameInput.value = saved;
        ws.send(JSON.stringify({ type: "hello", name: saved }));
      }
    });

    ws.addEventListener("message", (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener("close", () => {
      setStatus("Disconnected — retrying…", "bad");
      peers.clear();
      remoteCursorEls.forEach((el) => el.remove());
      remoteCursorEls.clear();
      renderPeerList();
      setTimeout(connect, 1500);
    });

    ws.addEventListener("error", () => {
      setStatus("WebSocket error", "bad");
    });
  }

  function sendStroke(x0, y0, x1, y1) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "stroke",
        x0,
        y0,
        x1,
        y1,
        width: 0.006,
      })
    );
  }

  let lastCursorSend = 0;
  function maybeSendCursor(nx, ny) {
    const now = performance.now();
    if (now - lastCursorSend < 40) return;
    lastCursorSend = now;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "cursor", x: nx, y: ny }));
  }

  canvas.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    drawing = true;
    last = canvasPoint(ev);
  });

  canvas.addEventListener("pointermove", (ev) => {
    const { nx, ny } = canvasPoint(ev);
    maybeSendCursor(nx, ny);
    if (!drawing || !last) return;
    const prev = last;
    last = { nx, ny };
    sendStroke(prev.nx, prev.ny, nx, ny);
  });

  canvas.addEventListener("pointerup", (ev) => {
    drawing = false;
    last = null;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* noop */
    }
  });

  canvas.addEventListener("pointerleave", () => {
    drawing = false;
    last = null;
  });

  saveNameBtn.addEventListener("click", () => {
    const name = nameInput.value.trim().slice(0, 24);
    localStorage.setItem("collabName", name);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "hello", name }));
    }
  });

  clearBtn.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (window.confirm("Clear the canvas for everyone?")) {
      ws.send(JSON.stringify({ type: "clear" }));
    }
  });

  connect();
})();
