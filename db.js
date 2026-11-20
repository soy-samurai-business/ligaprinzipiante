import mysql from 'mysql2/promise';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { holesOfNine, playingHandicap, playOrder, strokesReceived } from './scoring.js';

const here = dirname(fileURLToPath(import.meta.url));

export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'liga',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'liga_dev',
  charset: 'utf8mb4',
  timezone: 'Z',             // DATETIME en UTC
  dateStrings: ['DATE'],     // fechas (jornadas, nacimiento) como 'AAAA-MM-DD'
  decimalNumbers: true,      // hándicap como número
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL || 8),
  enableKeepAlive: true,
});
pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

export async function q(sql, params = [], conn = pool) { const [rows] = await conn.query(sql, params); return rows; }
export async function one(sql, params = [], conn = pool) { return (await q(sql, params, conn))[0] || null; }
export async function run(sql, params = [], conn = pool) { const [res] = await conn.query(sql, params); return res; }

export async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}

export function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

const DEFAULT_SETTINGS = {
  league_name: 'Liga de Golf Baviera', course_name: 'Baviera Golf', season: '2026',
  best_cards: '8', allowance: '100', pace_minutes: '130',
  feature_live: '0', feature_shop: '0',
  legal_name: '', legal_cif: '', legal_address: '', legal_email: '',
};

export async function getSettings() {
  const rows = await q('SELECT setting_key, setting_value FROM settings');
  const s = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value])) };
  return {
    ...s,
    best_cards: Number(s.best_cards), allowance: Number(s.allowance), pace_minutes: Number(s.pace_minutes),
    feature_live: s.feature_live === '1', feature_shop: s.feature_shop === '1',
  };
}

export async function getCourse(conn = pool) {
  return Object.fromEntries((await q('SELECT hole, par, si, meters FROM course_holes', [], conn)).map((h) => [h.hole, { ...h }]));
}

// Crea las tablas (si faltan) y los datos iniciales en una base de datos vacía.
export async function initDb({ demo = process.env.SEED_DEMO === 'true' } = {}) {
  const ddl = readFileSync(join(here, 'sql', 'schema.sql'), 'utf8').replace(/^--.*$/gm, '');
  for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) await run(stmt);
  if (!(await one('SELECT 1 AS x FROM settings LIMIT 1'))) {
    await seedBase();
    if (demo) await seedDemo();
  }
  if (!(await one(`SELECT 1 AS x FROM users WHERE role = 'admin' LIMIT 1`))) await createAdminFromEnv();
}

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// Crea partidas (grupos), asigna tee de salida, hora y marcador a partir de los inscritos.
export async function generateGroups(roundId, { mode = 'tee', interval = 10, size = 4, order = 'random' } = {}) {
  const round = await one('SELECT * FROM rounds WHERE id = ?', [roundId]);
  const { allowance } = await getSettings();
  const players = await q(`SELECT u.id, u.handicap FROM entries e JOIN users u ON u.id = e.user_id
    WHERE e.round_id = ? AND u.status = 'active'`, [roundId]);
  if (!players.length) throw new Error('No hay jugadores inscritos en esta jornada');

  if (order === 'handicap') players.sort((a, b) => a.handicap - b.handicap);
  else for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  const nGroups = Math.ceil(players.length / size);
  const holes = holesOfNine(round.nine);
  if (mode === 'shotgun' && nGroups > holes.length * 2) throw new Error('Demasiadas partidas para salida a tiro');
  const buckets = Array.from({ length: nGroups }, () => []);
  players.forEach((p, i) => buckets[Math.floor((i * nGroups) / players.length)].push(p));

  await tx(async (c) => {
    await run('DELETE FROM cards WHERE round_id = ?', [roundId], c);
    await run('DELETE FROM tee_groups WHERE round_id = ?', [roundId], c);
    for (const [gi, members] of buckets.entries()) {
      const shotgun = mode === 'shotgun';
      const startHole = shotgun ? holes[gi % holes.length] : holes[0];
      const tee = shotgun ? round.first_tee : addMinutes(round.first_tee, gi * interval);
      const { insertId: gid } = await run('INSERT INTO tee_groups (round_id, number, start_hole, tee_time) VALUES (?, ?, ?, ?)',
        [roundId, gi + 1, startHole, tee], c);
      for (const [j, p] of members.entries()) {
        const marker = members.length > 1 ? members[(j + 1) % members.length].id : null;
        await run(`INSERT INTO cards (round_id, user_id, group_id, marker_id, handicap, playing_hcp) VALUES (?, ?, ?, ?, ?, ?)`,
          [roundId, p.id, gid, marker, p.handicap, playingHandicap(p.handicap, allowance)], c);
      }
    }
  });
}

// ---------- Datos iniciales ----------

async function seedBase() {
  await tx(async (c) => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [k, v], c);
    // Campo: valores provisionales a sustituir por la tarjeta oficial desde el panel del comité.
    const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4];
    const sis = [7, 3, 15, 1, 11, 5, 17, 9, 13, 8, 18, 2, 12, 4, 10, 16, 6, 14];
    const meters = [345, 380, 152, 470, 320, 365, 138, 455, 305, 352, 165, 488, 312, 390, 334, 148, 462, 330];
    for (let i = 0; i < 18; i++) await run('INSERT INTO course_holes (hole, par, si, meters) VALUES (?, ?, ?, ?)', [i + 1, pars[i], sis[i], meters[i]], c);
    // 10 jornadas quincenales en sábado (el comité ajusta las fechas desde el panel).
    const d = new Date(); d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7) + 7);
    for (let n = 1; n <= 10; n++) {
      await run(`INSERT INTO rounds (number, date, nine) VALUES (?, ?, ?)`, [n, d.toISOString().slice(0, 10), n % 2 ? 'front' : 'back'], c);
      d.setUTCDate(d.getUTCDate() + 14);
    }
    const prod = 'INSERT INTO products (name, description, price_cents, color, accent, stock) VALUES (?, ?, ?, ?, ?, ?)';
    await run(prod, ['Polo técnico Liga 2026', 'Polo transpirable de secado rápido con el escudo de la liga bordado en el pecho.', 3900, '#1f8a4c', '#ffffff', 40], c);
    await run(prod, ['Polo técnico Blanco', 'Versión blanca del polo oficial. Ribete verde en cuello y mangas.', 3900, '#f7f8f5', '#1f8a4c', 40], c);
    await run(prod, ['Camiseta Baviera Classic', 'Camiseta de algodón orgánico, corte relajado, para después de la jornada.', 2500, '#e6f2e9', '#17663a', 60], c);
  });
}

async function createAdminFromEnv() {
  const email = process.env.ADMIN_EMAIL || 'comite@liga.local';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = randomBytes(9).toString('base64url');
    console.log(`\n  Cuenta del comité creada: ${email}\n  Contraseña generada: ${password}\n  Cámbiala al entrar (Mi ficha → Cambiar contraseña).\n`);
  }
  await run(`INSERT INTO users (email, pass_hash, first_name, last_name, name, handicap, role, status, activated_at)
    VALUES (?, ?, 'Comité', 'de la Liga', 'Comité de la Liga', 0, 'admin', 'active', ?)`, [email, hashPassword(password), new Date()]);
}

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Datos de demostración (solo SEED_DEMO=true): 12 jugadores ficticios y 3 jornadas jugadas.
async function seedDemo() {
  const rand = rng(2026);
  const names = [['Carlos', 'Martín'], ['Lucía', 'Fernández'], ['Javier', 'Ruiz'], ['Marta', 'Gómez'], ['Andrés', 'Navarro'], ['Elena', 'Torres'],
    ['Pablo', 'Serrano'], ['Isabel', 'Moreno'], ['Diego', 'Castillo'], ['Raquel', 'Ortega'], ['Sergio', 'Molina'], ['Nuria', 'Delgado']];
  const hcps = [12.4, 18.2, 6.8, 24.5, 15.1, 9.7, 28.3, 21.0, 4.2, 16.6, 11.3, 31.8];
  const sizes = ['L', 'S', 'XL', 'M', 'L', 'M', 'XXL', 'S', 'L', 'M', 'XL', 'M'];
  const pw = hashPassword('golf123');
  const ids = [];
  for (const [i, [f, l]] of names.entries()) {
    const r = await run(`INSERT INTO users (email, pass_hash, first_name, last_name, name, phone, licence, birth_date, handicap, shirt_size, status, consent_notifications, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`,
    [`jugador${i + 1}@liga.test`, pw, f, l, `${f} ${l}`, `600 00 0${String(i).padStart(2, '0')}`, `AM${48210 + i * 37}`, `19${70 + i}-0${(i % 9) + 1}-15`, hcps[i], sizes[i], new Date()]);
    ids.push(r.insertId);
  }
  // Las 3 primeras jornadas, ya jugadas, en fechas pasadas.
  const rounds = await q('SELECT * FROM rounds ORDER BY number LIMIT 3');
  const course = await getCourse();
  for (const [k, r] of rounds.entries()) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - (3 - k) * 14);
    await run(`UPDATE rounds SET date = ?, status = 'closed' WHERE id = ?`, [d.toISOString().slice(0, 10), r.id]);
    for (const id of ids) if (rand() > 0.12 || id === ids[0]) await run('INSERT INTO entries (round_id, user_id) VALUES (?, ?)', [r.id, id]);
    await generateGroups(r.id);
    const groups = await q('SELECT * FROM tee_groups WHERE round_id = ?', [r.id]);
    for (const g of groups) {
      const start = new Date(d.getTime() - 3 * 3600000);
      const end = new Date(start.getTime() + 125 * 60000);
      await run('UPDATE tee_groups SET started_at = ?, finished_at = ? WHERE id = ?', [start, end, g.id]);
      const order = playOrder(r.nine, g.start_hole);
      for (const c of await q('SELECT * FROM cards WHERE group_id = ?', [g.id])) {
        const recv = strokesReceived(c.playing_hcp, order.map((h) => course[h]));
        for (const [n, h] of order.entries()) {
          const noise = (rand() + rand() + rand() - 1.5) * 1.3;
          const strokes = Math.max(2, Math.min(course[h].par + 5, Math.round(course[h].par + recv[h] + noise + 0.2)));
          await run('INSERT INTO scores (card_id, hole, strokes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
            [c.id, h, strokes, c.marker_id, new Date(start.getTime() + (n + 1) * 14 * 60000)]);
        }
        await run(`UPDATE cards SET status = 'validated', player_signed_at = ?, marker_signed_at = ?, validated_at = ? WHERE id = ?`, [end, end, end, c.id]);
      }
    }
  }
}

// node db.js --reset [--demo]: borra todas las tablas y las vuelve a crear (solo para desarrollo).
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--reset')) {
  if (process.env.NODE_ENV === 'production') { console.error('No se permite --reset en producción'); process.exit(1); }
  const conn = await pool.getConnection();
  const tables = (await q('SHOW TABLES', [], conn)).map((r) => Object.values(r)[0]);
  await run('SET FOREIGN_KEY_CHECKS = 0', [], conn);
  for (const t of tables) await run(`DROP TABLE \`${t}\``, [], conn);
  await run('SET FOREIGN_KEY_CHECKS = 1', [], conn);
  conn.release();
  await initDb({ demo: process.argv.includes('--demo') });
  console.log(`Base de datos ${process.env.DB_NAME || 'liga_dev'} recreada${process.argv.includes('--demo') ? ' con datos de ejemplo' : ''}.`);
  await pool.end();
}
