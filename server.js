const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const port = Number(process.env.PORT) || 8080;
const rooms = new Map();

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

const webSocketServer = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 8 * 1024 * 1024
});

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function boundedNumber(value, fallback = 0, min = -9999, max = 9999) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function sanitizeCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const image = typeof card.image === 'string' ? card.image.slice(0, 700000) : '';
  const safeImage = card.isFaceDown
    ? 'https://cards.scryfall.io/back.png'
    : (/^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(image) ? image : '');
  const counters = {};
  if (card.counters && typeof card.counters === 'object' && !Array.isArray(card.counters)) {
    for (const [key, value] of Object.entries(card.counters).slice(0, 20)) {
      if (typeof value === 'number' || typeof value === 'string') {
        counters[String(key).slice(0, 40)] = typeof value === 'string' ? value.slice(0, 40) : boundedNumber(value);
      }
    }
  }
  return {
    id: typeof card.id === 'string' ? card.id.slice(0, 64) : '',
    name: card.isFaceDown ? 'Carte face cachée' : (typeof card.name === 'string' ? card.name.slice(0, 100) : 'Carte'),
    image: safeImage,
    counters,
    tapped: !!card.tapped,
    isToken: !!card.isToken,
    isFaceDown: !!card.isFaceDown,
    x: boundedNumber(card.x, 20, 0, 10000),
    y: boundedNumber(card.y, 20, 0, 10000)
  };
}

function sanitizeCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.slice(0, 300).map(sanitizeCard).filter(Boolean);
}

function sanitizePublicState(state) {
  return {
    handCount: boundedNumber(state.handCount, 0, 0, 1000),
    libraryCount: boundedNumber(state.libraryCount, 0, 0, 1000),
    life: boundedNumber(state.life),
    commanderDamage: boundedNumber(state.commanderDamage),
    poison: boundedNumber(state.poison),
    battlefield: sanitizeCards(state.battlefield),
    graveyard: sanitizeCards(state.graveyard),
    exile: sanitizeCards(state.exile),
    commandZone: sanitizeCards(state.commandZone)
  };
}

function removeFromRoom(socket) {
  if (!socket.room) return;
  const room = rooms.get(socket.room);
  socket.room = null;
  if (!room) return;
  room.delete(socket);
  for (const peer of room) send(peer, { type: 'peer-left' });
  if (room.size === 0) rooms.delete(room.code);
}

webSocketServer.on('connection', socket => {
  socket.on('message', data => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      send(socket, { type: 'error', message: 'Message JSON invalide.' });
      return;
    }

    if (message.type === 'join') {
      if (socket.room) {
        send(socket, { type: 'error', message: 'Vous avez déjà rejoint une salle.' });
        return;
      }
      const roomCode = typeof message.room === 'string' ? message.room.trim() : '';
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(roomCode)) {
        send(socket, { type: 'error', message: 'Code de salle invalide.' });
        return;
      }
      let room = rooms.get(roomCode);
      if (!room) {
        room = new Set();
        room.code = roomCode;
        rooms.set(roomCode, room);
      }
      if (room.size >= 2) {
        send(socket, { type: 'error', message: 'Cette salle est déjà complète.' });
        return;
      }
      socket.room = roomCode;
      socket.playerName = typeof message.name === 'string' ? message.name.trim().slice(0, 32) || 'Joueur' : 'Joueur';
      room.add(socket);
      send(socket, { type: 'joined', playerCount: room.size });
      if (room.size === 2) {
        for (const peer of room) {
          if (peer !== socket) send(peer, { type: 'peer-joined' });
        }
      }
      return;
    }

    if (message.type === 'state') {
      if (!socket.room || !message.state || typeof message.state !== 'object' || Array.isArray(message.state)) {
        send(socket, { type: 'error', message: 'État de partie invalide.' });
        return;
      }
      const room = rooms.get(socket.room);
      if (!room) return;
      const update = JSON.stringify({ type: 'state', name: socket.playerName, state: sanitizePublicState(message.state) });
      for (const peer of room) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(update);
      }
    }
  });

  socket.on('close', () => removeFromRoom(socket));
  socket.on('error', () => removeFromRoom(socket));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Relais WebSocket MTG prêt sur le port ${port} (/ws)`);
});

function shutdown() {
  webSocketServer.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
