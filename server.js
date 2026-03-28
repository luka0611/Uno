/**
 * BLAZE CARDS - Servidor Node.js puro + ws
 * Toda a lógica do jogo fica aqui (estado autoritativo no servidor).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};
const RECONNECT_TIMEOUT_MS = 30000;
const COUNTDOWN_SECONDS = 3;
const TURN_LIMIT_SECONDS = 20;

const rooms = new Map();
const sockets = new Map();

// =========================
// Utilitários gerais
// =========================
function createRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function now() {
  return new Date().toISOString();
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function colorFromNickname(nickname) {
  const palette = ['#ff4d6d', '#4dabf7', '#51cf66', '#ffd43b', '#b197fc', '#ff922b'];
  let sum = 0;
  for (const char of nickname) sum += char.charCodeAt(0);
  return palette[sum % palette.length];
}

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

function createDefaultSettings() {
  return {
    maxPlayers: 8,
    minPlayers: 2,
    targetPoints: 500,
    bestOfRounds: 0,
    stackDraw: true,
    forceDrawUntilPlayable: false,
    sevenZero: true,
    drawAndPassOnly: false,
    strictUno: true,
    noMercyPlus4: true,
    extraSpecialCards: true,
    fastRound: false,
    inverseScoring: false,
  };
}

function createCard({ color = 'wild', type = 'number', value = null, label = '' }) {
  return {
    id: uuidv4(),
    color,
    type,
    value,
    label,
  };
}

function buildDeck(settings) {
  const deck = [];
  const colors = ['red', 'blue', 'green', 'yellow'];
  const specialsBase = ['skip', 'reverse', 'draw2'];
  const specialsExtra = ['hand_swap', 'peek', 'force_discard'];

  colors.forEach((color) => {
    deck.push(createCard({ color, type: 'number', value: 0, label: '0' }));
    for (let i = 1; i <= 9; i += 1) {
      deck.push(createCard({ color, type: 'number', value: i, label: String(i) }));
      deck.push(createCard({ color, type: 'number', value: i, label: String(i) }));
    }

    const specials = settings.extraSpecialCards ? [...specialsBase, ...specialsExtra] : specialsBase;
    specials.forEach((type) => {
      deck.push(createCard({ color, type, label: type }));
      deck.push(createCard({ color, type, label: type }));
    });
  });

  const wilds = ['wild', 'wild_draw4', 'wild_swap_all', 'wild_bonus', 'wild_blase'];
  wilds.forEach((type) => {
    for (let i = 0; i < 4; i += 1) {
      deck.push(createCard({ color: 'wild', type, label: type }));
    }
  });

  return shuffleDeck(deck);
}

function sanitizePlayerForRoomList(player, room) {
  return {
    id: player.id,
    nickname: player.nickname,
    isHost: player.id === room.hostId,
    online: player.online,
    handCount: player.hand.length,
    score: player.score,
    unoSafe: player.unoSafe,
    avatarColor: player.avatarColor,
  };
}

function sendToPlayer(playerId, data) {
  const ws = sockets.get(playerId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(roomCode, data) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.forEach((player) => sendToPlayer(player.id, data));
}

function getOrderedActivePlayers(room) {
  return room.players.filter((p) => p.active);
}

function getNextPlayer(room, steps = 1) {
  const active = getOrderedActivePlayers(room);
  if (!active.length) return null;
  const currentIdx = active.findIndex((p) => p.id === room.currentPlayerId);
  if (currentIdx === -1) return active[0];
  const dir = room.direction;
  const idx = (currentIdx + (steps * dir) + active.length * 1000) % active.length;
  return active[idx];
}

function dealCards(room) {
  room.players.forEach((player) => {
    player.hand = [];
    player.calledUno = false;
    player.unoSafe = false;
  });

  for (let i = 0; i < 7; i += 1) {
    room.players.forEach((player) => {
      const card = room.drawPile.pop();
      if (card) player.hand.push(card);
    });
  }

  let first = room.drawPile.pop();
  while (first && first.color === 'wild') {
    room.drawPile.unshift(first);
    shuffleDeck(room.drawPile);
    first = room.drawPile.pop();
  }
  room.discardPile = [first];
  room.currentColor = first?.color || 'red';
}

function drawFromPile(room, count) {
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    if (!room.drawPile.length) {
      const top = room.discardPile.pop();
      room.drawPile = shuffleDeck(room.discardPile.splice(0));
      room.discardPile = top ? [top] : [];
    }
    const card = room.drawPile.pop();
    if (card) cards.push(card);
  }
  return cards;
}

function isCardPlayable(room, card, player) {
  if (!card) return false;
  if (room.pendingDraw > 0) {
    if (!room.settings.stackDraw) return false;
    if (room.pendingDrawType === 'draw2' && card.type === 'draw2') return true;
    if (room.pendingDrawType === 'wild_draw4' && card.type === 'wild_draw4') return true;
    return false;
  }

  const top = room.discardPile[room.discardPile.length - 1];
  if (!top) return true;
  if (card.color === 'wild') return true;
  if (card.color === room.currentColor) return true;
  if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
  if (card.type !== 'number' && top.type === card.type) return true;

  if (room.settings.sevenZero && card.type === 'number' && (card.value === 7 || card.value === 0)) {
    return card.color === room.currentColor || (top.type === 'number' && top.value === card.value);
  }

  // Regra opcional +4 (sem challenge): qualquer momento.
  if (card.type === 'wild_draw4' && room.settings.noMercyPlus4) return true;

  return false;
}

function cardScore(card) {
  if (!card) return 0;
  if (card.type === 'number') return card.value;
  if (['skip', 'reverse', 'draw2'].includes(card.type)) return 20;
  if (['hand_swap', 'peek', 'force_discard'].includes(card.type)) return 30;
  if (['wild', 'wild_draw4', 'wild_swap_all', 'wild_bonus', 'wild_blase'].includes(card.type)) return 50;
  return 0;
}

function calculateScore(hand) {
  return hand.reduce((acc, card) => acc + cardScore(card), 0);
}

function playerById(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function announceTurn(room) {
  clearTimeout(room.turnTimer);
  clearInterval(room.tickTimer);
  if (room.state !== 'playing') return;

  const limit = room.settings.fastRound ? TURN_LIMIT_SECONDS : null;
  if (limit) {
    room.turnRemaining = limit;
    room.tickTimer = setInterval(() => {
      room.turnRemaining -= 1;
      broadcast(room.code, {
        type: 'turn_changed',
        currentPlayer: room.currentPlayerId,
        timeLimit: room.turnRemaining,
      });
      if (room.turnRemaining <= 0) {
        clearInterval(room.tickTimer);
      }
    }, 1000);

    room.turnTimer = setTimeout(() => {
      const current = playerById(room, room.currentPlayerId);
      if (!current) return;
      handleDrawCard(room, current, true);
    }, TURN_LIMIT_SECONDS * 1000);
  }

  broadcast(room.code, {
    type: 'turn_changed',
    currentPlayer: room.currentPlayerId,
    timeLimit: limit,
  });
}

function checkUno(room, justPlayedPlayer) {
  room.players.forEach((p) => {
    if (p.hand.length === 1 && !p.calledUno && room.settings.strictUno) {
      const penalized = drawFromPile(room, 2);
      p.hand.push(...penalized);
      p.unoSafe = false;
      broadcast(room.code, { type: 'uno_penalty', playerId: p.id, cards: penalized.length });
    }
    p.calledUno = false;
  });
  if (justPlayedPlayer && justPlayedPlayer.hand.length === 1) {
    justPlayedPlayer.unoSafe = true;
  }
}

function rotateHands(room) {
  const active = getOrderedActivePlayers(room);
  if (active.length < 2) return;
  const snapshot = active.map((p) => p.hand);
  active.forEach((p, idx) => {
    const nextIdx = (idx + 1) % active.length;
    p.hand = snapshot[nextIdx];
  });
}

function applyCardEffect(room, card, currentPlayer, targetId = null) {
  let stepAdvance = 1;
  let log = '';

  const nextPlayer = getNextPlayer(room, 1);
  switch (card.type) {
    case 'skip':
      stepAdvance = 2;
      log = `${currentPlayer.nickname} pulou o próximo jogador.`;
      break;
    case 'reverse':
      room.direction *= -1;
      if (room.players.filter((p) => p.active).length === 2) stepAdvance = 2;
      log = `${currentPlayer.nickname} inverteu a direção.`;
      break;
    case 'draw2':
      room.pendingDraw += 2;
      room.pendingDrawType = 'draw2';
      log = `${currentPlayer.nickname} lançou +2.`;
      break;
    case 'wild_draw4':
      room.pendingDraw += 4;
      room.pendingDrawType = 'wild_draw4';
      log = `${currentPlayer.nickname} lançou +4!`;
      break;
    case 'hand_swap': {
      const target = playerById(room, targetId);
      if (target && target.id !== currentPlayer.id) {
        [currentPlayer.hand, target.hand] = [target.hand, currentPlayer.hand];
        log = `${currentPlayer.nickname} trocou de mão com ${target.nickname}.`;
      }
      break;
    }
    case 'peek': {
      const target = playerById(room, targetId);
      if (target && target.id !== currentPlayer.id) {
        sendToPlayer(currentPlayer.id, { type: 'peek_result', targetId: target.id, cards: target.hand });
        log = `${currentPlayer.nickname} espiou ${target.nickname}.`;
      }
      break;
    }
    case 'force_discard': {
      const target = playerById(room, targetId);
      if (target && target.hand.length) {
        const idx = Math.floor(Math.random() * target.hand.length);
        const [removed] = target.hand.splice(idx, 1);
        room.discardPile.push(removed);
        room.currentColor = removed.color === 'wild' ? room.currentColor : removed.color;
        log = `${currentPlayer.nickname} forçou descarte de ${target.nickname}.`;
      }
      break;
    }
    case 'wild_swap_all':
      rotateHands(room);
      log = `${currentPlayer.nickname} fez todos trocarem de mão.`;
      break;
    case 'wild_bonus': {
      const c = drawFromPile(room, 1);
      currentPlayer.hand.push(...c);
      stepAdvance = 0;
      log = `${currentPlayer.nickname} comprou bônus e joga de novo.`;
      break;
    }
    case 'wild_blase':
      room.players.forEach((p) => {
        const c = drawFromPile(room, 1);
        p.hand.push(...c);
      });
      log = `${currentPlayer.nickname} fez todos comprarem 1.`;
      break;
    default:
      break;
  }

  if (room.settings.sevenZero && card.type === 'number') {
    if (card.value === 7) {
      const target = playerById(room, targetId);
      if (target && target.id !== currentPlayer.id) {
        [currentPlayer.hand, target.hand] = [target.hand, currentPlayer.hand];
        log = `${currentPlayer.nickname} ativou 7 e trocou com ${target.nickname}.`;
      }
    }
    if (card.value === 0) {
      rotateHands(room);
      log = `${currentPlayer.nickname} ativou 0 e girou mãos.`;
    }
  }

  if (log) {
    room.logs.push({ at: now(), message: log });
    if (room.logs.length > 40) room.logs.shift();
  }

  return stepAdvance;
}

function startCountdown(room, seconds) {
  room.state = 'countdown';
  let sec = seconds;
  broadcast(room.code, { type: 'countdown', seconds: sec });
  const timer = setInterval(() => {
    sec -= 1;
    broadcast(room.code, { type: 'countdown', seconds: sec });
    if (sec <= 0) {
      clearInterval(timer);
      startGame(room);
    }
  }, 1000);
}

function resetRound(room) {
  room.drawPile = buildDeck(room.settings);
  room.discardPile = [];
  room.direction = 1;
  room.pendingDraw = 0;
  room.pendingDrawType = null;
  room.logs = [];
  dealCards(room);
  room.currentPlayerId = room.players[room.roundStarterIndex % room.players.length].id;
  room.roundStarterIndex = (room.roundStarterIndex + 1) % room.players.length;
}

function startGame(room) {
  room.state = 'playing';
  resetRound(room);
  room.players.forEach((p) => {
    sendToPlayer(p.id, {
      type: 'game_started',
      hand: p.hand,
      topCard: room.discardPile[room.discardPile.length - 1],
      currentPlayer: room.currentPlayerId,
      direction: room.direction,
      settings: room.settings,
    });
  });
  announceTurn(room);
}

function endGame(room) {
  room.state = 'ended';
  clearTimeout(room.turnTimer);
  clearInterval(room.tickTimer);
  const ranking = [...room.players].sort((a, b) => (room.settings.inverseScoring ? a.score - b.score : b.score - a.score));
  broadcast(room.code, {
    type: 'game_ended',
    winner: ranking[0],
    finalScores: ranking.map((p) => ({ playerId: p.id, nickname: p.nickname, score: p.score })),
  });
}

function endRound(room, winner) {
  const roundScores = [];
  room.players.forEach((p) => {
    if (p.id === winner.id) return;
    const points = calculateScore(p.hand);
    winner.score += room.settings.inverseScoring ? 0 : points;
    p.score += room.settings.inverseScoring ? points : 0;
    roundScores.push({ playerId: p.id, nickname: p.nickname, points, hand: p.hand });
  });

  broadcast(room.code, {
    type: 'round_ended',
    winner: { id: winner.id, nickname: winner.nickname },
    scores: room.players.map((p) => ({ playerId: p.id, nickname: p.nickname, score: p.score })),
    hands: roundScores,
  });

  const reachedTarget = room.settings.inverseScoring
    ? room.players.some((p) => p.score >= room.settings.targetPoints)
    : room.players.some((p) => p.score >= room.settings.targetPoints);
  const roundsDone = room.roundsPlayed >= room.settings.bestOfRounds && room.settings.bestOfRounds > 0;
  room.roundsPlayed += 1;

  if (reachedTarget || roundsDone) {
    endGame(room);
  } else {
    setTimeout(() => {
      if (room.state === 'ended') return;
      startCountdown(room, 10);
    }, 1200);
  }
}

function roomStateFor(player, room) {
  return {
    roomCode: room.code,
    state: room.state,
    players: room.players.map((p) => sanitizePlayerForRoomList(p, room)),
    settings: room.settings,
    hostId: room.hostId,
    currentPlayer: room.currentPlayerId,
    direction: room.direction,
    topCard: room.discardPile[room.discardPile.length - 1] || null,
    currentColor: room.currentColor,
    drawPileCount: room.drawPile.length,
    pendingDraw: room.pendingDraw,
    logs: room.logs,
    hand: player.hand,
    chat: room.chat.slice(-70),
    roundsPlayed: room.roundsPlayed,
  };
}

function handleDrawCard(room, player, fromTimeout = false) {
  if (room.currentPlayerId !== player.id) return;

  let count = room.pendingDraw > 0 ? room.pendingDraw : 1;
  if (room.pendingDraw > 0) {
    room.pendingDraw = 0;
    room.pendingDrawType = null;
  } else if (room.settings.forceDrawUntilPlayable) {
    count = 0;
    while (true) {
      const c = drawFromPile(room, 1);
      if (!c.length) break;
      player.hand.push(c[0]);
      count += 1;
      if (isCardPlayable(room, c[0], player)) break;
      if (count > 25) break;
    }
  }

  if (!room.settings.forceDrawUntilPlayable) {
    const cards = drawFromPile(room, count);
    player.hand.push(...cards);
    sendToPlayer(player.id, { type: 'drawn_cards', cards });
  } else {
    sendToPlayer(player.id, { type: 'drawn_cards', cards: player.hand.slice(-count) });
  }

  broadcast(room.code, { type: 'card_drawn', playerId: player.id, count });

  if (room.settings.drawAndPassOnly || fromTimeout) {
    room.currentPlayerId = getNextPlayer(room, 1).id;
    announceTurn(room);
  }
}

function validateTargetIfNeeded(card, targetPlayerId, room, player) {
  const needTarget = ['hand_swap', 'peek', 'force_discard'].includes(card.type)
    || (room.settings.sevenZero && card.type === 'number' && card.value === 7);
  if (!needTarget) return true;
  const target = playerById(room, targetPlayerId);
  return Boolean(target && target.id !== player.id && target.active);
}

function handlePlayCard(room, player, payload) {
  if (room.state !== 'playing') return;
  if (room.currentPlayerId !== player.id) {
    sendToPlayer(player.id, { type: 'error', code: 'NOT_YOUR_TURN', message: 'Não é seu turno.' });
    return;
  }

  const idx = player.hand.findIndex((c) => c.id === payload.cardId);
  if (idx === -1) {
    sendToPlayer(player.id, { type: 'error', code: 'CARD_NOT_FOUND', message: 'Carta não encontrada.' });
    return;
  }

  const card = player.hand[idx];
  if (!isCardPlayable(room, card, player)) {
    sendToPlayer(player.id, { type: 'error', code: 'INVALID_PLAY', message: 'Jogada inválida.' });
    return;
  }

  if (!validateTargetIfNeeded(card, payload.targetPlayerId, room, player)) {
    sendToPlayer(player.id, { type: 'error', code: 'INVALID_TARGET', message: 'Alvo inválido para esta carta.' });
    return;
  }

  player.hand.splice(idx, 1);
  room.discardPile.push(card);

  if (card.color === 'wild') {
    room.currentColor = payload.chosenColor || 'red';
  } else {
    room.currentColor = card.color;
  }

  if (room.pendingDraw > 0 && (card.type === 'draw2' || card.type === 'wild_draw4')) {
    // stack permitido, efeito já acumula dentro do apply
  }

  const stepAdvance = applyCardEffect(room, card, player, payload.targetPlayerId);

  broadcast(room.code, {
    type: 'card_played',
    playerId: player.id,
    card,
    topCard: room.discardPile[room.discardPile.length - 1],
    chosenColor: room.currentColor,
    nextPlayer: stepAdvance === 0 ? player.id : getNextPlayer(room, stepAdvance).id,
    direction: room.direction,
  });

  checkUno(room, player);

  if (player.hand.length === 0) {
    endRound(room, player);
    return;
  }

  room.currentPlayerId = stepAdvance === 0 ? player.id : getNextPlayer(room, stepAdvance).id;
  announceTurn(room);
}

function createRoom(payload, ws) {
  const code = createRoomCode();
  const host = {
    id: uuidv4(),
    nickname: payload.nickname,
    hand: [],
    score: 0,
    online: true,
    reconnectTimer: null,
    active: true,
    calledUno: false,
    unoSafe: false,
    avatarColor: colorFromNickname(payload.nickname),
  };

  const room = {
    code,
    createdAt: Date.now(),
    state: 'lobby',
    settings: { ...createDefaultSettings(), ...(payload.settings || {}) },
    players: [host],
    hostId: host.id,
    currentPlayerId: host.id,
    direction: 1,
    drawPile: [],
    discardPile: [],
    currentColor: 'red',
    pendingDraw: 0,
    pendingDrawType: null,
    chat: [],
    logs: [],
    roundsPlayed: 0,
    rematchVotes: new Set(),
    turnTimer: null,
    tickTimer: null,
    roundStarterIndex: 0,
  };

  rooms.set(code, room);
  ws.playerId = host.id;
  ws.roomCode = code;
  sockets.set(host.id, ws);

  sendToPlayer(host.id, { type: 'room_created', roomCode: code, playerId: host.id, settings: room.settings });
  sendToPlayer(host.id, {
    type: 'room_joined',
    roomCode: code,
    players: room.players.map((p) => sanitizePlayerForRoomList(p, room)),
    settings: room.settings,
    isHost: true,
  });
}

function joinRoom(payload, ws) {
  const code = (payload.roomCode || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Sala não encontrada.' }));
    return;
  }

  let player = room.players.find((p) => p.nickname.toLowerCase() === payload.nickname.toLowerCase() && !p.online);
  const isReconnect = Boolean(player);

  if (!player) {
    if (room.players.length >= room.settings.maxPlayers) {
      ws.send(JSON.stringify({ type: 'error', code: 'ROOM_FULL', message: 'Sala cheia.' }));
      return;
    }
    player = {
      id: uuidv4(),
      nickname: payload.nickname,
      hand: [],
      score: 0,
      online: true,
      reconnectTimer: null,
      active: true,
      calledUno: false,
      unoSafe: false,
      avatarColor: colorFromNickname(payload.nickname),
    };
    room.players.push(player);
  } else {
    clearTimeout(player.reconnectTimer);
    player.online = true;
    player.active = true;
  }

  ws.playerId = player.id;
  ws.roomCode = code;
  sockets.set(player.id, ws);

  sendToPlayer(player.id, {
    type: 'room_joined',
    roomCode: code,
    players: room.players.map((p) => sanitizePlayerForRoomList(p, room)),
    settings: room.settings,
    isHost: room.hostId === player.id,
  });

  if (isReconnect) {
    sendToPlayer(player.id, { type: 'room_state', fullState: roomStateFor(player, room) });
  } else {
    broadcast(code, { type: 'player_joined', player: sanitizePlayerForRoomList(player, room) });
  }
}

function handleDisconnect(ws) {
  const { roomCode, playerId } = ws;
  if (!roomCode || !playerId) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  const player = playerById(room, playerId);
  if (!player) return;

  player.online = false;
  sockets.delete(playerId);
  broadcast(roomCode, { type: 'player_left', playerId });

  player.reconnectTimer = setTimeout(() => {
    player.active = false;
    if (room.currentPlayerId === player.id && room.state === 'playing') {
      room.currentPlayerId = getNextPlayer(room, 1).id;
      announceTurn(room);
    }

    const activeCount = room.players.filter((p) => p.active).length;
    if (!activeCount) {
      rooms.delete(roomCode);
      return;
    }

    if (room.hostId === player.id) {
      const newHost = room.players.find((p) => p.active);
      if (newHost) room.hostId = newHost.id;
    }
  }, RECONNECT_TIMEOUT_MS);
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON', message: 'JSON inválido.' }));
    return;
  }

  const type = msg.type;
  const payload = msg.payload || {};

  if (type === 'create_room') return createRoom(payload, ws);
  if (type === 'join_room') return joinRoom(payload, ws);

  const room = rooms.get(ws.roomCode);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', code: 'NO_ROOM', message: 'Você não está em sala.' }));
    return;
  }
  const player = playerById(room, ws.playerId);
  if (!player) return;

  switch (type) {
    case 'start_game':
      if (room.hostId !== player.id) return;
      if (room.players.filter((p) => p.active).length < Math.max(2, room.settings.minPlayers)) return;
      startCountdown(room, COUNTDOWN_SECONDS);
      break;
    case 'update_settings':
      if (room.hostId !== player.id || room.state !== 'lobby') return;
      room.settings = { ...room.settings, ...(payload.settings || {}) };
      broadcast(room.code, { type: 'room_state', fullState: roomStateFor(player, room) });
      break;
    case 'play_card':
      handlePlayCard(room, player, payload);
      break;
    case 'draw_card':
      handleDrawCard(room, player);
      break;
    case 'call_uno':
      if (player.hand.length === 2 || player.hand.length === 1) {
        player.calledUno = true;
        player.unoSafe = true;
        broadcast(room.code, { type: 'uno_called', playerId: player.id });
      }
      break;
    case 'challenge_plus4':
      broadcast(room.code, { type: 'challenge_result', success: false, playerId: player.id, cards: 0 });
      break;
    case 'send_chat': {
      const message = String(payload.message || '').slice(0, 240);
      if (!message.trim()) break;
      const chat = { at: now(), playerId: player.id, nickname: player.nickname, message };
      room.chat.push(chat);
      if (room.chat.length > 120) room.chat.shift();
      broadcast(room.code, { type: 'chat_message', ...chat });
      break;
    }
    case 'request_rematch':
      room.rematchVotes.add(player.id);
      if (room.rematchVotes.size === room.players.filter((p) => p.active).length) {
        room.rematchVotes.clear();
        room.players.forEach((p) => {
          p.score = 0;
          p.active = true;
        });
        room.roundsPlayed = 0;
        room.state = 'lobby';
        broadcast(room.code, { type: 'room_state', fullState: roomStateFor(player, room) });
      }
      break;
    case 'leave_room':
      handleDisconnect(ws);
      break;
    default:
      ws.send(JSON.stringify({ type: 'error', code: 'UNKNOWN_EVENT', message: `Evento não suportado: ${type}` }));
  }
}

function printTerminalPanel(serverIp) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔥 BLAZE CARDS - UNO Multiplayer (Node.js + WS)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Servidor local : http://${serverIp}:${PORT}`);
  console.log(`WebSocket      : ws://${serverIp}:${PORT}`);
  console.log('Como conectar no celular:');
  console.log('1) Deixe host e celulares no MESMO Wi-Fi.');
  console.log(`2) Abra no navegador: http://${serverIp}:${PORT}`);
  console.log('3) Crie/entre na sala pelo código de 6 caracteres.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

function serveStatic(req, res) {
  // Strip query strings
  const urlPath = req.url.split('?')[0];

  // API: expose local IP for QR code generation
  if (urlPath === '/api/info') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ ip: getLocalIPv4(), port: PORT }));
  }

  // Map URL to filesystem path inside /public
  const relPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(__dirname, 'public', relPath);

  // Security: block path traversal outside public/
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    return res.end(content);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (msg) => handleMessage(ws, msg));
  ws.on('close', () => handleDisconnect(ws));
});

setInterval(() => {
  const status = Array.from(rooms.values()).map((room) => `${room.code}:${room.players.filter((p) => p.online).length}/${room.players.length}`);
  console.log(`[${new Date().toLocaleTimeString()}] Salas ativas(${rooms.size}) -> ${status.join(', ') || 'nenhuma'}`);
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIPv4();
  printTerminalPanel(ip);
});
