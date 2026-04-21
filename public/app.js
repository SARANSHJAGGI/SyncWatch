const els = {
  roomId: document.querySelector("#roomId"),
  createRoom: document.querySelector("#createRoom"),
  joinRoom: document.querySelector("#joinRoom"),
  status: document.querySelector("#status"),
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  fileSig: document.querySelector("#fileSig"),
  video: document.querySelector("#video"),
  becomeController: document.querySelector("#becomeController"),
  controller: document.querySelector("#controller"),
  micToggle: document.querySelector("#micToggle"),
  pushToTalk: document.querySelector("#pushToTalk"),
  voiceState: document.querySelector("#voiceState"),
  peers: document.querySelector("#peers"),
  chatLog: document.querySelector("#chatLog"),
  chatInput: document.querySelector("#chatInput"),
  chatSend: document.querySelector("#chatSend"),
};

const clientId = crypto.randomUUID();
let ws = null;
let roomId = null;

let controllerId = null;
let weAreController = false;

let fileSignature = null;
let localObjectUrl = null;

// WebRTC voice
let micStream = null;
let audioSenderTrack = null;
const pcs = new Map(); // peerId -> RTCPeerConnection

// Sync helpers
let suppressVideoEvents = false;
let lastSentSyncAt = 0;
let rttMs = 0;

function setStatus(text, kind = "muted") {
  els.status.textContent = text;
  els.status.style.color =
    kind === "good" ? "var(--good)" : kind === "bad" ? "var(--bad)" : kind === "warn" ? "var(--warn)" : "var(--muted)";
}

function setPill(el, text, tone = "muted") {
  el.textContent = text;
  el.classList.remove("pillMuted");
  if (tone === "muted") el.classList.add("pillMuted");
  el.style.color = tone === "good" ? "var(--good)" : tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "";
}

function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function addMsg(meta, text) {
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<div class="meta">${escapeHtml(meta)}</div><div>${escapeHtml(text)}</div>`;
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ensureRoomId() {
  const v = (els.roomId.value || "").trim();
  if (!v) return null;
  return v.replace(/\s+/g, "-").slice(0, 64);
}

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function roomFromUrl() {
  const params = new URLSearchParams(location.search);
  const q = (params.get("room") || "").trim();
  if (q) return q;
  const p = location.pathname.replace(/^\/+/, "").trim();
  if (!p) return null;
  // allow /abc123 or /room/abc123
  const parts = p.split("/").filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length >= 2 && parts[0].toLowerCase() === "room") return parts[1];
  return null;
}

function setRoomInUrl(room) {
  const url = new URL(location.href);
  url.pathname = `/room/${encodeURIComponent(room)}`;
  url.searchParams.delete("room");
  history.replaceState(null, "", url.toString());
}

async function connect(room) {
  roomId = room;
  els.roomId.value = roomId;
  setRoomInUrl(roomId);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ws?room=${encodeURIComponent(roomId)}&id=${encodeURIComponent(clientId)}`;

  ws?.close();
  ws = new WebSocket(wsUrl);
  setStatus("Connecting…");

  ws.addEventListener("open", () => {
    setStatus(`Connected • room ${roomId}`, "good");
    addMsg("system", `You joined room ${roomId}`);
    // elect controller if empty/unknown: first person who clicks "Take controls" becomes controller
    if (!controllerId) {
      controllerId = null;
      updateControllerUI();
    }
    startPingLoop();
  });

  ws.addEventListener("close", () => {
    setStatus("Disconnected", "warn");
    els.peers.textContent = "Peers: 0";
  });

  ws.addEventListener("message", async (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.type === "peers") {
      els.peers.textContent = `Peers: ${msg.peers.length}`;
      // create peer connections for existing peers (voice)
      for (const peerId of msg.peers) await ensurePeerConnection(peerId, true);
      return;
    }

    if (msg.type === "peer-joined") {
      addMsg("system", `${msg.id} joined`);
      bumpPeers(+1);
      await ensurePeerConnection(msg.id, true);
      return;
    }

    if (msg.type === "peer-left") {
      addMsg("system", `${msg.id} left`);
      bumpPeers(-1);
      closePeer(msg.id);
      if (controllerId === msg.id) {
        controllerId = null;
        weAreController = false;
        updateControllerUI();
      }
      return;
    }

    if (msg.type === "pong") {
      const now = performance.now();
      const sent = pendingPings.get(msg.t);
      if (sent) {
        pendingPings.delete(msg.t);
        rttMs = Math.round(now - sent);
      }
      return;
    }

    if (msg.type === "chat") {
      addMsg(msg.from ?? "peer", msg.text ?? "");
      return;
    }

    if (msg.type === "signal") {
      await onSignal(msg.from, msg.payload);
      return;
    }

    if (msg.type === "sync") {
      onSync(msg);
      return;
    }
  });
}

function bumpPeers(delta) {
  const m = /Peers:\s*(\d+)/.exec(els.peers.textContent);
  const cur = m ? Number(m[1]) : 0;
  els.peers.textContent = `Peers: ${Math.max(0, cur + delta)}`;
}

function updateControllerUI() {
  if (weAreController) {
    els.controller.textContent = `Controller: you`;
    setPill(els.fileSig, fileSignature ? `File selected • ${fileSignature.short}` : "No file selected", fileSignature ? "good" : "muted");
  } else {
    els.controller.textContent = `Controller: ${controllerId ? controllerId : "none"}`;
  }
}

els.createRoom.addEventListener("click", () => {
  const id = randomRoomId();
  els.roomId.value = id;
  connect(id);
});

els.joinRoom.addEventListener("click", () => {
  const id = ensureRoomId();
  if (!id) return setStatus("Enter a room id", "warn");
  connect(id);
});

// ---- file selection (never uploaded) ----
els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("dragover");
});
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("dragover");
  const f = e.dataTransfer.files?.[0];
  if (f) onFilePicked(f);
});
els.fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) onFilePicked(f);
});

async function onFilePicked(file) {
  if (!file.type.startsWith("video/")) {
    setPill(els.fileSig, "Not a video file", "bad");
    return;
  }

  if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
  localObjectUrl = URL.createObjectURL(file);
  els.video.src = localObjectUrl;
  els.video.load();

  setPill(els.fileSig, "Computing file signature…", "muted");
  fileSignature = await computeSignature(file);
  setPill(els.fileSig, `Local file • ${fileSignature.short}`, "good");

  // Share signature so both can verify they picked the same file.
  wsSend({
    type: "sync",
    kind: "file",
    sig: fileSignature.sig,
    short: fileSignature.short,
    name: file.name,
    size: file.size,
    t: Date.now(),
  });
}

async function computeSignature(file) {
  // Quick signature: sha256(size || first 1MB || last 1MB)
  const chunk = 1024 * 1024;
  const first = await file.slice(0, Math.min(chunk, file.size)).arrayBuffer();
  const last = await file.slice(Math.max(0, file.size - chunk), file.size).arrayBuffer();

  const sizeBytes = new Uint8Array(new BigUint64Array([BigInt(file.size)]).buffer);
  const combined = new Uint8Array(sizeBytes.byteLength + first.byteLength + last.byteLength);
  combined.set(sizeBytes, 0);
  combined.set(new Uint8Array(first), sizeBytes.byteLength);
  combined.set(new Uint8Array(last), sizeBytes.byteLength + first.byteLength);

  const hash = await crypto.subtle.digest("SHA-256", combined);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { sig: hex, short: `${hex.slice(0, 6)}…${hex.slice(-6)}` };
}

// ---- controller / sync ----
els.becomeController.addEventListener("click", () => {
  controllerId = clientId;
  weAreController = true;
  updateControllerUI();
  wsSend({ type: "sync", kind: "controller", id: clientId, t: Date.now() });
  addMsg("system", "You are now controlling playback");
});

function canEmitControl() {
  return weAreController;
}

function emitSync(kind, extra = {}) {
  if (!canEmitControl()) return;
  const now = Date.now();
  // throttle extremely spammy events
  if (now - lastSentSyncAt < 120 && kind === "timeupdate") return;
  lastSentSyncAt = now;

  wsSend({
    type: "sync",
    kind,
    at: els.video.currentTime,
    paused: els.video.paused,
    rate: els.video.playbackRate,
    t: now,
    rttMs,
    ...extra,
  });
}

els.video.addEventListener("play", () => emitSync("play"));
els.video.addEventListener("pause", () => emitSync("pause"));
els.video.addEventListener("seeking", () => emitSync("seek"));
els.video.addEventListener("ratechange", () => emitSync("rate"));
els.video.addEventListener("timeupdate", () => emitSync("timeupdate"));

function onSync(msg) {
  if (msg.kind === "controller") {
    controllerId = msg.id;
    weAreController = controllerId === clientId;
    updateControllerUI();
    addMsg("system", `${weAreController ? "You" : controllerId} is controlling playback`);
    return;
  }

  if (msg.kind === "file") {
    if (!fileSignature) {
      setPill(els.fileSig, `Peer picked ${msg.short} • pick yours`, "warn");
      addMsg("system", `Peer picked a file signature ${msg.short}. Pick the same local file on your computer.`);
      return;
    }
    const same = msg.sig === fileSignature.sig;
    setPill(els.fileSig, same ? `File match • ${fileSignature.short}` : `File mismatch • yours ${fileSignature.short}`, same ? "good" : "bad");
    if (!same) addMsg("system", "Your file does NOT match the peer's signature. Pick the exact same file.");
    return;
  }

  // Ignore if we are controller (avoid fighting). If you want shared control later, we can change this.
  if (weAreController) return;

  if (msg.kind === "play" || msg.kind === "pause" || msg.kind === "seek" || msg.kind === "rate" || msg.kind === "timeupdate") {
    const sentAt = msg.t || Date.now();
    const ageMs = Date.now() - sentAt;
    const estimatedNetworkSec = Math.max(0, ageMs / 1000);
    const targetTime = typeof msg.at === "number" ? msg.at + (msg.kind === "play" ? estimatedNetworkSec : 0) : null;

    suppressVideoEvents = true;
    try {
      if (typeof msg.rate === "number" && els.video.playbackRate !== msg.rate) els.video.playbackRate = msg.rate;
      if (targetTime != null && Number.isFinite(targetTime)) {
        const drift = Math.abs(els.video.currentTime - targetTime);
        if (drift > 0.25 || msg.kind === "seek") els.video.currentTime = targetTime;
      }
      if (msg.kind === "play" && els.video.paused) void els.video.play().catch(() => {});
      if (msg.kind === "pause" && !els.video.paused) els.video.pause();
    } finally {
      setTimeout(() => {
        suppressVideoEvents = false;
      }, 0);
    }
  }
}

// prevent loops if browser fires events during sync apply
["play", "pause", "seeking", "ratechange", "timeupdate"].forEach((ev) => {
  els.video.addEventListener(
    ev,
    (e) => {
      if (suppressVideoEvents) e.stopImmediatePropagation();
    },
    true
  );
});

// ---- chat ----
function sendChat() {
  const text = (els.chatInput.value || "").trim();
  if (!text) return;
  els.chatInput.value = "";
  addMsg("you", text);
  wsSend({ type: "chat", text });
}
els.chatSend.addEventListener("click", sendChat);
els.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

// ---- basic ping/rtt ----
const pendingPings = new Map(); // t -> perfNow
let pingTimer = null;
function startPingLoop() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const t = Math.floor(Math.random() * 1e9);
    pendingPings.set(t, performance.now());
    wsSend({ type: "ping", t });
    // cleanup old
    setTimeout(() => pendingPings.delete(t), 8000);
  }, 3000);
}

// ---- WebRTC voice ----
const rtcConfig = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

async function ensurePeerConnection(peerId, polite) {
  if (pcs.has(peerId)) return pcs.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);
  pcs.set(peerId, pc);

  // Remote audio
  pc.addEventListener("track", (ev) => {
    const [stream] = ev.streams;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    audio.volume = 1;
    audio.dataset.peer = peerId;
    document.body.appendChild(audio);
  });

  pc.addEventListener("icecandidate", (ev) => {
    if (!ev.candidate) return;
    wsSend({ type: "signal", to: peerId, payload: { type: "ice", candidate: ev.candidate } });
  });

  // Add local track if mic already enabled
  if (audioSenderTrack) {
    pc.addTrack(audioSenderTrack, micStream);
  }

  // Perfect negotiation (simplified)
  let makingOffer = false;
  let ignoreOffer = false;

  pc.addEventListener("negotiationneeded", async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      wsSend({ type: "signal", to: peerId, payload: { type: "sdp", description: pc.localDescription } });
    } catch {
      // ignore
    } finally {
      makingOffer = false;
    }
  });

  pc.__sw = { polite, get makingOffer() { return makingOffer; }, set ignoreOffer(v) { ignoreOffer = v; }, get ignoreOffer() { return ignoreOffer; } };
  return pc;
}

async function onSignal(from, payload) {
  const pc = await ensurePeerConnection(from, false);
  const state = pc.__sw;

  if (payload.type === "sdp") {
    const description = payload.description;
    const offerCollision = description.type === "offer" && (state.makingOffer || pc.signalingState !== "stable");
    state.ignoreOffer = !state.polite && offerCollision;
    if (state.ignoreOffer) return;

    await pc.setRemoteDescription(description);
    if (description.type === "offer") {
      await pc.setLocalDescription();
      wsSend({ type: "signal", to: from, payload: { type: "sdp", description: pc.localDescription } });
    }
    return;
  }

  if (payload.type === "ice" && payload.candidate) {
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch {
      if (!state.ignoreOffer) throw new Error("Failed to add ICE candidate");
    }
  }
}

async function enableMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const track = micStream.getAudioTracks()[0];
  audioSenderTrack = track;

  // Push-to-talk support
  if (els.pushToTalk.checked) track.enabled = false;

  for (const pc of pcs.values()) {
    try {
      pc.addTrack(track, micStream);
    } catch {
      // ignore
    }
  }

  setPill(els.voiceState, "Mic on", "good");
  els.micToggle.textContent = "Disable mic";
}

function disableMic() {
  if (!micStream) return;
  for (const t of micStream.getTracks()) t.stop();
  micStream = null;
  audioSenderTrack = null;
  setPill(els.voiceState, "Mic off", "muted");
  els.micToggle.textContent = "Enable mic";
}

els.micToggle.addEventListener("click", async () => {
  try {
    if (micStream) disableMic();
    else await enableMic();
  } catch (e) {
    setPill(els.voiceState, "Mic blocked", "bad");
    addMsg("system", "Mic permission was blocked. Allow microphone access in the browser and try again.");
  }
});

els.pushToTalk.addEventListener("change", () => {
  if (!micStream) return;
  const track = micStream.getAudioTracks()[0];
  track.enabled = !els.pushToTalk.checked;
});

window.addEventListener("keydown", (e) => {
  if (!els.pushToTalk.checked) return;
  if (!micStream) return;
  if (e.code === "Space") {
    const track = micStream.getAudioTracks()[0];
    track.enabled = true;
  }
});
window.addEventListener("keyup", (e) => {
  if (!els.pushToTalk.checked) return;
  if (!micStream) return;
  if (e.code === "Space") {
    const track = micStream.getAudioTracks()[0];
    track.enabled = false;
  }
});

function closePeer(peerId) {
  const pc = pcs.get(peerId);
  if (!pc) return;
  pcs.delete(peerId);
  try {
    pc.close();
  } catch {
    // ignore
  }
  // remove remote audio element(s)
  for (const a of [...document.querySelectorAll(`audio[data-peer="${CSS.escape(peerId)}"]`)]) a.remove();
}

// UX: if not connected, disable sync expectation
setStatus("Not connected");
updateControllerUI();

// Auto-join if opened via share link like /room/<id> or ?room=<id>
const initialRoom = roomFromUrl();
if (initialRoom) connect(initialRoom);

