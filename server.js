/* The Team Test — self-hosted server. No dependencies: needs only Node.js 18 or newer.
   Serves the game page and relays live "room" presence between players over WebSocket.
   No game logic runs here: each browser runs its own corner and shares its state, exactly as in the Claude version. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FRAME = 16 * 1024;        // largest message a browser may send
const MAX_PRESENCE = 8 * 1024;      // bytes of shared state per player per room
const MAX_ROOMS_PER_PLAYER = 16;
const ROOM_NAME = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(page);
  }
  if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
});

/* ---------- minimal WebSocket (RFC 6455) ---------- */
function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  return Buffer.concat([head, payload]);
}
function accept(req, socket, onOpen) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.url || '').split('?')[0] !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket') return socket.destroy();
  const hash = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + hash + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = {
    open: true, alive: true, handlers: {},
    send(text) { if (this.open) socket.write(frame(1, Buffer.from(text))); },
    ping() { if (this.open) socket.write(frame(9, Buffer.alloc(0))); },
    close() { if (!this.open) return; this.open = false; try { socket.end(frame(8, Buffer.alloc(0))); } catch {} this.handlers.close && this.handlers.close(); },
    on(ev, fn) { this.handlers[ev] = fn; },
  };
  let buf = Buffer.alloc(0), parts = [];
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return conn.close(); len = Number(big); off = 10; }
      if (!masked || len > MAX_FRAME) return conn.close();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return conn.close();
      if (op === 9) { socket.write(frame(10, data)); continue; }
      if (op === 10) { conn.alive = true; continue; }
      if (op === 1 || op === 0) {
        parts.push(data);
        if (parts.reduce((a, b) => a + b.length, 0) > MAX_FRAME) return conn.close();
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; conn.handlers.message && conn.handlers.message(text); }
      }
    }
  });
  socket.on('close', () => { if (conn.open) { conn.open = false; conn.handlers.close && conn.handlers.close(); } });
  socket.on('error', () => socket.destroy());
  onOpen(conn);
}

/* ---------- rooms ---------- */
const rooms = new Map();    // room name -> Map(peerId -> { conn, presence })
const players = new Map();  // peerId -> { conn, rooms: Set }
const conns = new Set();
const dirty = new Set();

// Send each changed room's full player list at most 20 times a second.
setInterval(() => {
  for (const name of dirty) {
    const room = rooms.get(name);
    if (!room) continue;
    const msg = JSON.stringify({ op: 'peers', room: name, peers: [...room].map(([peer, v]) => ({ peer, presence: v.presence })) });
    for (const [, v] of room) v.conn.send(msg);
  }
  dirty.clear();
}, 50);

function leave(id, name) {
  const room = rooms.get(name);
  if (room) { room.delete(id); if (room.size) dirty.add(name); else rooms.delete(name); }
  const p = players.get(id); if (p) p.rooms.delete(name);
}

server.on('upgrade', (req, socket) => accept(req, socket, conn => {
  let id = null;
  conns.add(conn);
  conn.on('message', text => {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.op === 'hello' && !id) {
      // a reconnecting player gets their old id back if it is free, so they keep their seat
      id = (typeof m.want === 'string' && /^[a-f0-9]{16}$/.test(m.want) && !players.has(m.want)) ? m.want : crypto.randomBytes(8).toString('hex');
      players.set(id, { conn, rooms: new Set() });
      return conn.send(JSON.stringify({ op: 'hello', you: id }));
    }
    if (!id) return;
    const p = players.get(id); const name = m.room;
    if (typeof name !== 'string' || !(name === 'lobby' || ROOM_NAME.test(name))) return;
    if (m.op === 'join') {
      if (!p.rooms.has(name) && p.rooms.size >= MAX_ROOMS_PER_PLAYER) return;
      if (!rooms.has(name)) rooms.set(name, new Map());
      const room = rooms.get(name);
      if (!room.has(id)) room.set(id, { conn, presence: {} });
      p.rooms.add(name); dirty.add(name);
    } else if (m.op === 'leave') {
      leave(id, name);
    } else if (m.op === 'presence') {
      const entry = rooms.get(name)?.get(id);
      if (!entry || !m.patch || typeof m.patch !== 'object' || Array.isArray(m.patch)) return;
      const next = { ...entry.presence };
      for (const k of Object.keys(m.patch)) {
        if (BAD_KEYS.has(k)) continue;
        if (m.patch[k] === null) delete next[k]; else next[k] = m.patch[k];
      }
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_PRESENCE) return;
      entry.presence = next; dirty.add(name);
    }
  });
  conn.on('close', () => {
    conns.delete(conn);
    if (!id) return;
    const p = players.get(id);
    if (p && p.conn === conn) { for (const n of [...p.rooms]) leave(id, n); players.delete(id); }
  });
}));

// drop connections that stopped answering
setInterval(() => {
  for (const c of conns) { if (!c.alive) { c.close(); continue; } c.alive = false; c.ping(); }
}, 15000);

server.listen(PORT, HOST, () => console.log(`The Team Test is running on http://localhost:${PORT}`));
