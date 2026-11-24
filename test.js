'use strict';
// Test de bout en bout : lance le serveur avec des délais courts et simule des joueurs.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3999;
const DATA = path.join(os.tmpdir(), 'pov-test-' + Date.now() + '.json');
const URL = 'http://localhost:' + PORT;
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});
const silent = (s, ev, ms = 400) => new Promise((res) => {
  let got = false; const h = () => { got = true; };
  s.once(ev, h); setTimeout(() => { s.off(ev, h); res(!got); }, ms);
});

async function client(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  await once(s, 'connect');
  s.emit('hello', {});
  const w = await once(s, 'welcome');
  s.emit('setName', name);
  const p = await once(s, 'profile');
  return { s, w, p };
}
async function room(A, B) {
  A.s.emit('createRoom');
  const { code } = await once(A.s, 'roomCreated');
  const rA = once(A.s, 'round'), rB = once(B.s, 'round');
  B.s.emit('joinRoom', code.toLowerCase());
  const [roundA] = await Promise.all([rA, rB]);
  return { code, roundA };
}
async function rematch(A, B) {
  const rA = once(A.s, 'round'), rB = once(B.s, 'round');
  A.s.emit('rematch'); B.s.emit('rematch');
  const [r] = await Promise.all([rA, rB]);
  return r;
}

(async () => {
  // Comptes pré-enregistrés : un riche, et un ancien compte de la version « objets »
  fs.writeFileSync(DATA, JSON.stringify({ players: {
    rich: { id: 'rich', token: 'tok', name: 'Riche', coins: 30_000_000, stats: { games: 0, splits: 0, steals: 0 } },
    old: { id: 'old', token: 'tok2', name: 'Ancien', coins: 100, inventory: [{ uid: 'x', value: 50 }, { uid: 'y', value: 25 }], stats: { games: 0, splits: 0, steals: 0 } }
  } }));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT, DATA_FILE: DATA, ROUND_SECONDS: '4', BOT_DELAY_MS: '600', REVEAL_DELAY_MS: '200' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((r) => srv.stdout.once('data', r));

  try {
    console.log('1. Profil');
    const A = await client('Alice');
    ok(A.p.name === 'Alice' && A.p.coins === 0 && A.p.fortune === 0, 'profil créé, 0 $ au départ');
    ok(A.w.pots.length === 5 && A.w.pots.find((p) => p.key === 'mega').weight === 1, 'méga jackpot à 1 %');
    A.s.emit('setName', '<b>x</b>');
    ok((await once(A.s, 'profile')).name === 'bxb', 'pseudo nettoyé (pas de HTML)');
    A.s.emit('setName', 'Alice'); await once(A.s, 'profile');

    console.log('2. Un vole, l’autre partage');
    const B = await client('Bob');
    const { roundA } = await room(A, B);
    ok(roundA.pot.amount >= 1000 && typeof roundA.pot.tier === 'string', 'pot d’argent au milieu : ' + roundA.pot.amount + ' $ (' + roundA.pot.label + ')');
    const saidB = once(B.s, 'said');
    A.s.emit('say', 0);
    ok((await saidB).i === 0, 'phrase prédéfinie transmise');
    const chose = once(B.s, 'opponentChose');
    A.s.emit('choose', 'steal'); await chose;
    B.s.emit('choose', 'split');
    const [resA, resB] = await Promise.all([once(A.s, 'result'), once(B.s, 'result')]);
    ok(resA.gain === roundA.pot.amount && resA.profile.coins === roundA.pot.amount, 'Alice prend tout le pot');
    ok(resB.gain === 0 && !resB.canDouble, 'Bob ne gagne rien et ne peut pas doubler');

    console.log('3. Pub pour doubler');
    ok(resA.canDouble, 'Alice peut doubler');
    A.s.emit('doubleGain');
    const dbl = await once(A.s, 'doubled');
    ok(dbl.amount === roundA.pot.amount && dbl.profile.coins === roundA.pot.amount * 2, 'gains doublés');
    A.s.emit('doubleGain');
    ok(await silent(A.s, 'doubled'), 'impossible de doubler deux fois');
    B.s.emit('doubleGain');
    ok(await silent(B.s, 'doubled'), 'impossible de doubler sans avoir gagné');

    console.log('4. Les deux partagent');
    const r2 = await rematch(A, B);
    const coinsA = dbl.profile.coins;
    A.s.emit('choose', 'split'); B.s.emit('choose', 'split');
    const [r2A, r2B] = await Promise.all([once(A.s, 'result'), once(B.s, 'result')]);
    const half = Math.floor(r2.pot.amount / 2);
    ok(r2A.gain === half && r2B.gain === half && r2A.profile.coins === coinsA + half, 'chacun prend la moitié (' + half + ' $)');

    console.log('5. Les deux volent');
    await rematch(A, B);
    A.s.emit('choose', 'steal'); B.s.emit('choose', 'steal');
    const r3 = await once(A.s, 'result');
    ok(r3.outcome === 'both_steal' && r3.gain === 0, 'personne ne gagne rien');

    console.log('6. Temps écoulé sans choix = partager');
    await rematch(A, B);
    const r4 = await once(A.s, 'result', 7000);
    ok(r4.outcome === 'both_split', 'résolu automatiquement à la fin du chrono');

    console.log('7. Abandon pendant une manche');
    const r5 = await rematch(A, B);
    const left = once(B.s, 'opponentLeft');
    A.s.emit('leaveMatch');
    const lb = await left;
    ok(lb.gift === Math.floor(r5.pot.amount / 2), 'Bob touche sa moitié du pot');

    console.log('8. Recherche en ligne → bot si personne');
    const C = await client('Chloé');
    C.s.emit('findMatch');
    await once(C.s, 'searching');
    const rc = await once(C.s, 'round', 3000);
    ok(rc.opponent.ai === true && rc.opponent.fortune > 0, 'un joueur IA prend la place (' + rc.opponent.name + ', ' + rc.opponent.fortune + ' $)');
    C.s.emit('choose', 'split');
    const resC = await once(C.s, 'result', 7000);
    ok(['both_split', 'one_steal'].includes(resC.outcome), 'le bot joue sa manche (' + resC.outcome + ')');

    console.log('9. Deux joueurs en recherche sont mis ensemble');
    C.s.emit('leaveMatch');
    const D = await client('Dylan');
    const rcD = once(D.s, 'round'), rcC = once(C.s, 'round');
    C.s.emit('findMatch'); await wait(100); D.s.emit('findMatch');
    const [mD] = await Promise.all([rcD, rcC]);
    ok(mD.opponent.name === 'Chloé' && !mD.opponent.ai, 'match humain via la file d’attente');

    console.log('10. Reconnexion');
    const s2 = io(URL, { transports: ['websocket'], forceNew: true });
    await once(s2, 'connect');
    s2.emit('hello', { id: A.w.id, token: A.w.token });
    const w2 = await once(s2, 'welcome');
    ok(w2.profile.name === 'Alice' && w2.profile.coins === r4.profile.coins, 'argent et pseudo retrouvés');
    s2.emit('hello', { id: A.w.id, token: 'faux' });
    ok((await once(s2, 'welcome')).id !== A.w.id, 'un mauvais token ne donne pas accès au compte');

    console.log('11. Ancien compte (version objets)');
    const O = io(URL, { transports: ['websocket'], forceNew: true });
    await once(O, 'connect');
    O.emit('hello', { id: 'old', token: 'tok2' });
    const wo = await once(O, 'welcome');
    ok(wo.profile.coins === 175 && !('inventory' in wo.profile), 'objets remboursés en argent (100 + 75 = 175 $)');
    O.close();

    console.log('12. Boutique de luxe');
    const R = io(URL, { transports: ['websocket'], forceNew: true });
    await once(R, 'connect');
    R.emit('hello', { id: 'rich', token: 'tok' });
    const wr = await once(R, 'welcome');
    R.emit('shop');
    const shop = await once(R, 'shop');
    ok(shop.luxury.some((l) => l.id === 'l_yacht') && shop.luxury.some((l) => l.id === 'l_villa'), 'voitures, yachts, villas au catalogue');
    R.emit('buy', { kind: 'luxury', id: 'l_villa' });
    const pv = await once(R, 'profile');
    ok(pv.coins === 25_000_000 && pv.luxury.includes('l_villa') && pv.fortune === 30_000_000, 'villa achetée, la fortune compte sa valeur');
    R.emit('buy', { kind: 'luxury', id: 'l_villa' });
    ok((await once(R, 'shopError')).includes('already'), 'pas de double achat');
    R.emit('buy', { kind: 'luxury', id: 'l_ile' });
    ok((await once(R, 'shopError')).includes('Not enough'), 'île privée refusée sans assez d’argent');
    R.emit('resell', 'l_villa');
    const pr = await once(R, 'profile');
    ok(pr.coins === 27_500_000 && !pr.luxury.includes('l_villa'), 'revente à 50 %');
    R.emit('buy', { kind: 'luxury', id: 'l_jet' }); await once(R, 'profile');
    R.emit('buy', { kind: 'avatar', id: 'a_crown' });
    const pc = await once(R, 'profile');
    ok(pc.look.avatar === '👑', 'avatar acheté et équipé');

    console.log('13. Ce que voit l’adversaire');
    const E = await client('Emma');
    R.emit('createRoom');
    const rc2 = await once(R, 'roomCreated');
    const rr = once(R, 'round'), re = once(E.s, 'round');
    E.s.emit('joinRoom', rc2.code);
    const [, eRound] = await Promise.all([rr, re]);
    ok(eRound.opponent.showcase && eRound.opponent.showcase.name === 'Private jet', 'possession la plus chère affichée (jet privé)');
    ok(eRound.opponent.fortune === pc.fortune && eRound.opponent.look.avatar === '👑', 'fortune et look visibles');

    console.log('14. Packs de phrases');
    const packIdx = wr.phrases.findIndex((ph) => ph.pack === 'p_provoc');
    E.s.emit('say', packIdx);
    ok(await silent(R, 'said'), 'phrase d’un pack non acheté refusée');

    console.log('15. Classement');
    R.emit('leaderboard');
    const top = await once(R, 'leaderboard');
    ok(top[0].name === 'Riche' && top[0].fortune >= top[1].fortune, 'trié par fortune (argent + possessions)');

    [A, B, C, D, E].forEach((c) => c.s.close()); s2.close(); R.close();
  } catch (e) {
    console.error('Erreur :', e.message); failures++;
  } finally {
    srv.kill('SIGTERM');
    await wait(300);
    try { fs.unlinkSync(DATA); } catch (_) {}
    console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent.');
    process.exit(failures ? 1 : 0);
  }
})();
