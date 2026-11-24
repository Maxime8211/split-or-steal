'use strict';
/*
 * Prépare la version « portail » du jeu (CrazyGames, itch.io, Newgrounds…).
 * Usage : node build-portal.js https://ton-serveur.onrender.com
 * Résultat : dist/split-or-steal-portal.zip (index.html à la racine du zip, comme les portails le demandent).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const server = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^\s"'<>]+$/.test(server)) {
  console.error('Donne l’adresse https de ton serveur, par exemple :\n  node build-portal.js https://split-or-steal.onrender.com');
  process.exit(1);
}

const SRC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'dist');
const ZIP = path.join(OUT, 'split-or-steal-portal.zip');

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
    if (e.name.endsWith('.map')) return [];
    return [rel];
  });
}

// CRC32 pour le format zip
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function makeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, deflated);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10); cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(deflated.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

const entries = walk(SRC).map((rel) => {
  let data = fs.readFileSync(path.join(SRC, rel));
  if (rel === 'config.js') data = Buffer.from(`window.GAME_CONFIG = { server: ${JSON.stringify(server)}, ads: ${process.argv.includes('--ads')} };\n`);
  return { name: rel, data };
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(ZIP, makeZip(entries));
console.log(`OK : ${path.relative(__dirname, ZIP)} (${entries.length} fichiers, serveur ${server})`);
