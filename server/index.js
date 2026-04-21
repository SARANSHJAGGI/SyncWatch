import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// SPA fallback so links like /room/abc123 work on refresh (Render otherwise returns 404).
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/**
 * rooms: Map<roomId, Map<clientId, ws>>
 * clientMeta: WeakMap<ws, { roomId, clientId }>
 */
const rooms = new Map();
const clientMeta = new WeakMap();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  return room;
}

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(roomId, fromClientId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [clientId, ws] of room.entries()) {
    if (clientId === fromClientId) continue;
    safeSend(ws, msg);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get("room");
  const clientId = url.searchParams.get("id");

  if (!roomId || !clientId) {
    ws.close(1008, "Missing room or id");
    return;
  }

  const room = getRoom(roomId);
  room.set(clientId, ws);
  clientMeta.set(ws, { roomId, clientId });

  // Notify peers about join + current peer list
  safeSend(ws, { type: "peers", peers: [...room.keys()].filter((p) => p !== clientId) });
  broadcast(roomId, clientId, { type: "peer-joined", id: clientId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const meta = clientMeta.get(ws);
    if (!meta) return;

    // 1) WebRTC signaling messages are routed to a target peer.
    if (msg.type === "signal" && typeof msg.to === "string" && msg.payload) {
      const target = room.get(msg.to);
      if (target) safeSend(target, { type: "signal", from: meta.clientId, payload: msg.payload });
      return;
    }

    // 2) Sync / room messages broadcast to everyone else.
    if (msg.type === "sync") {
      broadcast(meta.roomId, meta.clientId, { ...msg, from: meta.clientId });
      return;
    }

    if (msg.type === "chat") {
      broadcast(meta.roomId, meta.clientId, { ...msg, from: meta.clientId });
      return;
    }

    if (msg.type === "ping" && typeof msg.t === "number") {
      safeSend(ws, { type: "pong", t: msg.t, s: Date.now() });
      return;
    }
  });

  ws.on("close", () => {
    const meta = clientMeta.get(ws);
    if (!meta) return;
    const { roomId: r, clientId: id } = meta;

    const roomNow = rooms.get(r);
    if (roomNow) {
      roomNow.delete(id);
      broadcast(r, id, { type: "peer-left", id });
      if (roomNow.size === 0) rooms.delete(r);
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`sync-watch listening on http://localhost:${PORT}`);
});

