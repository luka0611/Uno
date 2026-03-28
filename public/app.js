/* ═══════════════════════════════════════════════════════════════════
   BLAZE CARDS — app.js
   Frontend completo: estado, WebSocket, cartas SVG, GSAP, sons
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── STATE ───────────────────────────────────────────────────────
const State = {
  ws: null,
  roomCode: null,
  playerId: null,
  isHost: false,
  settings: {},
  players: [],
  hand: [],
  topCard: null,
  currentPlayer: null,
  currentColor: 'red',
  drawPileCount: 0,
  direction: 1,
  pendingDraw: 0,
  pendingDrawType: null,
  muted: false,
};

// ─── AUDIO (Web Audio API — sem arquivos) ────────────────────────
const SFX = (() => {
  let ctx = null;

  function getCtx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* noop */ }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type = 'sine', vol = 0.25, delay = 0) {
    if (State.muted) return;
    const c = getCtx();
    if (!c) return;
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.connect(gain);
      gain.connect(c.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, c.currentTime + delay);
      gain.gain.setValueAtTime(vol, c.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + dur);
      osc.start(c.currentTime + delay);
      osc.stop(c.currentTime + delay + dur + 0.02);
    } catch (e) { /* noop */ }
  }

  return {
    cardPlay:  () => { tone(440, 0.07, 'square', 0.14); tone(660, 0.11, 'sine', 0.18, 0.05); },
    cardDraw:  () => tone(260, 0.14, 'triangle', 0.18),
    uno:       () => { tone(660, 0.1, 'sine', 0.28); tone(880, 0.22, 'sine', 0.35, 0.1); },
    win:       () => [440, 554, 660, 784, 880].forEach((f, i) => tone(f, 0.18, 'sine', 0.28, i * 0.09)),
    special:   () => { tone(550, 0.07, 'square', 0.18); tone(770, 0.1, 'sine', 0.22, 0.06); },
    error:     () => tone(200, 0.22, 'sawtooth', 0.14),
    tick:      () => tone(880, 0.04, 'sine', 0.08),
  };
})();

// ─── CARD RENDERING ──────────────────────────────────────────────
const SYMBOLS = {
  skip:          '⊘',
  reverse:       '⇄',
  draw2:         '+2',
  hand_swap:     '↔',
  peek:          '◉',
  force_discard: '✕',
  wild:          'W',
  wild_draw4:    '+4',
  wild_swap_all: '⇌',
  wild_bonus:    '★',
  wild_blase:    '!',
};

function getSymbol(card) {
  if (card.type === 'number') return String(card.value);
  return SYMBOLS[card.type] || '?';
}

function createCardEl(card, isPlayable = false, isTop = false) {
  const el = document.createElement('div');
  const isWild = card.color === 'wild';
  el.className = [
    'card',
    `card-${isWild ? 'wild' : card.color}`,
    isPlayable ? 'playable' : '',
    isTop ? 'top-card' : '',
  ].filter(Boolean).join(' ');

  el.dataset.cardId = card.id;
  const sym = getSymbol(card);

  const ovalInner = isWild
    ? `<div class="oval wild-oval"><span class="symbol">${sym}</span></div>`
    : `<div class="oval"><span class="symbol">${sym}</span></div>`;

  el.innerHTML = `
    <span class="corner corner-tl">${sym}</span>
    ${ovalInner}
    <span class="corner corner-br">${sym}</span>
  `;

  if (isPlayable) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `Jogar ${card.color} ${sym}`);
    el.setAttribute('draggable', 'true');
  }

  return el;
}

function createCardBack() {
  const el = document.createElement('div');
  el.className = 'card card-back';
  el.innerHTML = '<div class="card-back-inner"><span class="card-back-text">UNO</span></div>';
  return el;
}

// ─── ANIMATIONS (GSAP) ───────────────────────────────────────────
const Anim = {
  flyCard(fromEl, toEl, onDone) {
    if (!window.gsap || !fromEl || !toEl) { if (onDone) onDone(); return; }
    const fr = fromEl.getBoundingClientRect();
    const tr = toEl.getBoundingClientRect();
    const clone = fromEl.cloneNode(true);
    Object.assign(clone.style, {
      position: 'fixed',
      left: fr.left + 'px',
      top: fr.top + 'px',
      width: fr.width + 'px',
      height: fr.height + 'px',
      zIndex: '9999',
      pointerEvents: 'none',
      margin: '0',
      transformOrigin: 'center center',
    });
    document.body.appendChild(clone);

    gsap.to(clone, {
      x: (tr.left + tr.width / 2) - (fr.left + fr.width / 2),
      y: (tr.top + tr.height / 2) - (fr.top + fr.height / 2),
      scale: tr.width / fr.width,
      rotation: (Math.random() - 0.5) * 18,
      duration: 0.36,
      ease: 'power2.inOut',
      onComplete: () => { clone.remove(); if (onDone) onDone(); },
    });
  },

  dealHand(handEl, pileEl) {
    if (!window.gsap || !pileEl) return;
    const pileRect = pileEl.getBoundingClientRect();
    handEl.querySelectorAll('.card').forEach((card, i) => {
      const cr = card.getBoundingClientRect();
      gsap.fromTo(card,
        { x: pileRect.left - cr.left, y: pileRect.top - cr.top, opacity: 0, scale: 0.5 },
        { x: 0, y: 0, opacity: 1, scale: 1, duration: 0.28, delay: i * 0.055, ease: 'back.out(1.6)' }
      );
    });
  },

  bounce(el) {
    if (!window.gsap || !el) return;
    gsap.fromTo(el, { scale: 1 }, { scale: 1.18, yoyo: true, repeat: 1, duration: 0.13, ease: 'power2.out' });
  },

  shake(el) {
    if (!window.gsap || !el) return;
    gsap.fromTo(el, { x: 0 }, { x: 7, yoyo: true, repeat: 5, duration: 0.06, ease: 'none' });
  },

  burst(x, y, colors, count = 14) {
    const colorList = Array.isArray(colors) ? colors : [colors];
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      const color = colorList[i % colorList.length];
      const size = 6 + Math.random() * 8;
      Object.assign(p.style, {
        position: 'fixed',
        left: x + 'px', top: y + 'px',
        width: size + 'px', height: size + 'px',
        borderRadius: '50%',
        background: color,
        pointerEvents: 'none',
        zIndex: '9998',
        transform: 'translate(-50%,-50%)',
      });
      document.body.appendChild(p);
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 28 + Math.random() * 60;
      if (window.gsap) {
        gsap.to(p, {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          opacity: 0, scale: 0,
          duration: 0.45 + Math.random() * 0.35,
          ease: 'power2.out',
          onComplete: () => p.remove(),
        });
      } else {
        setTimeout(() => p.remove(), 800);
      }
    }
  },

  celebration() {
    const colors = ['#ff4444', '#ffdd00', '#44cc66', '#44aaff', '#ff88cc', '#ffffff'];
    [0, 100, 200, 330, 460].forEach((delay) => {
      setTimeout(() => {
        Anim.burst(
          window.innerWidth * (0.2 + Math.random() * 0.6),
          window.innerHeight * (0.15 + Math.random() * 0.55),
          colors, 18
        );
      }, delay);
    });
  },
};

// ─── VIBRATION ───────────────────────────────────────────────────
function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* noop */ }
}

// ─── QR CODE ─────────────────────────────────────────────────────
async function renderQR(containerEl) {
  try {
    const res = await fetch('/api/info');
    const { ip, port } = await res.json();
    const url = `http://${ip}:${port}`;
    containerEl.innerHTML = '';

    if (window.QRCode) {
      new QRCode(containerEl, {
        text: url,
        width: 148, height: 148,
        correctLevel: QRCode.CorrectLevel.M,
      });
    }

    const lbl = document.createElement('p');
    lbl.className = 'qr-url';
    lbl.textContent = url;
    containerEl.appendChild(lbl);
  } catch (e) {
    containerEl.innerHTML = '<small style="color:#888">QR indisponível</small>';
  }
}

// ─── NETWORK ─────────────────────────────────────────────────────
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:${location.port || 3000}`;
}

function send(type, payload = {}) {
  if (State.ws && State.ws.readyState === WebSocket.OPEN) {
    State.ws.send(JSON.stringify({ type, payload }));
  }
}

function connectWS(onOpen) {
  if (State.ws) { try { State.ws.close(); } catch (e) { /* noop */ } }
  const ws = new WebSocket(wsUrl());
  State.ws = ws;
  ws.onopen    = onOpen;
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose   = () => { UI.toast('Desconectado do servidor.', 'error'); };
  ws.onerror   = () => { UI.toast('Erro de conexão.', 'error'); };
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────
function onMessage(msg) {
  switch (msg.type) {

    case 'room_created':
      State.roomCode = msg.roomCode;
      State.playerId = msg.playerId;
      break;

    case 'room_joined':
      State.roomCode  = msg.roomCode;
      State.players   = msg.players;
      State.settings  = msg.settings;
      State.isHost    = msg.isHost;
      Screens.lobby();
      break;

    case 'player_joined':
      State.players.push(msg.player);
      Screens.renderPlayers();
      Screens.updateStartBtn();
      break;

    case 'player_left':
      State.players = State.players.map(p =>
        p.id === msg.playerId ? { ...p, online: false } : p
      );
      Screens.renderPlayers();
      break;

    case 'countdown':
      el('countdown').textContent = msg.seconds > 0
        ? `Iniciando em ${msg.seconds}…`
        : '🎮 Vai!';
      if (msg.seconds <= 0) SFX.tick();
      break;

    case 'game_started':
      State.hand          = msg.hand;
      State.topCard       = msg.topCard;
      State.currentPlayer = msg.currentPlayer;
      State.direction     = msg.direction;
      State.settings      = msg.settings;
      State.pendingDraw   = 0;
      State.currentColor  = msg.topCard ? msg.topCard.color : 'red';
      // Sync hand counts: all start with 7
      State.players = State.players.map(p => ({
        ...p,
        handCount: p.id === State.playerId ? msg.hand.length : 7,
      }));
      Screens.game();
      setTimeout(() => {
        Anim.dealHand(el('my-hand'), el('draw-pile-zone'));
      }, 80);
      SFX.cardPlay();
      break;

    case 'card_played': {
      const wasMyCard = msg.playerId === State.playerId;
      if (!wasMyCard) {
        SFX.cardPlay();
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight * 0.38;
        Anim.burst(cx, cy, ['#fff', '#ffdd00', '#ff6644'], 10);
      }
      State.topCard       = msg.topCard;
      State.currentPlayer = msg.nextPlayer;
      State.direction     = msg.direction;
      State.currentColor  = msg.chosenColor || msg.topCard?.color || State.currentColor;

      // Update pending draw
      if (msg.card.type === 'draw2') {
        State.pendingDraw = (State.pendingDraw || 0) + 2;
        State.pendingDrawType = 'draw2';
      } else if (msg.card.type === 'wild_draw4') {
        State.pendingDraw = (State.pendingDraw || 0) + 4;
        State.pendingDrawType = 'wild_draw4';
      } else {
        State.pendingDraw = 0;
        State.pendingDrawType = null;
      }

      if (wasMyCard) {
        State.hand = State.hand.filter(c => c.id !== msg.card.id);
      }
      State.players = State.players.map(p =>
        p.id === msg.playerId
          ? { ...p, handCount: Math.max(0, (p.handCount || 1) - 1) }
          : p
      );

      appendLog(`${playerName(msg.playerId)} jogou ${getSymbol(msg.card)}`);
      Screens.renderGame();
      break;
    }

    case 'card_drawn':
      State.players = State.players.map(p =>
        p.id === msg.playerId
          ? { ...p, handCount: (p.handCount || 0) + msg.count }
          : p
      );
      if (msg.playerId !== State.playerId) SFX.cardDraw();
      Screens.renderOpponents();
      Screens.renderBoardInfo();
      break;

    case 'drawn_cards':
      State.hand.push(...msg.cards);
      State.pendingDraw = 0;
      State.pendingDrawType = null;
      SFX.cardDraw();
      Screens.renderHand();
      Screens.renderBoardInfo();
      break;

    case 'turn_changed':
      State.currentPlayer = msg.currentPlayer;
      Screens.renderGame();
      if (msg.currentPlayer === State.playerId) vibrate(50);
      break;

    case 'uno_called': {
      const name = playerName(msg.playerId);
      appendLog(`🎉 ${name} gritou UNO!`);
      SFX.uno();
      Anim.burst(window.innerWidth / 2, window.innerHeight / 2,
        ['#ff4488', '#ff8844', '#ffee00'], 22);
      Screens.renderOpponents();
      break;
    }

    case 'uno_penalty':
      appendLog(`⚠️ Penalidade UNO: ${playerName(msg.playerId)} +${msg.cards}`);
      SFX.error();
      Screens.renderGame();
      break;

    case 'chat_message':
      appendChat(msg);
      break;

    case 'peek_result':
      UI.toast('Você espiou a mão do adversário!', 'info');
      break;

    case 'round_ended':
      SFX.win();
      Anim.celebration();
      appendLog(`🏆 ${msg.winner.nickname} venceu a rodada!`);
      UI.toast(`${msg.winner.nickname} venceu a rodada! 🏆`, 'success');
      break;

    case 'game_ended':
      SFX.win();
      Anim.celebration();
      appendLog(`🎊 ${msg.winner.nickname} venceu a partida!`);
      UI.toast(`${msg.winner.nickname} VENCEU! 🎊`, 'success');
      setTimeout(() => Screens.lobby(), 4000);
      break;

    case 'room_state': {
      const s = msg.fullState;
      State.roomCode      = s.roomCode;
      State.players       = s.players;
      State.settings      = s.settings;
      State.isHost        = s.hostId === State.playerId;
      State.currentPlayer = s.currentPlayer;
      State.direction     = s.direction;
      State.topCard       = s.topCard;
      State.currentColor  = s.currentColor || 'red';
      State.drawPileCount = s.drawPileCount;
      State.pendingDraw   = s.pendingDraw || 0;
      State.hand          = s.hand || [];

      if (s.state === 'playing') {
        Screens.game();
      } else {
        Screens.lobby();
      }
      break;
    }

    case 'error':
      SFX.error();
      Anim.shake(document.body);
      UI.toast(msg.message, 'error');
      break;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function playerName(playerId) {
  return State.players.find(p => p.id === playerId)?.nickname || 'Jogador';
}

function isPlayable(card) {
  if (!State.topCard) return true;
  if (State.pendingDraw > 0) {
    if (!State.settings.stackDraw) return false;
    if (State.pendingDrawType === 'draw2'      && card.type === 'draw2')      return true;
    if (State.pendingDrawType === 'wild_draw4' && card.type === 'wild_draw4') return true;
    return false;
  }
  if (card.color === 'wild') return true;
  if (card.color === State.currentColor) return true;
  if (card.type === 'number' && State.topCard.type === 'number' && card.value === State.topCard.value) return true;
  if (card.type !== 'number' && card.type === State.topCard.type) return true;
  return false;
}

// ─── PLAY FLOW ────────────────────────────────────────────────────
let _draggedCard = null;

async function playCard(card, fromEl) {
  const payload = { cardId: card.id };

  if (card.color === 'wild') {
    const color = await pickColor();
    if (!color) return;
    payload.chosenColor = color;
  }

  const needsTarget = ['hand_swap', 'peek', 'force_discard'].includes(card.type)
    || (State.settings.sevenZero && card.type === 'number' && card.value === 7);

  if (needsTarget) {
    const targetId = await pickTarget();
    if (!targetId) return;
    payload.targetPlayerId = targetId;
  }

  // Animate: card flies to discard pile
  const discardZone = el('discard-pile-zone');
  if (fromEl && discardZone && window.gsap) {
    Anim.flyCard(fromEl, discardZone);
  }

  vibrate(20);
  SFX.cardPlay();
  send('play_card', payload);
}

function pickColor() {
  return new Promise(resolve => {
    const modal = el('color-modal');
    modal.classList.add('active');

    const handler = (e) => {
      const btn = e.target.closest('.color-btn');
      if (btn) {
        modal.classList.remove('active');
        modal.removeEventListener('click', handler);
        resolve(btn.dataset.color);
      } else if (e.target === modal) {
        modal.classList.remove('active');
        modal.removeEventListener('click', handler);
        resolve(null);
      }
    };
    modal.addEventListener('click', handler);
  });
}

function pickTarget() {
  return new Promise(resolve => {
    const modal = el('target-modal');
    const list  = el('target-list');
    list.innerHTML = '';

    State.players.filter(p => p.id !== State.playerId && p.online !== false).forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary target-btn';
      btn.innerHTML = `
        <span class="target-avatar" style="background:${p.avatarColor || '#666'}">${(p.nickname || '?')[0].toUpperCase()}</span>
        <span>${p.nickname} (${p.handCount ?? '?'} cartas)</span>
      `;
      btn.onclick = () => {
        modal.classList.remove('active');
        resolve(p.id);
      };
      list.appendChild(btn);
    });

    modal.classList.add('active');

    el('btn-cancel-target').onclick = () => {
      modal.classList.remove('active');
      resolve(null);
    };

    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
        resolve(null);
      }
    };
  });
}

// ─── SCREENS ─────────────────────────────────────────────────────
const Screens = {
  _show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  },

  menu() {
    this._show('screen-menu');
  },

  lobby() {
    this._show('screen-lobby');
    el('lobby-code').textContent = State.roomCode || '------';
    this.renderPlayers();
    this.renderSettings();
    this.updateStartBtn();
    el('countdown').textContent = '';

    const qrSection = el('qr-section');
    qrSection.style.display = State.isHost ? 'block' : 'none';
    if (State.isHost) renderQR(el('qr-code'));
  },

  renderPlayers() {
    const list = el('player-list');
    list.innerHTML = '';
    State.players.forEach(p => {
      const chip = document.createElement('div');
      chip.className = `player-chip${p.online === false ? ' offline' : ''}`;
      chip.style.setProperty('--avatar-color', p.avatarColor || '#888');
      chip.innerHTML = `
        <span class="player-chip-avatar">${(p.nickname || '?')[0].toUpperCase()}</span>
        <span class="player-chip-name">${p.nickname}${p.isHost ? ' 👑' : ''}</span>
        ${p.online === false ? '<span class="player-chip-offline">offline</span>' : ''}
      `;
      list.appendChild(chip);
    });
  },

  renderSettings() {
    const section = el('settings-section');
    section.style.display = State.isHost ? 'block' : 'none';
    if (!State.isHost) return;

    const form = el('settings-form');
    form.innerHTML = '';

    const toggles = [
      ['fastRound',         'Rodada Rápida (20s)'],
      ['stackDraw',         'Acumular +2/+4'],
      ['strictUno',         'UNO Estrito'],
      ['drawAndPassOnly',   'Puxa e Passa'],
      ['sevenZero',         'Regra 7/0'],
      ['extraSpecialCards', 'Cartas Especiais'],
    ];

    toggles.forEach(([key, label]) => {
      const lbl = document.createElement('label');
      lbl.className = 'toggle-row';
      lbl.innerHTML = `
        <span>${label}</span>
        <input type="checkbox" class="toggle-input" data-key="${key}" ${State.settings[key] ? 'checked' : ''}>
      `;
      form.appendChild(lbl);
    });

    form.querySelectorAll('.toggle-input').forEach(inp => {
      inp.onchange = () => {
        State.settings[inp.dataset.key] = inp.checked;
        send('update_settings', { settings: State.settings });
      };
    });
  },

  updateStartBtn() {
    const btn = el('btn-start');
    const min = Math.max(2, State.settings.minPlayers || 2);
    const online = State.players.filter(p => p.online !== false).length;
    btn.disabled = !(State.isHost && online >= min);
  },

  game() {
    this._show('screen-game');
    this.renderGame();
  },

  renderGame() {
    this.renderTurnStatus();
    this.renderBoardInfo();
    this.renderOpponents();
    this.renderHand();
    this.renderActionBar();
  },

  renderTurnStatus() {
    const isMyTurn = State.currentPlayer === State.playerId;
    const statusEl = el('turn-status');
    statusEl.textContent = isMyTurn
      ? '🎯 SUA VEZ'
      : `Vez de ${playerName(State.currentPlayer)}`;
    statusEl.className = `turn-status${isMyTurn ? ' my-turn' : ''}`;
  },

  renderBoardInfo() {
    // Top card
    const slot = el('top-card-slot');
    slot.innerHTML = '';
    if (State.topCard) {
      slot.appendChild(createCardEl(State.topCard, false, true));
    }

    // Draw count
    el('draw-count').textContent = State.drawPileCount || '?';

    // Color indicator
    el('color-indicator').className = `color-indicator color-${State.currentColor || 'red'}`;

    // Direction
    el('direction-indicator').textContent = State.direction === 1 ? '↻' : '↺';

    // Pending draw
    const badge = el('pending-draw-badge');
    if (State.pendingDraw > 0) {
      badge.textContent = `+${State.pendingDraw} pendente`;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  },

  renderOpponents() {
    const area = el('opponents');
    area.innerHTML = '';
    State.players.filter(p => p.id !== State.playerId).forEach(p => {
      const isActive = p.id === State.currentPlayer;
      const div = document.createElement('div');
      div.className = `opponent${isActive ? ' active-turn' : ''}`;

      const backCards = Array.from({ length: Math.min(12, p.handCount || 0) },
        () => '<div class="back-mini"></div>').join('');

      const handInfo = p.handCount === 1
        ? `<span class="uno-alert">⚠️ UNO!</span>`
        : `<span>${p.handCount ?? 0} carta${p.handCount !== 1 ? 's' : ''}</span>`;

      div.innerHTML = `
        <div class="opp-avatar" style="background:${p.avatarColor || '#888'}">${(p.nickname || '?')[0].toUpperCase()}</div>
        <div class="opp-info">
          <strong>${p.nickname}${p.isHost ? ' 👑' : ''}</strong>
          ${handInfo}
        </div>
        <div class="opp-cards">${backCards}</div>
      `;
      area.appendChild(div);
    });
  },

  renderHand() {
    const handEl = el('my-hand');
    const scrollLeft = handEl.scrollLeft;
    const isMyTurn = State.currentPlayer === State.playerId;
    handEl.innerHTML = '';

    State.hand.forEach(card => {
      const playable = isMyTurn && isPlayable(card);
      const cardEl = createCardEl(card, playable);

      if (playable) {
        cardEl.addEventListener('click', () => playCard(card, cardEl));
        cardEl.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') playCard(card, cardEl); });
        cardEl.addEventListener('dragstart', () => {
          _draggedCard = { card, el: cardEl };
          setTimeout(() => cardEl.classList.add('dragging'), 0);
        });
        cardEl.addEventListener('dragend', () => {
          _draggedCard = null;
          cardEl.classList.remove('dragging');
        });
      }

      handEl.appendChild(cardEl);
    });

    handEl.scrollLeft = scrollLeft;
  },

  renderActionBar() {
    const isMyTurn = State.currentPlayer === State.playerId;
    el('btn-draw').disabled = !isMyTurn;

    const unoBtn = el('btn-uno');
    const showUno = State.hand.length <= 2;
    unoBtn.style.display = showUno ? 'flex' : 'none';
    unoBtn.classList.toggle('pulsing', State.hand.length === 1);

    // Cut UNO targets
    const cutZone = el('cut-uno-zone');
    cutZone.innerHTML = '';
    State.players
      .filter(p => p.id !== State.playerId && p.handCount === 1)
      .forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-danger btn-sm';
        btn.textContent = `✂️ Cortar UNO: ${p.nickname}`;
        btn.onclick = () => {
          vibrate([20, 30, 20]);
          SFX.special();
          UI.toast(`Cortou o UNO de ${p.nickname}!`, 'warning');
          send('send_chat', { message: `CORTA UNO em ${p.nickname}!` });
        };
        cutZone.appendChild(btn);
      });
  },
};

// ─── UI HELPERS ──────────────────────────────────────────────────
const UI = {
  toast(message, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = message;
    el('toast-container').appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('visible')));
    setTimeout(() => {
      t.classList.remove('visible');
      setTimeout(() => t.remove(), 320);
    }, 2800);
  },
};

function appendLog(msg) {
  const log = el('event-log');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  if (log.children.length > 30) log.removeChild(log.firstChild);
}

function appendChat(msg) {
  const chat = el('chat-lobby');
  if (!chat) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<strong>${msg.nickname}:</strong> ${msg.message.replace(/</g, '&lt;')}`;
  chat.appendChild(line);
  chat.scrollTop = chat.scrollHeight;
}

// ─── DRAG & DROP on discard pile ─────────────────────────────────
function setupDragDrop() {
  const discardZone = el('discard-pile-zone');

  discardZone.addEventListener('dragover', (e) => {
    if (_draggedCard) {
      e.preventDefault();
      discardZone.classList.add('drop-target');
    }
  });

  discardZone.addEventListener('dragleave', () => {
    discardZone.classList.remove('drop-target');
  });

  discardZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    discardZone.classList.remove('drop-target');
    if (_draggedCard && State.currentPlayer === State.playerId) {
      const { card, el: fromEl } = _draggedCard;
      _draggedCard = null;
      await playCard(card, fromEl);
    }
  });

  // Click draw pile
  el('draw-pile-zone').addEventListener('click', () => {
    if (State.currentPlayer === State.playerId) send('draw_card');
  });
}

// ─── LEAVE HANDLERS ──────────────────────────────────────────────
function leaveRoom() {
  send('leave_room');
  try { State.ws?.close(); } catch (e) { /* noop */ }
  State.ws = null;
  State.roomCode = null;
  State.playerId = null;
  State.isHost   = false;
  State.hand     = [];
  State.players  = [];
  Screens.menu();
}

// ─── MUTE TOGGLE ────────────────────────────────────────────────
function toggleMute() {
  State.muted = !State.muted;
  const icon = State.muted ? '🔇' : '🔊';
  const muteBtn     = el('btn-mute');
  const muteBtnGame = el('btn-mute-game');
  if (muteBtn)     muteBtn.textContent     = icon;
  if (muteBtnGame) muteBtnGame.textContent = icon;
  localStorage.setItem('blaze_muted', State.muted ? '1' : '0');
}

// ─── INIT ────────────────────────────────────────────────────────
function init() {
  // Service Worker (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-critical */ });
  }

  // Restore nickname
  const savedNick = localStorage.getItem('blaze_nick');
  if (savedNick) el('nickname').value = savedNick;
  el('nickname').addEventListener('input', (e) => {
    localStorage.setItem('blaze_nick', e.target.value);
  });

  // Restore mute
  if (localStorage.getItem('blaze_muted') === '1') {
    State.muted = true;
    el('btn-mute').textContent     = '🔇';
    el('btn-mute-game').textContent = '🔇';
  }

  // ── Menu actions ──
  el('btn-create').addEventListener('click', () => {
    const nick = el('nickname').value.trim() || 'Jogador';
    connectWS(() => send('create_room', { nickname: nick, settings: {} }));
  });

  el('btn-join').addEventListener('click', () => {
    const nick = el('nickname').value.trim() || 'Jogador';
    const code = el('room-code').value.trim().toUpperCase();
    if (!code) { UI.toast('Digite o código da sala', 'error'); return; }
    connectWS(() => send('join_room', { roomCode: code, nickname: nick }));
  });

  el('room-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('btn-join').click();
  });

  // ── Lobby actions ──
  el('btn-start').addEventListener('click', () => send('start_game'));

  el('btn-leave-lobby').addEventListener('click', () => leaveRoom());

  el('btn-mute').addEventListener('click', toggleMute);

  el('btn-send').addEventListener('click', sendChat);
  el('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // ── Game actions ──
  el('btn-draw').addEventListener('click', () => {
    if (State.currentPlayer === State.playerId) send('draw_card');
  });

  el('btn-uno').addEventListener('click', () => {
    vibrate([40, 30, 80]);
    SFX.uno();
    Anim.burst(window.innerWidth / 2, window.innerHeight * 0.65,
      ['#ff4488', '#ffee00', '#ff6644'], 20);
    Anim.bounce(el('btn-uno'));
    send('call_uno');
  });

  el('btn-leave-game').addEventListener('click', () => {
    if (confirm('Sair da partida?')) leaveRoom();
  });

  el('btn-mute-game').addEventListener('click', toggleMute);

  setupDragDrop();
}

function sendChat() {
  const input = el('chat-input');
  const msg = input.value.trim();
  if (msg) {
    send('send_chat', { message: msg });
    input.value = '';
  }
}

document.addEventListener('DOMContentLoaded', init);
