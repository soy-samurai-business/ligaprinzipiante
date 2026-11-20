import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, one, run, tx, initDb, hashPassword, checkPassword, getSettings, getCourse, generateGroups } from './db.js';
import { computeCard, bestOf, playOrder } from './scoring.js';
import { sendMail, verifyMail, activationEmail, resetEmail, adminNewPlayerEmail } from './mailer.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// PUBLIC_URL: URL(s) públicas separadas por comas. La primera se usa en los enlaces de los correos.
const PUBLIC_URLS = String(process.env.PUBLIC_URL || '').split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
const PUBLIC_HOSTS = PUBLIC_URLS.map((u) => { try { return new URL(u).host; } catch { return null; } }).filter(Boolean);
const ADMIN_NOTIFY = String(process.env.ADMIN_NOTIFY_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
const PRIVACY_VERSION = '2026-11';
const TOKEN_HOURS = 72;
const SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const STATUS_ES = { pending: 'Pendiente de contraseña', active: 'Activo', disabled: 'Baja' };
const now = () => new Date();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------- Utilidades HTTP ----------

class HttpError extends Error { constructor(status, msg, fields) { super(msg); this.status = status; this.fields = fields; } }
const fail = (status, msg, fields) => { throw new HttpError(status, msg, fields); };

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, 'El envío es demasiado grande'); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'JSON no válido'); }
}

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const baseUrl = (req) => PUBLIC_URLS[0] || `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

async function currentUser(req) {
  const sid = cookies(req).sid;
  if (!sid || sid.length !== 48) return null;
  return one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'`, [sid, Date.now()]);
}

const publicUser = (u) => u && ({ id: u.id, name: u.name, first_name: u.first_name, last_name: u.last_name, email: u.email,
  phone: u.phone, licence: u.licence, birth_date: u.birth_date, handicap: u.handicap, role: u.role, shirt_size: u.shirt_size,
  instagram: u.instagram, bio: u.bio, consent_notifications: !!u.consent_notifications, consent_image: !!u.consent_image });

function requireUser(ctx) { if (!ctx.user) fail(401, 'Inicia sesión para continuar'); return ctx.user; }
function requireAdmin(ctx) { requireUser(ctx); if (ctx.user.role !== 'admin') fail(403, 'Solo el comité puede hacer esto'); return ctx.user; }
async function requireFeature(ctx, key) {
  const s = await getSettings();
  if (!s[key] && ctx.user?.role !== 'admin') fail(404, 'Esta sección todavía no está disponible');
}

async function audit(userId, action, detail) {
  await run('INSERT INTO audit (user_id, action, detail) VALUES (?, ?, ?)', [userId, action, JSON.stringify(detail)]);
}

// Límite de peticiones por IP (registro, inicio de sesión, recuperación de contraseña).
const buckets = new Map();
function limit(req, name, max, windowMin) {
  const key = `${name}:${clientIp(req)}`;
  const b = buckets.get(key);
  if (!b || b.until < Date.now()) { buckets.set(key, { n: 1, until: Date.now() + windowMin * 60000 }); return; }
  if (++b.n > max) fail(429, 'Demasiados intentos. Prueba de nuevo dentro de unos minutos.');
}
setInterval(() => { for (const [k, b] of buckets) if (b.until < Date.now()) buckets.delete(k); }, 600000).unref();

// ---------- Tiempo real (Server-Sent Events) ----------

const streams = new Set();
function broadcast(type, payload = {}) {
  const msg = `data: ${JSON.stringify({ type, ...payload, at: Date.now() })}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => broadcast('ping'), 20000).unref();

// ---------- Dominio ----------

// Calcula varias tarjetas con pocas consultas (clasificaciones con cientos de tarjetas).
async function cardViews(cards) {
  if (!cards.length) return [];
  const course = await getCourse();
  const ids = cards.map((c) => c.id);
  const roundIds = [...new Set(cards.map((c) => c.round_id))];
  const groupIds = [...new Set(cards.map((c) => c.group_id).filter(Boolean))];
  const userIds = [...new Set(cards.flatMap((c) => [c.user_id, c.marker_id]).filter(Boolean))];
  const [rounds, groups, scores, users] = await Promise.all([
    q('SELECT * FROM rounds WHERE id IN (?)', [roundIds]),
    groupIds.length ? q('SELECT * FROM tee_groups WHERE id IN (?)', [groupIds]) : [],
    q('SELECT card_id, hole, strokes FROM scores WHERE card_id IN (?)', [ids]),
    q('SELECT id, name FROM users WHERE id IN (?)', [userIds]),
  ]);
  const R = new Map(rounds.map((r) => [r.id, r]));
  const G = new Map(groups.map((g) => [g.id, g]));
  const U = new Map(users.map((u) => [u.id, u]));
  const S = new Map();
  for (const s of scores) { if (!S.has(s.card_id)) S.set(s.card_id, {}); S.get(s.card_id)[s.hole] = s.strokes; }
  return cards.map((card) => {
    const round = R.get(card.round_id);
    const group = card.group_id ? G.get(card.group_id) : null;
    const startHole = group?.start_hole ?? playOrder(round.nine, 0)[0];
    const calc = computeCard({ nine: round.nine, startHole, playingHcp: card.playing_hcp }, course, S.get(card.id) || {});
    return { id: card.id, round: { id: round.id, number: round.number, date: round.date, nine: round.nine, status: round.status },
      group: group && { id: group.id, number: group.number, start_hole: group.start_hole, tee_time: group.tee_time, started_at: group.started_at, finished_at: group.finished_at },
      player: U.get(card.user_id) || { id: card.user_id, name: '—' }, marker: card.marker_id ? U.get(card.marker_id) || null : null,
      handicap: card.handicap, playing_hcp: card.playing_hcp, status: card.status,
      player_signed_at: card.player_signed_at, marker_signed_at: card.marker_signed_at, validated_at: card.validated_at, ...calc };
  });
}
const cardView = async (card) => (await cardViews([card]))[0];

function rankRows(rows, keyFn) {
  let pos = 0, prev = null;
  rows.forEach((r, i) => { const k = keyFn(r); if (k !== prev) pos = i + 1; prev = k; r.pos = pos; });
  return rows;
}

async function roundLeaderboard(roundId, live) {
  const cards = await cardViews(await q('SELECT * FROM cards WHERE round_id = ?', [roundId]));
  const rows = cards.filter((c) => (live ? c.thru > 0 || c.status === 'validated' : c.status === 'validated'))
    .map((c) => ({ card_id: c.id, user_id: c.player.id, name: c.player.name, handicap: c.handicap, playing_hcp: c.playing_hcp,
      status: c.status, points: c.points, gross: c.gross, toPar: c.toPar, thru: c.thru, group: c.group?.number }));
  rows.sort((a, b) => b.points - a.points || a.gross - b.gross || b.thru - a.thru);
  return rankRows(rows, (r) => `${r.points}|${r.gross}`);
}

async function standings() {
  const { best_cards } = await getSettings();
  const rounds = await q('SELECT id, number, status FROM rounds ORDER BY number');
  const users = await q(`SELECT id, name, handicap FROM users WHERE role = 'player' AND status = 'active'`);
  const validated = await cardViews(await q(`SELECT * FROM cards WHERE status = 'validated'`));
  const rows = users.map((u) => {
    const mine = validated.filter((c) => c.player.id === u.id).map((c) => ({ roundId: c.round.id, points: c.points, gross: c.gross }));
    const b = bestOf(mine, best_cards);
    const byRound = Object.fromEntries(mine.map((m) => [m.roundId, { points: m.points, counted: b.counted.has(m.roundId) }]));
    return { user_id: u.id, name: u.name, handicap: u.handicap, total: b.total, played: b.played, best: b.best, all: b.all, byRound };
  }).filter((r) => r.played > 0);
  rows.sort((a, b) => b.total - a.total || b.best - a.best || b.all - a.all);
  return { rounds, best_cards, rows: rankRows(rows, (r) => `${r.total}|${r.best}|${r.all}`) };
}

const loadCard = async (id) => (await one('SELECT * FROM cards WHERE id = ?', [Number(id)])) || fail(404, 'Tarjeta no encontrada');
const loadRound = async (id) => (await one('SELECT * FROM rounds WHERE id = ?', [Number(id)])) || fail(404, 'Jornada no encontrada');

async function inSameGroup(user, card) {
  if (!card.group_id) return false;
  return !!(await one('SELECT 1 AS x FROM cards WHERE group_id = ? AND user_id = ?', [card.group_id, user.id]));
}

async function startGroup(groupId, conn = pool) {
  const g = await one('SELECT started_at FROM tee_groups WHERE id = ?', [groupId], conn);
  if (g.started_at) return;
  await run('UPDATE tee_groups SET started_at = ? WHERE id = ?', [now(), groupId], conn);
  await run(`UPDATE cards SET status = 'playing' WHERE group_id = ? AND status = 'pending'`, [groupId], conn);
}

async function refreshGroupFinish(groupId) {
  if (!groupId) return;
  const cards = await cardViews(await q('SELECT * FROM cards WHERE group_id = ?', [groupId]));
  if (cards.every((c) => c.complete)) await run('UPDATE tee_groups SET finished_at = COALESCE(finished_at, ?) WHERE id = ?', [now(), groupId]);
  else await run('UPDATE tee_groups SET finished_at = NULL WHERE id = ?', [groupId]);
}

// ---------- Registro: validación ----------

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ageOn = (birth, ref = new Date()) => {
  const b = new Date(`${birth}T12:00:00Z`);
  let a = ref.getUTCFullYear() - b.getUTCFullYear();
  const m = ref.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < b.getUTCDate())) a--;
  return a;
};
const normInstagram = (v) => String(v || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');

// Valida la foto (data URL en base64), comprueba el formato real por sus primeros bytes y devuelve { mime, data }.
function parsePhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 1000 || buf.length > 3 * 1024 * 1024) return null;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  const mime = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : null;
  return mime ? { mime, data: buf } : null;
}

function validatePlayerData(b, { requirePhoto }) {
  const f = {};
  const d = {
    first_name: clean(b.first_name, 100), last_name: clean(b.last_name, 150),
    email: clean(b.email, 190).toLowerCase(), phone: clean(b.phone, 30),
    licence: clean(b.licence, 30).toUpperCase().replace(/\s/g, ''), birth_date: clean(b.birth_date, 10),
    handicap: Number(String(b.handicap ?? '').replace(',', '.')), shirt_size: clean(b.shirt_size, 5).toUpperCase(),
    instagram: normInstagram(b.instagram).slice(0, 30),
  };
  if (d.first_name.length < 2) f.first_name = 'Escribe tu nombre';
  if (d.last_name.length < 2) f.last_name = 'Escribe tus apellidos';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) f.email = 'Email no válido';
  if ((d.phone.match(/\d/g) || []).length < 9 || !/^[+\d\s().-]+$/.test(d.phone)) f.phone = 'Teléfono no válido';
  if (!/^[A-Z0-9-]{4,20}$/.test(d.licence)) f.licence = 'Número de licencia no válido';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.birth_date) || Number.isNaN(Date.parse(d.birth_date))) f.birth_date = 'Fecha no válida';
  else { const a = ageOn(d.birth_date); if (a < 4 || a > 100) f.birth_date = 'Revisa la fecha de nacimiento'; }
  if (!Number.isFinite(d.handicap) || d.handicap < -10 || d.handicap > 54) f.handicap = 'Hándicap entre -10 y 54';
  else d.handicap = Math.round(d.handicap * 10) / 10;
  if (!SHIRT_SIZES.includes(d.shirt_size)) f.shirt_size = 'Elige una talla';
  if (d.instagram && !/^[A-Za-z0-9._]{1,30}$/.test(d.instagram)) f.instagram = 'Usuario de Instagram no válido';
  if (requirePhoto) {
    d.photo = parsePhoto(b.photo);
    if (!d.photo) f.photo = 'Añade una fotografía (JPG, PNG o WebP, máx. 3 MB)';
  }
  return { d, f };
}

async function createToken(userId, purpose, conn = pool) {
  const raw = randomBytes(32).toString('base64url');
  await run('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [now(), userId], conn);
  await run('INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)',
    [userId, sha256(raw), purpose, new Date(Date.now() + TOKEN_HOURS * 3600000)], conn);
  return raw;
}

async function sendAccessEmail(req, user, purpose) {
  const { league_name } = await getSettings();
  const token = await createToken(user.id, purpose);
  const link = `${baseUrl(req)}/#/clave/${token}`;
  const mail = (purpose === 'activate' ? activationEmail : resetEmail)({ league: league_name, firstName: user.first_name, link, hours: TOKEN_HOURS });
  try { await sendMail({ to: user.email, ...mail }); return true; } catch (e) {
    console.error('Error enviando correo a', user.email, e.message);
    await audit(null, 'mail_error', { to: user.email, purpose, error: e.message });
    return false;
  }
}

async function logConsents(conn, userId, req, list) {
  for (const [consent, granted] of list) {
    await run('INSERT INTO consents (user_id, consent, granted, text_version, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, consent, granted ? 1 : 0, PRIVACY_VERSION, clientIp(req).slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 255)], conn);
  }
}

// ---------- Rutas ----------

const routes = [];
const route = (method, path, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, limit: opts.limit || 100_000 });
};
const raw = (status, headers, body) => ({ __raw: { status, headers, body } });

async function startSession(ctx, userId) {
  const token = randomBytes(24).toString('hex');
  const maxAge = 60 * 60 * 24 * 30;
  await run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, Date.now() + maxAge * 1000]);
  ctx.headers['Set-Cookie'] = `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(ctx.req) ? '; Secure' : ''}`;
  return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', [userId])) };
}

async function publicSettings() {
  const s = await getSettings();
  return { league_name: s.league_name, course_name: s.course_name, season: s.season, best_cards: s.best_cards,
    feature_live: s.feature_live, feature_shop: s.feature_shop, privacy_version: PRIVACY_VERSION,
    legal_name: s.legal_name, legal_cif: s.legal_cif, legal_address: s.legal_address, legal_email: s.legal_email };
}

// --- Registro de jugadores ---
route('POST', '/api/auth/register', async (ctx) => {
  limit(ctx.req, 'register', 6, 60);
  const b = ctx.body;
  if (b.website) return { ok: true }; // campo trampa para bots
  const { d, f } = validatePlayerData(b, { requirePhoto: true });
  if (!b.consent_privacy) f.consent_privacy = 'Debes aceptar la política de privacidad para inscribirte';
  const minor = d.birth_date && !f.birth_date && ageOn(d.birth_date) < 14;
  if (minor) {
    if (clean(b.guardian_name, 200).length < 4) f.guardian_name = 'Nombre del padre, madre o tutor';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean(b.guardian_email, 190))) f.guardian_email = 'Email del tutor no válido';
    if (!b.consent_guardian) f.consent_guardian = 'El tutor legal debe dar su consentimiento';
  }
  if (Object.keys(f).length) fail(400, 'Revisa los campos marcados', f);
  if (await one('SELECT 1 AS x FROM users WHERE email = ?', [d.email]))
    fail(409, 'Ya hay una inscripción con este email. Si no te llegó el correo, usa «¿Olvidaste tu contraseña?» en Entrar.', { email: 'Email ya inscrito' });
  if (await one('SELECT 1 AS x FROM users WHERE licence = ?', [d.licence]))
    fail(409, 'Ya hay una inscripción con este número de licencia. Contacta con el comité si es un error.', { licence: 'Licencia ya inscrita' });

  const userId = await tx(async (c) => {
    const { insertId } = await run(`INSERT INTO users (email, first_name, last_name, name, phone, licence, birth_date, handicap, shirt_size, instagram,
      status, consent_notifications, consent_image, guardian_name, guardian_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [d.email, d.first_name, d.last_name, `${d.first_name} ${d.last_name}`, d.phone, d.licence, d.birth_date, d.handicap, d.shirt_size, d.instagram,
      b.consent_notifications ? 1 : 0, b.consent_image ? 1 : 0, minor ? clean(b.guardian_name, 200) : null, minor ? clean(b.guardian_email, 190).toLowerCase() : null], c);
    await run('INSERT INTO photos (user_id, mime, data) VALUES (?, ?, ?)', [insertId, d.photo.mime, d.photo.data], c);
    await logConsents(c, insertId, ctx.req, [['privacy', true], ['notifications', !!b.consent_notifications], ['image', !!b.consent_image],
      ...(minor ? [['guardian', true]] : [])]);
    return insertId;
  });
  const user = await one('SELECT * FROM users WHERE id = ?', [userId]);
  const sent = await sendAccessEmail(ctx.req, user, 'activate');
  await audit(userId, 'player_registered', { name: user.name, email_sent: sent });
  broadcast('players');
  if (ADMIN_NOTIFY.length) {
    const { league_name } = await getSettings();
    sendMail({ to: ADMIN_NOTIFY.join(','), ...adminNewPlayerEmail({ league: league_name, player: user, link: `${baseUrl(ctx.req)}/#/admin` }) })
      .catch((e) => console.error('Aviso al comité no enviado:', e.message));
  }
  return { ok: true, first_name: user.first_name, email: user.email, email_sent: sent };
}, { limit: 6_000_000 });

// --- Enlaces de contraseña ---
async function findToken(rawToken) {
  const t = await one(`SELECT t.*, u.first_name, u.status FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, [sha256(String(rawToken || ''))]);
  if (!t || t.used_at || new Date(t.expires_at) < now() || t.status === 'disabled') return null;
  return t;
}

route('GET', '/api/auth/token/:token', async (ctx) => {
  const t = await findToken(ctx.params.token);
  if (!t) fail(410, 'Este enlace ha caducado o ya se ha usado. Pide uno nuevo.');
  return { first_name: t.first_name, purpose: t.purpose };
});

route('POST', '/api/auth/password', async (ctx) => {
  limit(ctx.req, 'password', 20, 15);
  const pw = String(ctx.body.password || '');
  if (pw.length < 8) fail(400, 'La contraseña debe tener al menos 8 caracteres');
  const t = await findToken(ctx.body.token);
  if (!t) fail(410, 'Este enlace ha caducado o ya se ha usado. Pide uno nuevo.');
  await tx(async (c) => {
    await run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', [now(), t.id], c);
    await run(`UPDATE users SET pass_hash = ?, status = IF(status = 'pending', 'active', status), activated_at = COALESCE(activated_at, ?) WHERE id = ?`,
      [hashPassword(pw), now(), t.user_id], c);
    await run('DELETE FROM sessions WHERE user_id = ?', [t.user_id], c);
  });
  await audit(t.user_id, t.purpose === 'activate' ? 'account_activated' : 'password_reset', {});
  return startSession(ctx, t.user_id);
});

route('POST', '/api/auth/forgot', async (ctx) => {
  limit(ctx.req, 'forgot', 5, 15);
  const u = await one(`SELECT * FROM users WHERE email = ? AND status IN ('pending', 'active')`, [clean(ctx.body.email, 190).toLowerCase()]);
  if (u) await sendAccessEmail(ctx.req, u, u.status === 'pending' ? 'activate' : 'reset');
  return { ok: true }; // misma respuesta exista o no la cuenta
});

route('POST', '/api/auth/login', async (ctx) => {
  limit(ctx.req, 'login', 10, 15);
  const u = await one('SELECT * FROM users WHERE email = ?', [clean(ctx.body.email, 190).toLowerCase()]);
  if (!u || u.status !== 'active' || !checkPassword(String(ctx.body.password || ''), u.pass_hash)) fail(401, 'Email o contraseña incorrectos');
  return startSession(ctx, u.id);
});

route('POST', '/api/auth/logout', async (ctx) => {
  const sid = cookies(ctx.req).sid;
  if (sid) await run('DELETE FROM sessions WHERE token = ?', [sid]);
  ctx.headers['Set-Cookie'] = 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
  return { ok: true };
});

// --- Mi ficha ---
route('GET', '/api/me', async (ctx) => ({ user: publicUser(ctx.user), has_photo: ctx.user ? !!(await one('SELECT 1 AS x FROM photos WHERE user_id = ?', [ctx.user.id])) : false, settings: await publicSettings() }));

// El jugador edita sus datos de contacto. Email, licencia, nacimiento, hándicap y puntuaciones los gestiona el comité.
route('PUT', '/api/me', async (ctx) => {
  const u = requireUser(ctx);
  const b = ctx.body;
  const f = {};
  const first = clean(b.first_name ?? u.first_name, 100), last = clean(b.last_name ?? u.last_name, 150);
  const phone = clean(b.phone ?? u.phone, 30);
  const instagram = normInstagram(b.instagram ?? u.instagram).slice(0, 30);
  const size = clean(b.shirt_size ?? u.shirt_size, 5).toUpperCase();
  if (first.length < 2) f.first_name = 'Nombre demasiado corto';
  if (last.length < 2) f.last_name = 'Apellidos demasiado cortos';
  if ((phone.match(/\d/g) || []).length < 9) f.phone = 'Teléfono no válido';
  if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) f.instagram = 'Usuario de Instagram no válido';
  if (size && !SHIRT_SIZES.includes(size)) f.shirt_size = 'Talla no válida';
  if (Object.keys(f).length) fail(400, 'Revisa los campos marcados', f);
  await run('UPDATE users SET first_name = ?, last_name = ?, name = ?, phone = ?, instagram = ?, shirt_size = ?, bio = ? WHERE id = ?',
    [first, last, `${first} ${last}`, phone, instagram, size, clean(b.bio ?? u.bio, 500), u.id]);
  if (b.new_password) {
    if (!checkPassword(String(b.current_password || ''), u.pass_hash)) fail(400, 'La contraseña actual no es correcta');
    if (String(b.new_password).length < 8) fail(400, 'La nueva contraseña debe tener al menos 8 caracteres');
    await run('UPDATE users SET pass_hash = ? WHERE id = ?', [hashPassword(b.new_password), u.id]);
  }
  return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', [u.id])) };
});

route('PUT', '/api/me/photo', async (ctx) => {
  const u = requireUser(ctx);
  const photo = parsePhoto(ctx.body.photo);
  if (!photo) fail(400, 'Fotografía no válida (JPG, PNG o WebP, máx. 3 MB)');
  await run(`INSERT INTO photos (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE mime = VALUES(mime), data = VALUES(data), updated_at = VALUES(updated_at)`, [u.id, photo.mime, photo.data, now()]);
  return { ok: true };
}, { limit: 6_000_000 });

// Retirar o dar consentimientos en cualquier momento (RGPD art. 7.3). Queda registrado.
route('PUT', '/api/me/consents', async (ctx) => {
  const u = requireUser(ctx);
  const changes = [];
  for (const k of ['notifications', 'image']) {
    if (ctx.body[k] === undefined) continue;
    const v = !!ctx.body[k];
    if (v !== !!u[`consent_${k}`]) changes.push([k, v]);
  }
  if (changes.length) await tx(async (c) => {
    for (const [k, v] of changes) await run(`UPDATE users SET consent_${k} = ? WHERE id = ?`, [v ? 1 : 0, u.id], c);
    await logConsents(c, u.id, ctx.req, changes);
  });
  return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', [u.id])) };
});

// Fotos: visibles para jugadores con sesión iniciada (no públicas).
route('GET', '/api/photos/:id', async (ctx) => {
  requireUser(ctx);
  const p = await one('SELECT mime, data, updated_at FROM photos WHERE user_id = ?', [Number(ctx.params.id)]);
  if (!p) fail(404, 'Sin foto');
  const etag = `"${new Date(p.updated_at).getTime()}"`;
  if (ctx.req.headers['if-none-match'] === etag) return raw(304, { ETag: etag }, '');
  const headers = { 'Content-Type': p.mime, ETag: etag, 'Cache-Control': 'private, max-age=600' };
  if (ctx.query.get('download') && ctx.user.role === 'admin') headers['Content-Disposition'] = `attachment; filename="foto-jugador-${ctx.params.id}.${p.mime.split('/')[1].replace('jpeg', 'jpg')}"`;
  return raw(200, headers, p.data);
});

// --- Liga (con sesión iniciada) ---
route('GET', '/api/course', async (ctx) => { requireUser(ctx); return { holes: Object.values(await getCourse()) }; });

route('GET', '/api/players', async (ctx) => {
  requireUser(ctx);
  const st = await standings();
  const pos = Object.fromEntries(st.rows.map((r) => [r.user_id, r]));
  const players = await q(`SELECT u.id, u.name, u.handicap, (p.user_id IS NOT NULL) AS has_photo FROM users u LEFT JOIN photos p ON p.user_id = u.id
    WHERE u.role = 'player' AND u.status = 'active' ORDER BY u.last_name, u.first_name`);
  return { players: players.map((p) => ({ ...p, has_photo: !!p.has_photo, pos: pos[p.id]?.pos ?? null, total: pos[p.id]?.total ?? 0, played: pos[p.id]?.played ?? 0 })) };
});

route('GET', '/api/players/:id', async (ctx) => {
  const me = requireUser(ctx);
  const id = Number(ctx.params.id);
  const p = await one(`SELECT u.id, u.name, u.handicap, u.licence, u.bio, u.instagram, u.consent_image, u.created_at, (ph.user_id IS NOT NULL) AS has_photo
    FROM users u LEFT JOIN photos ph ON ph.user_id = u.id WHERE u.id = ? AND u.status = 'active'`, [id]);
  if (!p) fail(404, 'Jugador no encontrado');
  if (me.id !== id && me.role !== 'admin') delete p.licence;
  if (!p.consent_image && me.id !== id && me.role !== 'admin') p.instagram = '';
  p.has_photo = !!p.has_photo;
  const cards = (await cardViews(await q('SELECT * FROM cards WHERE user_id = ?', [id]))).sort((a, b) => a.round.number - b.round.number);
  const st = (await standings()).rows.find((r) => r.user_id === id) || null;
  return { player: p, standing: st, cards: cards.map(({ holes, ...c }) => c) };
});

// Calendario: público (solo fechas), el resto de datos con sesión.
route('GET', '/api/rounds', async (ctx) => {
  const rounds = await q(`SELECT r.*, (SELECT COUNT(*) FROM entries e WHERE e.round_id = r.id) AS entries,
    (SELECT COUNT(*) FROM tee_groups g WHERE g.round_id = r.id) AS \`groups\`,
    (SELECT COUNT(*) FROM cards c WHERE c.round_id = r.id AND c.status = 'validated') AS validated
    FROM rounds r ORDER BY number`);
  const mine = ctx.user ? new Set((await q('SELECT round_id FROM entries WHERE user_id = ?', [ctx.user.id])).map((r) => r.round_id)) : new Set();
  return { rounds: rounds.map((r) => ({ ...r, entered: mine.has(r.id) })) };
});

route('GET', '/api/rounds/:id', async (ctx) => {
  requireUser(ctx);
  const r = await loadRound(ctx.params.id);
  const groups = await q('SELECT * FROM tee_groups WHERE round_id = ? ORDER BY number', [r.id]);
  for (const g of groups) {
    g.players = await q(`SELECT c.id AS card_id, u.id, u.name, c.playing_hcp, c.status, c.marker_id FROM cards c
      JOIN users u ON u.id = c.user_id WHERE c.group_id = ? ORDER BY c.id`, [g.id]);
  }
  const entries = await q(`SELECT u.id, u.name, u.handicap FROM entries e JOIN users u ON u.id = e.user_id WHERE e.round_id = ? ORDER BY u.last_name, u.first_name`, [r.id]);
  return { round: r, groups, entries, entered: entries.some((e) => e.id === ctx.user.id), leaderboard: await roundLeaderboard(r.id, r.status === 'live') };
});

route('POST', '/api/rounds/:id/entry', async (ctx) => {
  const u = requireUser(ctx);
  if (u.role !== 'player') fail(400, 'Solo los jugadores pueden inscribirse');
  const r = await loadRound(ctx.params.id);
  if (r.status !== 'scheduled') fail(400, 'La inscripción de esta jornada está cerrada');
  if (await one('SELECT 1 AS x FROM tee_groups WHERE round_id = ?', [r.id])) fail(400, 'Las partidas ya están hechas. Contacta con el comité.');
  const on = !!ctx.body.on;
  if (on) await run('INSERT IGNORE INTO entries (round_id, user_id) VALUES (?, ?)', [r.id, u.id]);
  else await run('DELETE FROM entries WHERE round_id = ? AND user_id = ?', [r.id, u.id]);
  broadcast('round', { roundId: r.id });
  return { entered: on };
});

route('GET', '/api/standings', async (ctx) => { requireUser(ctx); return standings(); });

route('GET', '/api/cards/:id', async (ctx) => { requireUser(ctx); return { card: await cardView(await loadCard(ctx.params.id)) }; });

// --- Tarjeta live (en borrador mientras feature_live = 0; el comité sí la ve) ---
route('GET', '/api/live', async (ctx) => {
  requireUser(ctx);
  await requireFeature(ctx, 'feature_live');
  const round = await one(`SELECT * FROM rounds WHERE status = 'live' ORDER BY number LIMIT 1`);
  const next = await one(`SELECT * FROM rounds WHERE status = 'scheduled' ORDER BY number LIMIT 1`);
  const { pace_minutes } = await getSettings();
  if (!round) return { round: null, next, pace_minutes };
  let group = null, cards = [], myCardId = null;
  const mine = await one('SELECT * FROM cards WHERE round_id = ? AND user_id = ?', [round.id, ctx.user.id]);
  if (mine?.group_id) {
    myCardId = mine.id;
    group = await one('SELECT * FROM tee_groups WHERE id = ?', [mine.group_id]);
    cards = await cardViews(await q('SELECT * FROM cards WHERE group_id = ? ORDER BY id', [group.id]));
  }
  return { round, group, cards, myCardId, pace_minutes, leaderboard: await roundLeaderboard(round.id, true) };
});

route('POST', '/api/groups/:id/start', async (ctx) => {
  const u = requireUser(ctx);
  await requireFeature(ctx, 'feature_live');
  const g = (await one('SELECT * FROM tee_groups WHERE id = ?', [Number(ctx.params.id)])) || fail(404, 'Partida no encontrada');
  const r = await loadRound(g.round_id);
  if (r.status !== 'live') fail(400, 'La jornada no está en juego');
  if (u.role !== 'admin' && !(await one('SELECT 1 AS x FROM cards WHERE group_id = ? AND user_id = ?', [g.id, u.id]))) fail(403, 'No perteneces a esta partida');
  await startGroup(g.id);
  broadcast('live', { roundId: r.id });
  return { ok: true };
});

route('PUT', '/api/cards/:id/score', async (ctx) => {
  const u = requireUser(ctx);
  await requireFeature(ctx, 'feature_live');
  const card = await loadCard(ctx.params.id);
  const round = await loadRound(card.round_id);
  if (round.status !== 'live') fail(400, 'Solo se puede anotar durante una jornada en juego');
  if (card.status === 'validated') fail(400, 'La tarjeta ya está validada y no se puede modificar');
  if (u.role !== 'admin' && !(await inSameGroup(u, card))) fail(403, 'Solo los jugadores de la partida pueden anotar esta tarjeta');
  const hole = Number(ctx.body.hole);
  const group = await one('SELECT * FROM tee_groups WHERE id = ?', [card.group_id]);
  if (!playOrder(round.nine, group.start_hole).includes(hole)) fail(400, 'Ese hoyo no se juega en esta jornada');
  const strokes = ctx.body.strokes === null ? null : Number(ctx.body.strokes);
  if (strokes !== null && (!Number.isInteger(strokes) || strokes < 1 || strokes > 15)) fail(400, 'Golpes no válidos');
  await tx(async (c) => {
    await startGroup(group.id, c);
    if (strokes === null) await run('DELETE FROM scores WHERE card_id = ? AND hole = ?', [card.id, hole], c);
    else await run(`INSERT INTO scores (card_id, hole, strokes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE strokes = VALUES(strokes), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`, [card.id, hole, strokes, u.id, now()], c);
    await run(`UPDATE cards SET status = 'playing', player_signed_at = NULL, marker_signed_at = NULL WHERE id = ?`, [card.id], c);
  });
  await refreshGroupFinish(group.id);
  broadcast('live', { roundId: round.id, cardId: card.id });
  return { card: await cardView(await loadCard(card.id)) };
});

route('POST', '/api/cards/:id/sign', async (ctx) => {
  const u = requireUser(ctx);
  await requireFeature(ctx, 'feature_live');
  const card = await loadCard(ctx.params.id);
  if (card.status === 'validated') fail(400, 'La tarjeta ya está validada');
  const view = await cardView(card);
  if (!view.complete) fail(400, 'Faltan hoyos por anotar');
  const as = ctx.body.as;
  if (!['player', 'marker'].includes(as)) fail(400, 'Firma no válida');
  if (as === 'player' && u.id !== card.user_id) fail(403, 'Solo el propio jugador puede firmar como jugador');
  if (as === 'marker' && u.id !== card.marker_id && u.role !== 'admin') fail(403, 'Solo el marcador asignado puede firmar como marcador');
  await run(`UPDATE cards SET ${as === 'player' ? 'player_signed_at' : 'marker_signed_at'} = ? WHERE id = ?`, [now(), card.id]);
  const c = await loadCard(card.id);
  if (c.player_signed_at && c.marker_signed_at) {
    await run(`UPDATE cards SET status = 'validated', validated_at = ? WHERE id = ?`, [now(), card.id]);
    await audit(u.id, 'card_validated', { card: card.id, points: view.points, gross: view.gross });
  }
  broadcast('live', { roundId: card.round_id, cardId: card.id });
  broadcast('standings');
  return { card: await cardView(await loadCard(card.id)) };
});

// --- Tienda (en borrador mientras feature_shop = 0) ---
route('GET', '/api/products', async (ctx) => {
  await requireFeature(ctx, 'feature_shop');
  return { products: (await q('SELECT * FROM products WHERE active = 1 ORDER BY id')).map((p) => ({ ...p, sizes: JSON.parse(p.sizes) })) };
});

async function orderView(id) {
  const o = await one('SELECT o.*, u.name AS user_name, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?', [id]);
  return { ...o, items: await q('SELECT * FROM order_items WHERE order_id = ?', [id]) };
}

route('POST', '/api/orders', async (ctx) => {
  const u = requireUser(ctx);
  await requireFeature(ctx, 'feature_shop');
  const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!items.length) fail(400, 'El carrito está vacío');
  const id = await tx(async (c) => {
    let total = 0;
    const lines = [];
    for (const it of items) {
      const p = (await one('SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE', [Number(it.productId)], c)) || fail(400, 'Producto no disponible');
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) fail(400, 'Cantidad no válida');
      if (!JSON.parse(p.sizes).includes(it.size)) fail(400, `Talla no disponible para ${p.name}`);
      if (p.stock < qty) fail(400, `No queda stock suficiente de ${p.name}`);
      await run('UPDATE products SET stock = stock - ? WHERE id = ?', [qty, p.id], c);
      total += p.price_cents * qty;
      lines.push({ p, qty, size: it.size });
    }
    const { insertId } = await run('INSERT INTO orders (user_id, total_cents, delivery, notes) VALUES (?, ?, ?, ?)',
      [u.id, total, ctx.body.delivery === 'jornada' ? 'jornada' : 'club', clean(ctx.body.notes, 300)], c);
    for (const l of lines) await run('INSERT INTO order_items (order_id, product_id, name, size, qty, price_cents) VALUES (?, ?, ?, ?, ?, ?)',
      [insertId, l.p.id, l.p.name, l.size, l.qty, l.p.price_cents], c);
    return insertId;
  });
  return { order: await orderView(id) };
});

route('GET', '/api/orders/mine', async (ctx) => {
  const u = requireUser(ctx);
  await requireFeature(ctx, 'feature_shop');
  const ids = await q('SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC', [u.id]);
  return { orders: await Promise.all(ids.map((o) => orderView(o.id))) };
});

// ---------- Comité ----------

const ADMIN_PLAYER_COLS = `u.id, u.first_name, u.last_name, u.name, u.email, u.phone, u.licence, u.birth_date, u.handicap, u.shirt_size, u.instagram,
  u.role, u.status, u.consent_notifications, u.consent_image, u.guardian_name, u.guardian_email, u.created_at, u.activated_at, (p.user_id IS NOT NULL) AS has_photo`;

route('GET', '/api/admin/overview', async (ctx) => {
  requireAdmin(ctx);
  const orderIds = await q('SELECT id FROM orders ORDER BY id DESC');
  return {
    settings: await getSettings(),
    players: (await q(`SELECT ${ADMIN_PLAYER_COLS} FROM users u LEFT JOIN photos p ON p.user_id = u.id ORDER BY u.created_at DESC`))
      .map((p) => ({ ...p, has_photo: !!p.has_photo, consent_notifications: !!p.consent_notifications, consent_image: !!p.consent_image })),
    orders: await Promise.all(orderIds.map((o) => orderView(o.id))),
    audit: await q(`SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 80`),
    products: await q('SELECT * FROM products ORDER BY id'),
    mail: await verifyMail().catch((e) => `Error SMTP: ${e.message}`),
  };
});

// Exportación de jugadores a CSV (Excel en español: separador «;» y BOM UTF-8).
route('GET', '/api/admin/players.csv', async (ctx) => {
  requireAdmin(ctx);
  const rows = await q(`SELECT ${ADMIN_PLAYER_COLS} FROM users u LEFT JOIN photos p ON p.user_id = u.id WHERE u.role = 'player' ORDER BY u.last_name, u.first_name`);
  const cols = [['Nombre', 'first_name'], ['Apellidos', 'last_name'], ['Email', 'email'], ['Teléfono', 'phone'], ['Licencia', 'licence'],
    ['Fecha nacimiento', 'birth_date'], ['Hándicap', 'handicap'], ['Talla polo', 'shirt_size'], ['Instagram', 'instagram'],
    ['Estado', 'status'], ['Notificaciones', 'consent_notifications'], ['Uso de imagen', 'consent_image'], ['Tutor', 'guardian_name'],
    ['Email tutor', 'guardian_email'], ['Inscrito', 'created_at']];
  const cell = (v) => {
    if (v instanceof Date) v = v.toISOString().slice(0, 16).replace('T', ' ');
    if (typeof v === 'number' && !Number.isInteger(v)) v = String(v).replace('.', ',');
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita fórmulas al abrir en Excel
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [cols.map((c) => c[0]).join(';'), ...rows.map((r) => cols.map(([, k]) => cell(
    ['consent_notifications', 'consent_image'].includes(k) ? (r[k] ? 'Sí' : 'No') : k === 'status' ? STATUS_ES[r[k]] : r[k])).join(';'))].join('\r\n');
  await audit(ctx.user.id, 'players_export', { rows: rows.length });
  return raw(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="jugadores-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' }, csv);
});

route('PUT', '/api/admin/settings', async (ctx) => {
  const u = requireAdmin(ctx);
  const allowed = ['league_name', 'course_name', 'season', 'best_cards', 'allowance', 'pace_minutes', 'feature_live', 'feature_shop',
    'legal_name', 'legal_cif', 'legal_address', 'legal_email'];
  for (const k of allowed) {
    if (ctx.body[k] === undefined) continue;
    let v = ctx.body[k];
    if (k.startsWith('feature_')) v = v === true || v === '1' || v === 'on' ? '1' : '0';
    await run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, clean(v, 300)]);
  }
  await audit(u.id, 'settings', ctx.body);
  broadcast('standings');
  return { settings: await getSettings() };
});

route('PUT', '/api/admin/course', async (ctx) => {
  const u = requireAdmin(ctx);
  const holes = ctx.body.holes || [];
  if (holes.length !== 18 || new Set(holes.map((h) => Number(h.si))).size !== 18) fail(400, 'Hacen falta 18 hoyos con índices (SI) del 1 al 18 sin repetir');
  await tx(async (c) => {
    for (const h of holes) await run('UPDATE course_holes SET par = ?, si = ?, meters = ? WHERE hole = ?', [Number(h.par), Number(h.si), Number(h.meters) || 0, Number(h.hole)], c);
  });
  await audit(u.id, 'course', holes);
  return { holes: Object.values(await getCourse()) };
});

route('PUT', '/api/admin/players/:id', async (ctx) => {
  const admin = requireAdmin(ctx);
  const p = (await one('SELECT * FROM users WHERE id = ?', [Number(ctx.params.id)])) || fail(404, 'Jugador no encontrado');
  const b = { ...p, ...ctx.body, photo: undefined };
  const { d, f } = validatePlayerData(b, { requirePhoto: false });
  if (p.role === 'admin') { delete f.licence; delete f.birth_date; delete f.phone; delete f.shirt_size; }
  if (Object.keys(f).length) fail(400, 'Revisa los campos marcados', f);
  const role = ['admin', 'player'].includes(ctx.body.role) ? ctx.body.role : p.role;
  const status = ['pending', 'active', 'disabled'].includes(ctx.body.status) ? ctx.body.status : p.status;
  if (p.id === admin.id && (role !== 'admin' || status !== 'active')) fail(400, 'No puedes quitarte el acceso de comité a ti mismo');
  try {
    await run(`UPDATE users SET first_name = ?, last_name = ?, name = ?, email = ?, phone = ?, licence = ?, birth_date = ?, handicap = ?,
      shirt_size = ?, instagram = ?, role = ?, status = ? WHERE id = ?`,
    [d.first_name, d.last_name, `${d.first_name} ${d.last_name}`, d.email, d.phone, d.licence || null, d.birth_date || null, d.handicap,
      d.shirt_size, d.instagram, role, status, p.id]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') fail(409, 'Ese email o número de licencia ya lo usa otro jugador'); throw e; }
  if (status === 'disabled') await run('DELETE FROM sessions WHERE user_id = ?', [p.id]);
  await audit(admin.id, 'player_update', { player: p.id, from: { handicap: p.handicap, role: p.role, status: p.status }, to: { handicap: d.handicap, role, status } });
  return { ok: true };
});

route('POST', '/api/admin/players/:id/invite', async (ctx) => {
  const admin = requireAdmin(ctx);
  const p = (await one('SELECT * FROM users WHERE id = ?', [Number(ctx.params.id)])) || fail(404, 'Jugador no encontrado');
  if (p.status === 'disabled') fail(400, 'El jugador está dado de baja');
  const sent = await sendAccessEmail(ctx.req, p, p.status === 'pending' ? 'activate' : 'reset');
  await audit(admin.id, 'invite_resent', { player: p.id, sent });
  if (!sent) fail(502, 'No se pudo enviar el correo. Revisa la configuración SMTP.');
  return { ok: true };
});

// Derecho de supresión: borra al jugador y todos sus datos (foto, consentimientos, tarjetas, inscripciones).
route('DELETE', '/api/admin/players/:id', async (ctx) => {
  const admin = requireAdmin(ctx);
  const p = (await one('SELECT id, name, email FROM users WHERE id = ?', [Number(ctx.params.id)])) || fail(404, 'Jugador no encontrado');
  if (p.id === admin.id) fail(400, 'No puedes borrar tu propia cuenta');
  await run('DELETE FROM users WHERE id = ?', [p.id]);
  await audit(admin.id, 'player_deleted', { player: p.id, name: p.name });
  broadcast('standings');
  return { ok: true };
});

route('PUT', '/api/admin/rounds/:id', async (ctx) => {
  const u = requireAdmin(ctx);
  const r = await loadRound(ctx.params.id);
  const b = ctx.body;
  const status = ['scheduled', 'live', 'closed'].includes(b.status) ? b.status : r.status;
  if (status === 'live' && !(await one('SELECT 1 AS x FROM tee_groups WHERE round_id = ?', [r.id]))) fail(400, 'Genera las partidas antes de abrir la jornada');
  if (status === 'live' && (await one(`SELECT 1 AS x FROM rounds WHERE status = 'live' AND id != ?`, [r.id]))) fail(400, 'Ya hay otra jornada en juego');
  const nine = ['front', 'back'].includes(b.nine) ? b.nine : r.nine;
  if (nine !== r.nine && (await one('SELECT 1 AS x FROM scores s JOIN cards c ON c.id = s.card_id WHERE c.round_id = ?', [r.id]))) fail(400, 'No se puede cambiar de vuelta con golpes anotados');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : r.date;
  await run('UPDATE rounds SET date = ?, nine = ?, first_tee = ?, status = ?, notes = ? WHERE id = ?',
    [date, nine, /^\d{2}:\d{2}$/.test(b.first_tee || '') ? b.first_tee : r.first_tee, status, clean(b.notes ?? r.notes, 500), r.id]);
  await audit(u.id, 'round_update', { round: r.number, status });
  broadcast('round', { roundId: r.id });
  return { round: await loadRound(r.id) };
});

route('POST', '/api/admin/rounds/:id/entries', async (ctx) => {
  requireAdmin(ctx);
  const r = await loadRound(ctx.params.id);
  if (ctx.body.on) await run('INSERT IGNORE INTO entries (round_id, user_id) VALUES (?, ?)', [r.id, Number(ctx.body.user_id)]);
  else await run('DELETE FROM entries WHERE round_id = ? AND user_id = ?', [r.id, Number(ctx.body.user_id)]);
  return { ok: true };
});

route('POST', '/api/admin/rounds/:id/groups', async (ctx) => {
  const u = requireAdmin(ctx);
  const r = await loadRound(ctx.params.id);
  if (r.status === 'closed') fail(400, 'La jornada está cerrada');
  if (await one('SELECT 1 AS x FROM scores s JOIN cards c ON c.id = s.card_id WHERE c.round_id = ?', [r.id])) fail(400, 'Ya hay golpes anotados en esta jornada; no se pueden rehacer las partidas');
  const b = ctx.body;
  try {
    await generateGroups(r.id, { mode: b.mode === 'shotgun' ? 'shotgun' : 'tee', interval: Math.max(5, Number(b.interval) || 10),
      size: Math.min(4, Math.max(2, Number(b.size) || 4)), order: b.order === 'handicap' ? 'handicap' : 'random' });
  } catch (e) { fail(400, e.message); }
  await audit(u.id, 'groups_generated', { round: r.number, ...b });
  broadcast('round', { roundId: r.id });
  return { ok: true };
});

route('PUT', '/api/admin/cards/:id', async (ctx) => {
  const u = requireAdmin(ctx);
  const card = await loadCard(ctx.params.id);
  const before = await cardView(card);
  await tx(async (c) => {
    for (const [hole, s] of Object.entries(ctx.body.scores || {})) {
      if (s === null || s === '') await run('DELETE FROM scores WHERE card_id = ? AND hole = ?', [card.id, Number(hole)], c);
      else {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 1 || n > 15) fail(400, `Golpes no válidos en el hoyo ${hole}`);
        await run(`INSERT INTO scores (card_id, hole, strokes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE strokes = VALUES(strokes), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`, [card.id, Number(hole), n, u.id, now()], c);
      }
    }
  });
  if (ctx.body.status === 'validated') {
    if (!(await cardView(await loadCard(card.id))).complete) fail(400, 'No se puede validar una tarjeta incompleta');
    await run(`UPDATE cards SET status = 'validated', validated_at = COALESCE(validated_at, ?) WHERE id = ?`, [now(), card.id]);
  } else if (ctx.body.status === 'playing') {
    await run(`UPDATE cards SET status = 'playing', validated_at = NULL, player_signed_at = NULL, marker_signed_at = NULL WHERE id = ?`, [card.id]);
  }
  const after = await cardView(await loadCard(card.id));
  await audit(u.id, 'card_corrected', { card: card.id, player: before.player.name, round: before.round.number,
    from: { points: before.points, gross: before.gross, status: before.status }, to: { points: after.points, gross: after.gross, status: after.status } });
  broadcast('live', { roundId: card.round_id });
  broadcast('standings');
  return { card: after };
});

route('PUT', '/api/admin/orders/:id', async (ctx) => {
  const u = requireAdmin(ctx);
  const st = ['pendiente_pago', 'pagado', 'entregado', 'cancelado'];
  if (!st.includes(ctx.body.status)) fail(400, 'Estado no válido');
  const o = (await one('SELECT * FROM orders WHERE id = ?', [Number(ctx.params.id)])) || fail(404, 'Pedido no encontrado');
  await tx(async (c) => {
    if (ctx.body.status === 'cancelado' && o.status !== 'cancelado') {
      for (const i of await q('SELECT product_id, qty FROM order_items WHERE order_id = ?', [o.id], c)) await run('UPDATE products SET stock = stock + ? WHERE id = ?', [i.qty, i.product_id], c);
    }
    await run('UPDATE orders SET status = ? WHERE id = ?', [ctx.body.status, o.id], c);
  });
  await audit(u.id, 'order_status', { order: o.id, status: ctx.body.status });
  return { order: await orderView(o.id) };
});

route('PUT', '/api/admin/products/:id', async (ctx) => {
  requireAdmin(ctx);
  const p = (await one('SELECT * FROM products WHERE id = ?', [Number(ctx.params.id)])) || fail(404, 'Producto no encontrado');
  const b = ctx.body;
  await run('UPDATE products SET name = ?, price_cents = ?, stock = ?, active = ? WHERE id = ?',
    [clean(b.name ?? p.name, 150), Number(b.price_cents ?? p.price_cents), Number(b.stock ?? p.stock), b.active === undefined ? p.active : (b.active ? 1 : 0), p.id]);
  return { ok: true };
});

// ---------- Servidor ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), microphone=()' };

async function serveStatic(req, res, pathname) {
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  const html = extname(file) === '.html' || !extname(file);
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': html ? 'no-cache' : 'public, max-age=300' });
    res.end(body);
  } catch {
    const body = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    res.end(body);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (pathname === '/healthz') {
    try { await q('SELECT 1'); res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); } catch { res.writeHead(503, { 'Content-Type': 'text/plain' }).end('db'); }
    return;
  }
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  if (pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }

  const ctx = { req, headers: {}, query: url.searchParams, params: {} };
  try {
    ctx.user = await currentUser(req);
    const r = routes.find((rt) => rt.method === req.method && rt.re.test(pathname)) || fail(404, 'Ruta no encontrada');
    const m = pathname.match(r.re);
    r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
    if (req.method !== 'GET') {
      // Protección CSRF: las escrituras solo se aceptan desde el propio sitio.
      const origin = req.headers.origin;
      if (origin && ![req.headers.host, req.headers['x-forwarded-host'], ...PUBLIC_HOSTS].includes(new URL(origin).host)) fail(403, 'Origen no permitido');
      ctx.body = await readBody(req, r.limit);
    }
    const out = await r.handler(ctx);
    if (out?.__raw) { res.writeHead(out.__raw.status, { ...ctx.headers, ...out.__raw.headers }); res.end(out.__raw.body); return; }
    send(res, 200, out, ctx.headers);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Error interno del servidor', fields: e.fields }, ctx.headers);
  }
});

try {
  await initDb();
} catch (e) {
  console.error('No se pudo conectar o preparar la base de datos MySQL. Revisa DB_HOST, DB_NAME, DB_USER y DB_PASSWORD.\n', e.message);
  process.exit(1);
}
server.listen(PORT, HOST, async () => {
  console.log(`Liga de Golf Baviera → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`MySQL: ${process.env.DB_USER || 'liga'}@${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'liga_dev'}`);
  console.log(await verifyMail().catch((e) => `AVISO SMTP: ${e.message}`));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const r of streams) r.end();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
