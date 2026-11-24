'use strict';
/*
 * Split or Steal: Millions — serveur de jeu (Node.js + Socket.io)
 * Le serveur fait autorité : argent, achats, choix et résultats sont calculés ici.
 * Le client n'envoie que des intentions (choisir, parler, acheter, doubler).
 * L'argent du jeu est 100 % virtuel : il ne s'achète pas et ne se retire pas.
 * Sauvegarde : Postgres si DATABASE_URL est défini, sinon fichier data.json.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 40;      // durée de la discussion
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS) || 8000;      // attente avant un bot
const REVEAL_DELAY_MS = Number(process.env.REVEAL_DELAY_MS) || 1500; // suspense quand les 2 ont choisi
const FORCE_TIER = (process.env.FORCE_TIER || "").trim() || null;                  // test : forcer un pot (ex. mega)
const RESELL_RATE = 0.5;                                            // revente du luxe : 50 % du prix
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
// cors : le jeu peut être hébergé sur un portail (CrazyGames, itch.io…) et se connecter à ce serveur.
const io = new Server(server, { maxHttpBufferSize: 10_000, cors: { origin: '*' } });
app.get('/healthz', (_req, res) => res.send('ok'));

/* ---------------- Contenu du jeu ---------------- */

// Phrases prédéfinies : pas de chat libre (public jeune, aucune modération nécessaire).
const PHRASES = [
  'Hey! Split? 🤝',
  'I’ll split, I swear.',
  'Trust me.',
  'Prove it.',
  'I don’t believe you…',
  'Someone stole from me last time 😤',
  'This way we both win.',
  'If you steal, I steal too.',
  'I’m stealing. Split anyway 😇',
  'Check my split rate.',
  'Your split rate looks shady 🤨',
  'This pot is mine!',
  'Ok, deal.',
  'Hmm…',
  'You’re bluffing.',
  '😈',
  '😇',
  '😂',
  'GG',
  'Rematch?'
].map((t) => ({ t, pack: null }));

// Packs achetables (ajoutés à la fin : les index de base ne bougent pas).
const PHRASE_PACKS = {
  p_provoc: ['Too easy.', 'You’re gonna cry 😭', 'I’m the boss here 😎', 'Last chance…', 'Not scared.'],
  p_bluff: ['I always split, look at my rate.', 'I swear on my life.', 'Me, steal? Never.', 'Team up?', 'Here’s a gift for you 🎁']
};
for (const [pack, list] of Object.entries(PHRASE_PACKS)) list.forEach((t) => PHRASES.push({ t, pack }));

// Les pots d'argent au milieu. 1 % de chance de méga jackpot.
const POTS = [
  { key: 'petit', label: 'Small pot', weight: 57, min: 1_000, max: 10_000, step: 100 },
  { key: 'gros', label: 'Big pot', weight: 30, min: 15_000, max: 60_000, step: 500 },
  { key: 'enorme', label: 'Huge pot', weight: 10, min: 100_000, max: 400_000, step: 5_000 },
  { key: 'jackpot', label: 'Jackpot', weight: 2, min: 750_000, max: 1_500_000, step: 50_000 },
  { key: 'mega', label: 'MEGA JACKPOT', weight: 1, min: 5_000_000, max: 5_000_000, step: 1 }
];

/* ---------------- Boutique ---------------- */
// Uniquement des achats à prix fixe avec l'argent du jeu : jamais de hasard payant.
const LUXURY = [
  { id: 'l_citadine', cat: 'cars', emoji: '🚗', name: 'City car', price: 25_000 },
  { id: 'l_moto', cat: 'cars', emoji: '🏍️', name: 'Sport bike', price: 60_000 },
  { id: 'l_suv', cat: 'cars', emoji: '🚙', name: 'Luxury SUV', price: 150_000 },
  { id: 'l_sportive', cat: 'cars', emoji: '🏎️', name: 'Italian sports car', price: 400_000 },
  { id: 'l_hypercar', cat: 'cars', emoji: '🏁', name: 'Hypercar', price: 2_500_000 },
  { id: 'l_bateau', cat: 'boats', emoji: '🚤', name: 'Speedboat', price: 90_000 },
  { id: 'l_voilier', cat: 'boats', emoji: '⛵', name: 'Racing sailboat', price: 450_000 },
  { id: 'l_yacht', cat: 'boats', emoji: '🛥️', name: '100 ft yacht', price: 3_000_000 },
  { id: 'l_megayacht', cat: 'boats', emoji: '🛳️', name: 'Mega yacht', price: 25_000_000 },
  { id: 'l_maison', cat: 'homes', emoji: '🏠', name: 'Country house', price: 200_000 },
  { id: 'l_penthouse', cat: 'homes', emoji: '🏙️', name: 'City penthouse', price: 1_200_000 },
  { id: 'l_villa', cat: 'homes', emoji: '🏖️', name: 'Beachfront villa', price: 5_000_000 },
  { id: 'l_chateau', cat: 'homes', emoji: '🏰', name: 'Castle', price: 15_000_000 },
  { id: 'l_ile', cat: 'homes', emoji: '🏝️', name: 'Private island', price: 50_000_000 },
  { id: 'l_helico', cat: 'aircraft', emoji: '🚁', name: 'Helicopter', price: 1_500_000 },
  { id: 'l_jet', cat: 'aircraft', emoji: '✈️', name: 'Private jet', price: 12_000_000 }
];

const SHOP = {
  avatar: [
    { id: 'a_smile', label: '🙂', price: 0 }, { id: 'a_cool', label: '😎', price: 15_000 },
    { id: 'a_cowboy', label: '🤠', price: 25_000 }, { id: 'a_fox', label: '🦊', price: 40_000 },
    { id: 'a_alien', label: '👽', price: 40_000 }, { id: 'a_ghost', label: '👻', price: 70_000 },
    { id: 'a_lion', label: '🦁', price: 150_000 }, { id: 'a_dragon', label: '🐉', price: 400_000 },
    { id: 'a_crown', label: '👑', price: 1_000_000 }
  ],
  title: [
    { id: 't_debutant', label: 'Rookie', price: 0 }, { id: 't_honnete', label: 'Honest', price: 20_000 },
    { id: 't_bluffeur', label: 'Bluffer', price: 35_000 }, { id: 't_traitre', label: 'The Traitor', price: 60_000 },
    { id: 't_roi', label: 'King of Splits', price: 150_000 }, { id: 't_requin', label: 'Shark', price: 400_000 },
    { id: 't_millionnaire', label: 'Millionaire', price: 1_000_000 }, { id: 't_milliardaire', label: 'Billionaire', price: 20_000_000 }
  ],
  color: [
    { id: 'c_white', label: 'White', value: '#f2f3f7', price: 0 }, { id: 'c_green', label: 'Green', value: '#2fd17a', price: 30_000 },
    { id: 'c_blue', label: 'Blue', value: '#3b9cff', price: 50_000 }, { id: 'c_pink', label: 'Pink', value: '#ff6bcb', price: 80_000 },
    { id: 'c_purple', label: 'Purple', value: '#b46bff', price: 150_000 }, { id: 'c_gold', label: 'Gold', value: '#ffc83d', price: 750_000 }
  ],
  phrases: [
    { id: 'p_provoc', label: 'Trash Talk pack', price: 40_000, preview: PHRASE_PACKS.p_provoc },
    { id: 'p_bluff', label: 'Bluff Master pack', price: 60_000, preview: PHRASE_PACKS.p_bluff }
  ]
};
const DEFAULT_OWNED = ['a_smile', 't_debutant', 'c_white'];
const DEFAULT_EQUIPPED = { avatar: 'a_smile', title: 't_debutant', color: 'c_white' };
const shopEntry = (kind, id) => (SHOP[kind] || []).find((e) => e.id === id) || null;
const luxuryEntry = (id) => LUXURY.find((l) => l.id === id) || null;

function cosmetics(equipped) {
  return {
    avatar: shopEntry('avatar', equipped.avatar)?.label || '🙂',
    title: shopEntry('title', equipped.title)?.label || 'Rookie',
    color: shopEntry('color', equipped.color)?.value || '#f2f3f7'
  };
}

const BOT_NAMES = ['Lina', 'Max_the_sly', 'Zoe', 'Kenzo', 'Sasha', 'Noah', 'Ines', 'Ryan', 'Leo', 'Jade', 'Mia', 'Ethan', 'Luca', 'Ava'];
const BOT_TYPES = [
  { key: 'gentil', split: 0.85, phrases: [0, 1, 2, 6, 12, 16, 18] },
  { key: 'mefiant', split: 0.55, phrases: [3, 4, 7, 10, 13, 14] },
  { key: 'traitre', split: 0.25, phrases: [0, 1, 2, 6, 12, 16, 15] } // il ment : il parle comme un gentil
];

/* ---------------- Utilitaires ---------------- */

const newId = (bytes) => crypto.randomBytes(bytes).toString('hex');
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function rollPot() {
  const total = POTS.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  let tier = POTS[0];
  for (const t of POTS) { if ((r -= t.weight) < 0) { tier = t; break; } }
  if (FORCE_TIER) tier = POTS.find((t) => t.key === FORCE_TIER) || tier;
  const amount = Math.round(randInt(tier.min, tier.max) / tier.step) * tier.step;
  return { tier: tier.key, label: tier.label, amount };
}

function shareRate(stats) {
  const total = stats.splits + stats.steals;
  return total ? Math.round((stats.splits / total) * 100) : null;
}

function cleanName(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

/* ---------------- Sauvegarde ---------------- */
// Postgres si DATABASE_URL est défini (obligatoire en ligne : le disque des hébergeurs gratuits
// est effacé à chaque redémarrage), sinon un simple fichier data.json pour jouer en local.

let db = { players: {} };
const pool = process.env.DATABASE_URL
  ? new (require('pg').Pool)({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 3
  })
  : null;
// La base gratuite se met en veille : une connexion inactive coupée ne doit pas faire planter le serveur.
if (pool) pool.on('error', (e) => console.error('Postgres (connexion inactive) :', e.message));
const savedJson = new Map(); // dernier état écrit en base, par joueur

async function loadDb() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await pool.query('SELECT data FROM players');
    for (const { data } of rows) { db.players[data.id] = data; savedJson.set(data.id, JSON.stringify(data)); }
    console.log(`Postgres : ${rows.length} joueurs chargés`);
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && typeof raw.players === 'object') db = raw;
  } catch (_) { /* premier lancement */ }
}

let saving = false;
async function flush() {
  if (saving) return;
  saving = true;
  try {
    if (pool) {
      for (const p of Object.values(db.players)) {
        if (!p.name) continue; // visiteur qui n'a jamais choisi de pseudo : rien à garder
        const json = JSON.stringify(p);
        if (savedJson.get(p.id) === json) continue;
        await pool.query(
          'INSERT INTO players (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
          [p.id, json]
        );
        savedJson.set(p.id, json);
      }
    } else {
      const tmp = DATA_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(db));
      await fs.promises.rename(tmp, DATA_FILE);
    }
  } catch (e) {
    console.error('Sauvegarde impossible (nouvel essai au prochain changement) :', e.message);
  } finally {
    saving = false;
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 2000);
}

const fortuneOf = (p) => p.coins + p.luxury.reduce((s, id) => s + (luxuryEntry(id)?.price || 0), 0);
function showcaseOf(p) { // la possession la plus chère, affichée à l'adversaire
  const best = p.luxury.map(luxuryEntry).filter(Boolean).sort((a, b) => b.price - a.price)[0];
  return best ? { emoji: best.emoji, name: best.name } : null;
}

function publicProfile(p) {
  return {
    id: p.id, name: p.name, coins: p.coins, luxury: p.luxury, fortune: fortuneOf(p),
    stats: p.stats, shareRate: shareRate(p.stats),
    owned: p.owned, equipped: p.equipped, look: cosmetics(p.equipped)
  };
}

// Met à niveau les comptes créés avec les versions précédentes.
function migrate(p) {
  if (!Array.isArray(p.owned)) p.owned = [...DEFAULT_OWNED];
  for (const id of DEFAULT_OWNED) if (!p.owned.includes(id)) p.owned.push(id);
  if (!p.equipped || typeof p.equipped !== 'object') p.equipped = { ...DEFAULT_EQUIPPED };
  for (const k of Object.keys(DEFAULT_EQUIPPED)) if (!p.equipped[k]) p.equipped[k] = DEFAULT_EQUIPPED[k];
  if (!Array.isArray(p.luxury)) p.luxury = [];
  if (Array.isArray(p.inventory)) { // ancienne version à objets : on rembourse leur valeur
    p.coins += p.inventory.reduce((s, it) => s + (Number(it.value) || 0), 0);
    delete p.inventory;
  }
  return p;
}

/* ---------------- État en mémoire ---------------- */

const online = new Map();        // playerId -> socket
const queue = [];                // joueurs en recherche
const queueTimers = new Map();   // playerId -> timeout (bot)
const rooms = new Map();         // code -> { host }
const hostRoom = new Map();      // playerId -> code
const matches = new Map();       // matchId -> match
const playerMatch = new Map();   // playerId -> matchId
const pendingDouble = new Map(); // playerId -> montant doublable (une seule fois, après une pub)

const socketOf = (pid) => online.get(pid) || null;
const matchOf = (pid) => matches.get(playerMatch.get(pid)) || null;
const sides = (m) => [m.a, m.bot ? m.bot.id : m.b];
const humans = (m) => (m.bot ? [m.a] : [m.a, m.b]);

function removeFromQueue(pid) {
  const i = queue.indexOf(pid);
  if (i >= 0) queue.splice(i, 1);
  clearTimeout(queueTimers.get(pid));
  queueTimers.delete(pid);
}
function closeRoom(pid) {
  const code = hostRoom.get(pid);
  if (code) { rooms.delete(code); hostRoom.delete(pid); }
}
function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => pick(chars)).join(''); } while (rooms.has(code));
  return code;
}

/* ---------------- Bots ---------------- */

function makeBot() {
  const type = pick(BOT_TYPES);
  const games = randInt(20, 200);
  const splits = Math.round(games * clamp(type.split + (Math.random() - 0.5) * 0.2, 0.05, 0.95));
  const look = {
    avatar: pick(SHOP.avatar.slice(0, 7)).label,
    title: pick(SHOP.title.slice(0, 6)).label,
    color: pick(SHOP.color.slice(0, 5)).value
  };
  const car = pick(LUXURY.filter((l) => l.price <= 1_500_000));
  return {
    id: 'bot_' + newId(4), name: pick(BOT_NAMES), type, games, splits, look,
    fortune: car.price + randInt(10, 900) * 1000, showcase: { emoji: car.emoji, name: car.name }, timers: []
  };
}

function clearBotTimers(m) {
  if (!m.bot) return;
  m.bot.timers.forEach(clearTimeout);
  m.bot.timers = [];
}

function scheduleBot(m) {
  const bot = m.bot;
  const total = ROUND_SECONDS * 1000;
  clearBotTimers(m);

  const talks = randInt(1, 3);
  for (let i = 0; i < talks; i++) {
    bot.timers.push(setTimeout(() => {
      if (m.state === 'talk') broadcastSay(m, bot.id, pick(bot.type.phrases));
    }, 1200 + Math.random() * total * 0.65));
  }

  // Plus le pot est gros, plus il est tenté de voler. Il regarde aussi ton taux de partage.
  const penalty = { petit: 0, gros: 0.05, enorme: 0.12, jackpot: 0.2, mega: 0.3 }[m.round.pot.tier];
  let p = bot.type.split - penalty;
  const human = db.players[m.a];
  const sr = human ? shareRate(human.stats) : null;
  if (sr !== null) p += (sr - 50) / 250;
  const choice = Math.random() < clamp(p, 0.05, 0.95) ? 'split' : 'steal';

  bot.timers.push(setTimeout(() => {
    if (m.state !== 'talk') return;
    m.round.choices[bot.id] = choice;
    socketOf(m.a)?.emit('opponentChose');
    checkBothChose(m);
  }, 2500 + Math.random() * total * 0.6));
}

/* ---------------- Déroulement d'un match ---------------- */

function opponentInfo(m, pid) {
  if (m.bot && pid === m.a) {
    const b = m.bot;
    return { name: b.name, ai: true, shareRate: Math.round((b.splits / b.games) * 100), games: b.games, look: b.look, fortune: b.fortune, showcase: b.showcase };
  }
  const otherId = pid === m.a ? m.b : m.a;
  const p = db.players[otherId];
  return { name: p.name, ai: false, shareRate: shareRate(p.stats), games: p.stats.games, look: cosmetics(p.equipped), fortune: fortuneOf(p), showcase: showcaseOf(p) };
}

function startMatch(a, b) {
  const m = {
    id: newId(6), a,
    b: typeof b === 'string' ? b : null,
    bot: typeof b === 'object' ? b : null,
    state: 'idle', round: null, timer: null, rematch: new Set(), sayCount: {}
  };
  matches.set(m.id, m);
  playerMatch.set(a, m.id);
  if (!m.bot) playerMatch.set(m.b, m.id);
  startRound(m);
}

function startRound(m) {
  clearTimeout(m.timer);
  m.state = 'talk';
  m.revealing = false;
  m.rematch.clear();
  m.sayCount = {};
  m.round = { pot: rollPot(), choices: {} };
  for (const pid of humans(m)) {
    pendingDouble.delete(pid);
    socketOf(pid)?.emit('round', {
      pot: m.round.pot,
      remainingMs: ROUND_SECONDS * 1000,
      opponent: opponentInfo(m, pid)
    });
  }
  m.timer = setTimeout(() => resolveRound(m), ROUND_SECONDS * 1000);
  if (m.bot) scheduleBot(m);
}

function checkBothChose(m) {
  if (m.state !== 'talk' || m.revealing) return;
  if (sides(m).every((id) => m.round.choices[id])) {
    m.revealing = true;
    clearTimeout(m.timer);
    m.timer = setTimeout(() => resolveRound(m), REVEAL_DELAY_MS);
  }
}

function broadcastSay(m, fromId, i) {
  for (const pid of humans(m)) socketOf(pid)?.emit('said', { mine: pid === fromId, i });
}

function resolveRound(m) {
  if (m.state !== 'talk') return;
  clearTimeout(m.timer);
  clearBotTimers(m);
  m.state = 'result';
  m.revealing = false;

  const { pot, choices } = m.round;
  const ids = sides(m);
  const c = ids.map((id) => choices[id] || 'split'); // pas de choix = partager
  const gains = {};
  let outcome;

  if (c[0] === 'split' && c[1] === 'split') {
    outcome = 'both_split';
    ids.forEach((id) => { gains[id] = Math.floor(pot.amount / 2); });
  } else if (c[0] === 'steal' && c[1] === 'steal') {
    outcome = 'both_steal';
    ids.forEach((id) => { gains[id] = 0; });
  } else {
    outcome = 'one_steal';
    ids.forEach((id, i) => { gains[id] = c[i] === 'steal' ? pot.amount : 0; });
  }

  ids.forEach((id, i) => {
    const p = db.players[id];
    if (!p) { m.bot.games++; if (c[i] === 'split') m.bot.splits++; return; }
    p.stats.games++;
    if (c[i] === 'split') p.stats.splits++; else p.stats.steals++;
    p.coins += gains[id];
    if (gains[id] > 0) pendingDouble.set(id, gains[id]);
    if (pot.tier === 'mega' && gains[id] > 0) p.stats.megas = (p.stats.megas || 0) + 1;
  });
  scheduleSave();

  ids.forEach((id, i) => {
    const p = db.players[id];
    if (!p) return;
    socketOf(id)?.emit('result', {
      outcome, pot,
      myChoice: c[i], theirChoice: c[1 - i],
      gain: gains[id], canDouble: gains[id] > 0,
      profile: publicProfile(p),
      opponent: opponentInfo(m, id)
    });
  });
}

function endMatch(m, leaverId) {
  if (!matches.has(m.id)) return;
  clearTimeout(m.timer);
  clearBotTimers(m);
  matches.delete(m.id);
  playerMatch.delete(m.a);
  if (!m.bot) playerMatch.delete(m.b);

  if (m.bot) return;
  const otherId = leaverId === m.a ? m.b : m.a;
  const other = db.players[otherId];
  let gift = 0;
  if (m.state === 'talk' && other) { // abandon pendant la manche : l'autre touche sa moitié
    gift = Math.floor(m.round.pot.amount / 2);
    other.coins += gift;
    scheduleSave();
  }
  socketOf(otherId)?.emit('opponentLeft', { gift, profile: other ? publicProfile(other) : null });
}

/* ---------------- Connexions ---------------- */

io.on('connection', (socket) => {
  const pid = () => socket.data.pid;
  const player = () => db.players[socket.data.pid];

  socket.on('hello', (d) => {
    let p = null;
    if (d && typeof d.id === 'string' && typeof d.token === 'string') {
      const found = db.players[d.id];
      if (found && found.token === d.token) p = found;
    }
    if (!p) {
      const id = newId(8);
      p = { id, token: newId(16), name: null, coins: 0, stats: { games: 0, splits: 0, steals: 0 }, createdAt: Date.now() };
      db.players[id] = p;
      scheduleSave();
    }
    migrate(p);
    const old = online.get(p.id);
    if (old && old.id !== socket.id) { old.emit('kicked'); old.disconnect(true); }
    socket.data.pid = p.id;
    online.set(p.id, socket);
    socket.emit('welcome', { id: p.id, token: p.token, profile: publicProfile(p), phrases: PHRASES, pots: POTS.map(({ key, label, weight }) => ({ key, label, weight })), online: online.size });
  });

  socket.on('setName', (raw) => {
    const p = player();
    if (!p) return;
    const name = cleanName(raw);
    if (name.length < 2) return socket.emit('nameError', 'Your name needs at least 2 characters (letters, numbers, space, _ or -).');
    p.name = name;
    scheduleSave();
    socket.emit('profile', publicProfile(p));
  });

  socket.on('findMatch', () => {
    const me = pid();
    if (!me || !player()?.name || playerMatch.has(me) || queue.includes(me)) return;
    closeRoom(me);
    const idx = queue.findIndex((q) => q !== me && online.has(q) && !playerMatch.has(q));
    if (idx >= 0) {
      const other = queue[idx];
      removeFromQueue(other);
      startMatch(other, me);
      return;
    }
    queue.push(me);
    socket.emit('searching');
    queueTimers.set(me, setTimeout(() => {
      removeFromQueue(me);
      if (online.has(me) && !playerMatch.has(me)) startMatch(me, makeBot());
    }, BOT_DELAY_MS));
  });

  socket.on('createRoom', () => {
    const me = pid();
    if (!me || !player()?.name || playerMatch.has(me)) return;
    removeFromQueue(me);
    closeRoom(me);
    const code = genCode();
    rooms.set(code, { host: me });
    hostRoom.set(me, code);
    socket.emit('roomCreated', { code });
  });

  socket.on('joinRoom', (raw) => {
    const me = pid();
    if (!me || !player()?.name || playerMatch.has(me)) return;
    const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const room = rooms.get(code);
    if (!room || room.host === me || !online.has(room.host) || playerMatch.has(room.host)) {
      return socket.emit('roomError', 'Room not found. Check the code with your friend.');
    }
    closeRoom(room.host);
    removeFromQueue(me);
    closeRoom(me);
    startMatch(room.host, me);
  });

  socket.on('cancel', () => {
    const me = pid();
    if (!me) return;
    removeFromQueue(me);
    closeRoom(me);
  });

  socket.on('say', (raw) => {
    const me = pid();
    const m = matchOf(me);
    if (!m || m.state !== 'talk') return;
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= PHRASES.length) return;
    if (PHRASES[i].pack && !player().owned.includes(PHRASES[i].pack)) return; // pack non acheté
    const now = Date.now();
    if (now - (socket.data.lastSay || 0) < 1200) return;
    m.sayCount[me] = (m.sayCount[me] || 0) + 1;
    if (m.sayCount[me] > 12) return;
    socket.data.lastSay = now;
    broadcastSay(m, me, i);
  });

  socket.on('choose', (choice) => {
    const me = pid();
    const m = matchOf(me);
    if (!m || m.state !== 'talk' || m.revealing) return;
    if (choice !== 'split' && choice !== 'steal') return;
    const first = !m.round.choices[me];
    m.round.choices[me] = choice;
    socket.emit('chosen', choice);
    if (first && !m.bot) socketOf(me === m.a ? m.b : m.a)?.emit('opponentChose');
    checkBothChose(m);
  });

  // Appelé par le client après une pub récompensée regardée en entier.
  // Une seule fois par manche gagnée. (Le SDK pub ne permet pas de vérification côté serveur :
  // acceptable ici car l'argent est virtuel.)
  socket.on('doubleGain', () => {
    const p = player();
    const amount = pendingDouble.get(pid());
    if (!p || !amount) return;
    pendingDouble.delete(pid());
    p.coins += amount;
    scheduleSave();
    socket.emit('doubled', { amount, profile: publicProfile(p) });
  });

  socket.on('rematch', () => {
    const me = pid();
    const m = matchOf(me);
    if (!m || m.state !== 'result') return;
    if (m.bot) return startRound(m);
    m.rematch.add(me);
    if (m.rematch.has(m.a) && m.rematch.has(m.b)) return startRound(m);
    socketOf(me === m.a ? m.b : m.a)?.emit('opponentWantsRematch');
  });

  socket.on('leaveMatch', () => {
    const me = pid();
    const m = matchOf(me);
    if (m) endMatch(m, me);
  });

  socket.on('shop', () => {
    if (!player()) return;
    socket.emit('shop', { catalog: SHOP, luxury: LUXURY, resellRate: RESELL_RATE });
  });

  socket.on('buy', (d) => {
    const p = player();
    if (!p || !d || typeof d.kind !== 'string' || typeof d.id !== 'string') return;
    if (d.kind === 'luxury') {
      const item = luxuryEntry(d.id);
      if (!item) return;
      if (p.luxury.includes(item.id)) return socket.emit('shopError', 'You already own this.');
      if (p.coins < item.price) return socket.emit('shopError', 'Not enough money.');
      p.coins -= item.price;
      p.luxury.push(item.id);
    } else {
      const entry = shopEntry(d.kind, d.id);
      if (!entry) return;
      if (p.owned.includes(entry.id)) return socket.emit('shopError', 'You already own this.');
      if (p.coins < entry.price) return socket.emit('shopError', 'Not enough money.');
      p.coins -= entry.price;
      p.owned.push(entry.id);
      if (d.kind in p.equipped) p.equipped[d.kind] = entry.id; // équipé directement
    }
    scheduleSave();
    socket.emit('profile', publicProfile(p));
    socket.emit('bought', d);
  });

  socket.on('resell', (id) => {
    const p = player();
    if (!p || typeof id !== 'string') return;
    const idx = p.luxury.indexOf(id);
    const item = luxuryEntry(id);
    if (idx < 0 || !item) return;
    p.luxury.splice(idx, 1);
    p.coins += Math.floor(item.price * RESELL_RATE);
    scheduleSave();
    socket.emit('profile', publicProfile(p));
  });

  socket.on('equip', (d) => {
    const p = player();
    if (!p || !d || !(d.kind in DEFAULT_EQUIPPED)) return;
    const entry = shopEntry(d.kind, d.id);
    if (!entry || !p.owned.includes(entry.id)) return;
    p.equipped[d.kind] = entry.id;
    scheduleSave();
    socket.emit('profile', publicProfile(p));
  });

  socket.on('leaderboard', () => {
    const top = Object.values(db.players)
      .filter((p) => p.name)
      .map((p) => ({ name: p.name, look: cosmetics(p.equipped), fortune: fortuneOf(p), showcase: showcaseOf(p), shareRate: shareRate(p.stats) }))
      .sort((a, b) => b.fortune - a.fortune)
      .slice(0, 10);
    socket.emit('leaderboard', top);
  });

  socket.on('disconnect', () => {
    const me = pid();
    if (!me || online.get(me) !== socket) return;
    online.delete(me);
    removeFromQueue(me);
    closeRoom(me);
    pendingDouble.delete(me);
    const m = matchOf(me);
    if (m) endMatch(m, me);
  });
});

setInterval(() => io.emit('online', online.size), 5000);

async function shutdown() {
  clearTimeout(saveTimer);
  await flush();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

loadDb()
  .then(() => {
    Object.values(db.players).forEach(migrate);
    server.listen(PORT, () => console.log(`Split or Steal: http://localhost:${PORT}`));
  })
  .catch((e) => { console.error('Impossible de charger la base :', e.message); process.exit(1); });
