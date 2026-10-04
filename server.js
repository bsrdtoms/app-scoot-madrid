import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { db } from './db.js';
import { hashPassword, verifyPassword, signToken, requireAuth } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Config opérateurs ───────────────────────────────────────────────────────

// true  → API Cooltra directe + filtre provider=movo sur Cabify (comportement original)
// false → tout vient de Cabify (moins de bande passante)
const USE_DIRECT_COOLTRA = false;

const OPERATORS = [
  ...(USE_DIRECT_COOLTRA ? [{
    name: 'cooltra',
    url:  'https://api.zeus.cooltra.com/mobile-cooltra/v3/vehicles?system_id=madrid',
    headers: {
      'accept':          'application/json',
      'accept-encoding': 'gzip',
      'user-agent':      'Cooltra/6.0.6 (com.mobime.ecooltra; build:20000903 | 76b3cb8; Android 14; WP35)',
    },
    normalize: (v) => ({
      id:       `cooltra_${v.id}`,
      lat:      v.position[1],
      lng:      v.position[0],
      operator: 'cooltra',
      battery:  v.percentage,
      model:    v.model,
    }),
  }] : []),
  {
    name: 'acciona',
    url:  'https://api.accionamobility.com/v1/fleet/info/region/1',
    // Token OAuth2 obtenu via client_credentials
    getToken: async () => {
      const id = process.env.ACCIONA_CLIENT_ID;
      const secret = process.env.ACCIONA_CLIENT_SECRET;
      if (!id || !secret) throw new Error('ACCIONA_CLIENT_ID / ACCIONA_CLIENT_SECRET manquants (voir .env.example)');
      const res = await fetch('https://api.accionamobility.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
      });
      if (!res.ok) throw new Error(`Token HTTP ${res.status}`);
      const { access_token, expires_in } = await res.json();
      return { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
    },
    // Réponse : { vehicles: [...] }
    normalize: (v) => ({
      id:        `acciona_${v.id}`,
      custom_id: v.custom_id,        // numéro QR affiché sur le scooter
      lat:       v.position.lat,
      lng:       v.position.lng,
      operator:  'acciona',
      battery:   v.battery_level != null ? Math.round(v.battery_level) : null,
      model:     v.model,
    }),
  },
  {
    name: 'cabify',
    url:  'https://rider.cabify.com/rider-cp/api/v3/asset_sharing/assets?lat=40.4168&lon=-3.7038&radius=30000&max_elements_per_type=500',
    headers: {
      'Authorization':         'Bearer ' + (process.env.CABIFY_TOKEN || ''),
      'Accept':                'application/com.cabify.api+json;version=1',
      'Accept-Language':       'en-US',
      'User-Agent':            'CabifyRider/8.228.0 Android/14',
      'x-device-uuid':         process.env.CABIFY_DEVICE_UUID || '',
      'bundle-id':             'com.cabify.rider',
      'three-ds2-sdk-version': '2.2.13',
      'dark-theme':            'false',
      'user-time-zone':        'Europe/Monaco',
      'geolocation':           'geo:40.4168,-3.7038;cgen=gps',
    },
    // Réponse : { results_by_asset_type: { moped: [{ asset: {...}, ... }] } }
    // Cabify agrège plusieurs providers (movo, cooltra, …)
    // En mode USE_DIRECT_COOLTRA on ne garde que "movo" pour éviter les doublons
    getItems: (data) => {
      const mopeds = data.results_by_asset_type?.moped ?? [];
      return USE_DIRECT_COOLTRA ? mopeds.filter(item => item.asset?.provider === 'movo') : mopeds;
    },
    normalize: (item) => ({
      id:       `cabify_${item.asset.id}`,
      lat:      item.asset.loc.latitude,
      lng:      item.asset.loc.longitude,
      operator: item.asset.provider === 'movo' ? 'cabify' : item.asset.provider,
      battery:  item.asset.battery_level,
      model:    item.asset.name,
    }),
  },
];

// ── Cache ───────────────────────────────────────────────────────────────────

const REFRESH_MS  = 30_000;
let   cache       = [];
let   lastUpdate  = null;
let   geofenceCache = null;
let   accionaGeofenceCache = null;

// Tokens OAuth2 par opérateur { token, expiresAt }
const tokenCache = {};

const COOLTRA_HEADERS = {
  'accept':          'application/json',
  'accept-encoding': 'gzip',
  'user-agent':      'Cooltra/6.0.6 (com.mobime.ecooltra; build:20000903 | 76b3cb8; Android 14; WP35)',
};

function isMadrid(ring) {
  const lons = ring.map(c => c[0]);
  const lats = ring.map(c => c[1]);
  const cx = (Math.min(...lons) + Math.max(...lons)) / 2;
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
  return cx > -4.5 && cx < -3.0 && cy > 40.0 && cy < 41.0;
}

async function loadGeofence() {
  try {
    const res  = await fetch('https://api.zeus.cooltra.com/mobile-cooltra/v3/geofence', { headers: COOLTRA_HEADERS });
    const data = await res.json();
    const full = JSON.parse(data.scooterGeofence);

    // Bordure extérieure : anneaux intérieurs du polygon 0 centrés sur Madrid
    const outerRings = full.coordinates[0].slice(1).filter(isMadrid);

    // Zones interdites intérieures : polygones séparés centrés sur Madrid
    const exclusionPolys = full.coordinates.slice(1).filter(poly => isMadrid(poly[0]));

    geofenceCache = {
      // Contour de la zone de service
      boundary: { type: 'MultiPolygon', coordinates: outerRings.map(r => [r]) },
      // Zones interdites à l'intérieur
      exclusions: { type: 'MultiPolygon', coordinates: exclusionPolys },
    };
    console.log(`[geofence] ${outerRings.length} contours + ${exclusionPolys.length} zones interdites`);
  } catch (err) {
    console.error('[geofence] erreur :', err.message);
  }
}

async function loadAccionaGeofence() {
  try {
    const accionaOp = OPERATORS.find(o => o.name === 'acciona');
    if (!tokenCache['acciona'] || Date.now() >= tokenCache['acciona'].expiresAt) {
      tokenCache['acciona'] = await accionaOp.getToken();
    }
    const res = await fetch('https://api.accionamobility.com/v1/region', {
      headers: {
        'Authorization': `Bearer ${tokenCache['acciona'].token}`,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { regions } = await res.json();
    const madrid = regions.find(r => r.id === 1);
    if (!madrid) throw new Error('Région Madrid (id=1) introuvable');

    const { accepted, denied } = madrid.area;
    // Acciona retourne [{lat, lng}, ...] → convertir en GeoJSON [lng, lat]
    accionaGeofenceCache = {
      boundary: {
        type: 'MultiPolygon',
        coordinates: accepted.map(ring => [ring.map(p => [p.lng, p.lat])]),
      },
      exclusions: {
        type: 'MultiPolygon',
        coordinates: denied.map(ring => [ring.map(p => [p.lng, p.lat])]),
      },
    };
    console.log(`[geofence acciona] ${accepted.length} zones acceptées + ${denied.length} zones interdites`);
  } catch (err) {
    console.error('[geofence acciona] erreur :', err.message);
  }
}

async function fetchOperator({ name, url, headers, getToken, getItems, normalize }) {
  let reqHeaders = { ...headers };

  if (getToken) {
    const cached = tokenCache[name];
    if (!cached || Date.now() >= cached.expiresAt) {
      tokenCache[name] = await getToken();
      console.log(`[${name}] nouveau token OAuth`);
    }
    reqHeaders['Authorization'] = `Bearer ${tokenCache[name].token}`;
    reqHeaders['Accept'] = 'application/json';
  }

  const res  = await fetch(url, { headers: reqHeaders });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // Certaines APIs retournent { vehicles: [...] } plutôt qu'un tableau direct
  const items = getItems ? getItems(data) : (Array.isArray(data) ? data : (data.vehicles ?? data.data ?? []));
  return items.map(normalize);
}

async function refreshAll() {
  const results = await Promise.allSettled(OPERATORS.map(fetchOperator));

  const scooters = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      scooters.push(...result.value);
      console.log(`[${OPERATORS[i].name}] ${result.value.length} scooters`);
    } else {
      console.error(`[${OPERATORS[i].name}] erreur : ${result.reason.message}`);
    }
  }

  cache      = scooters;
  lastUpdate = new Date();
  console.log(`Cache mis à jour — ${cache.length} scooters au total`);
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const noCache = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
app.get('/',              noCache, (_req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/home',          noCache, (_req, res) => res.sendFile(join(__dirname, 'home.html')));
app.get('/signup',        noCache, (_req, res) => res.sendFile(join(__dirname, 'signup.html')));
app.get('/login',         noCache, (_req, res) => res.sendFile(join(__dirname, 'login.html')));
app.get('/profile',       noCache, (_req, res) => res.sendFile(join(__dirname, 'profile.html')));

// ── PWA static files ────────────────────────────────────────────────────────
app.get('/manifest.json', (_req, res) => res.sendFile(join(__dirname, 'public/manifest.json')));
app.get('/sw.js',         (_req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(join(__dirname, 'public/sw.js'));
});
app.get('/icon-192.png',          (_req, res) => res.sendFile(join(__dirname, 'public/icon-192.png')));
app.get('/icon-512.png',          (_req, res) => res.sendFile(join(__dirname, 'public/icon-512.png')));
app.get('/icon-192-maskable.png', (_req, res) => res.sendFile(join(__dirname, 'public/icon-192-maskable.png')));
app.get('/icon-512-maskable.png', (_req, res) => res.sendFile(join(__dirname, 'public/icon-512-maskable.png')));
app.get('/favicon.ico',   (_req, res) => res.sendFile(join(__dirname, 'public/favicon.ico')));
app.get('/auth-common.css', (_req, res) => res.sendFile(join(__dirname, 'auth-common.css')));

// ── Auth ────────────────────────────────────────────────────────────────────

app.post('/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email et mot de passe requis' });
  if (password.length < 6) return res.status(400).json({ error: 'mot de passe trop court (min 6)' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'email déjà utilisé' });

  const info = db.prepare(
    'INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)'
  ).run(email.toLowerCase(), hashPassword(password), name || null, Date.now());

  // Initialise les entrées linked_accounts (toutes unlinked par défaut)
  for (const op of ['cooltra', 'acciona', 'cabify']) {
    db.prepare('INSERT INTO linked_accounts (user_id, operator, status, created_at) VALUES (?, ?, ?, ?)')
      .run(info.lastInsertRowid, op, 'unlinked', Date.now());
  }

  const user = { id: info.lastInsertRowid, email: email.toLowerCase(), name };
  res.json({ token: signToken(user), user });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email et mot de passe requis' });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'identifiants invalides' });
  }
  const user = { id: row.id, email: row.email, name: row.name };
  res.json({ token: signToken(user), user });
});

app.get('/me', requireAuth, (req, res) => {
  const linked = db.prepare('SELECT operator, status, note FROM linked_accounts WHERE user_id = ?')
    .all(req.user.id);
  res.json({ user: req.user, linked_accounts: linked });
});

// ── Liaison comptes opérateurs ──────────────────────────────────────────────

// En-têtes fixes Cabify (toutes les requêtes de compte)
const CABIFY_HDRS = {
  'User-Agent':      'CabifyRider/8.228.0 Android/14',
  'Accept':          'application/com.cabify.api+json;version=1',
  'Accept-Language': 'en-US',
  'bundle-id':       'com.cabify.rider',
  'Content-Type':    'application/json',
  'dark-theme':      'false',
  'user-time-zone':  'Europe/Madrid',
  'x-device-uuid':   process.env.CABIFY_DEVICE_UUID || '',
};

// Stockage temporaire du numéro de téléphone pendant la vérification (ttl 10min)
const pendingCabifyPhone = new Map(); // userId → { cc, num, expiresAt }

// Étape 1 : envoyer le SMS
app.post('/accounts/cabify/phone', requireAuth, async (req, res) => {
  const { mobile_cc, mobile_num } = req.body || {};
  if (!mobile_cc || !mobile_num) return res.status(400).json({ error: 'mobile_cc et mobile_num requis' });

  try {
    const r = await fetch('https://rider.cabify.com/rider/api/user/mobile_verification/validate', {
      method: 'POST',
      headers: { ...CABIFY_HDRS, 'user-device-time': new Date().toISOString() },
      body: JSON.stringify({ mobile_num, mobile_cc, code: null }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: 'Cabify validate error', detail: body });

    // Mémoriser le numéro pour l'étape de vérification
    pendingCabifyPhone.set(req.user.id, {
      cc: mobile_cc, num: mobile_num, expiresAt: Date.now() + 10 * 60_000,
    });

    res.json({ ok: true, code_delivery_channel: body.code_delivery_channel ?? 'sms' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Étape 2 : vérifier le code SMS
app.post('/accounts/cabify/verify', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code requis' });

  const pending = pendingCabifyPhone.get(req.user.id);
  if (!pending || Date.now() > pending.expiresAt) {
    return res.status(400).json({ error: 'Aucune vérification en cours — appelez /accounts/cabify/phone d\'abord' });
  }
  const { cc, num } = pending;

  try {
    const r = await fetch('https://rider.cabify.com/rider/api/user/mobile_verification/verify', {
      method: 'POST',
      headers: { ...CABIFY_HDRS, 'user-device-time': new Date().toISOString() },
      body: JSON.stringify({ mobile_num: num, mobile_cc: cc, code }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: 'Cabify verify error', detail: body });

    // Le corps de la réponse peut contenir un token ou un phone_number_verification_id
    // On tente d'obtenir un token complet via /rider/api/v4/authorization si nécessaire
    let accessToken = body.access_token ?? body.token ?? null;
    const verificationId = body.phone_number_verification_id ?? null;

    if (!accessToken && verificationId) {
      // Échange verificationId → token via /rider/api/v4/authorization
      const authR = await fetch('https://rider.cabify.com/rider/api/v4/authorization', {
        method: 'POST',
        headers: { ...CABIFY_HDRS, 'user-device-time': new Date().toISOString() },
        body: JSON.stringify({
          method: 'mobile',
          client_id: 'rider',
          request_mobile: false,
          credentials: {
            mobile: { cc, num },
            phone_number_verification_id: verificationId,
          },
        }),
      });
      const authBody = await authR.json().catch(() => ({}));
      console.log('[cabify] /authorization response:', JSON.stringify(authBody).slice(0, 300));
      accessToken = authBody.access_token ?? authBody.token ?? null;
    }

    pendingCabifyPhone.delete(req.user.id);

    db.prepare(
      `UPDATE linked_accounts SET status = ?, token = ?, operator_uid = ?, note = ? WHERE user_id = ? AND operator = 'cabify'`
    ).run(
      accessToken ? 'linked' : 'pending',
      accessToken,
      body.user_id ?? body.id ?? null,
      accessToken ? null : JSON.stringify(body).slice(0, 200),
      req.user.id,
    );

    res.json({ ok: true, linked: !!accessToken, debug: body });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Réservations ────────────────────────────────────────────────────────────
// Note : ScootMap ne peut pas réserver directement chez les opérateurs (pas d'API publique).
// Une "réservation" ici trace l'intention de l'utilisateur et le redirige vers l'app opérateur.

app.post('/reservations', requireAuth, (req, res) => {
  const { scooter_id } = req.body || {};
  if (!scooter_id) return res.status(400).json({ error: 'scooter_id requis' });

  const scooter = cache.find(s => s.id === scooter_id);
  if (!scooter) return res.status(404).json({ error: 'scooter introuvable ou hors ligne' });

  const info = db.prepare(
    `INSERT INTO reservations (user_id, scooter_id, operator, model, lat, lng, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(req.user.id, scooter.id, scooter.operator, scooter.model || null, scooter.lat, scooter.lng, Date.now());

  res.json({ id: info.lastInsertRowid, scooter });
});

app.get('/reservations', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM reservations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  res.json(rows);
});

app.post('/reservations/:id/complete', requireAuth, (req, res) => {
  const info = db.prepare(
    `UPDATE reservations SET status = 'completed', completed_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(Date.now(), req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'réservation introuvable' });
  res.json({ ok: true });
});

app.post('/reservations/:id/cancel', requireAuth, (req, res) => {
  const info = db.prepare(
    `UPDATE reservations SET status = 'cancelled', completed_at = ?
     WHERE id = ? AND user_id = ? AND status = 'pending'`
  ).run(Date.now(), req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'réservation introuvable ou déjà terminée' });
  res.json({ ok: true });
});

// ── Statistiques ────────────────────────────────────────────────────────────

app.post('/stats/session', requireAuth, (req, res) => {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO user_sessions (user_id, started_at, last_ping, duration) VALUES (?, ?, ?, 0)'
  ).run(req.user.id, now, now);
  res.json({ id: info.lastInsertRowid });
});

app.post('/stats/ping', requireAuth, (req, res) => {
  const { session_id, duration } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id requis' });
  db.prepare(
    'UPDATE user_sessions SET last_ping = ?, duration = ? WHERE id = ? AND user_id = ?'
  ).run(Date.now(), Math.max(0, Math.round(duration || 0)), session_id, req.user.id);
  res.json({ ok: true });
});

app.get('/stats', requireAuth, (req, res) => {
  const uid = req.user.id;

  // Totaux globaux
  const totals = db.prepare(`
    SELECT COUNT(*) AS visits, COALESCE(SUM(duration), 0) AS duration
    FROM user_sessions WHERE user_id = ?
  `).get(uid);

  // Ce mois-ci
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
  const monthTs = d.getTime();
  const month = db.prepare(`
    SELECT COUNT(*) AS visits, COALESCE(SUM(duration), 0) AS duration
    FROM user_sessions WHERE user_id = ? AND started_at >= ?
  `).get(uid, monthTs);

  // 30 derniers jours — sessions agrégées par jour
  const since30 = Date.now() - 30 * 24 * 3600 * 1000;
  const dailySessions = db.prepare(`
    SELECT date(started_at / 1000, 'unixepoch') AS day,
           COUNT(*) AS visits,
           COALESCE(SUM(duration), 0) AS duration
    FROM user_sessions
    WHERE user_id = ? AND started_at >= ?
    GROUP BY day ORDER BY day
  `).all(uid, since30);

  // 30 derniers jours — redirections agrégées par jour
  const dailyRedir = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch') AS day,
           COUNT(*) AS redirections
    FROM reservations
    WHERE user_id = ? AND created_at >= ?
    GROUP BY day ORDER BY day
  `).all(uid, since30);

  // Fusion par jour
  const byDay = {};
  for (const s of dailySessions) {
    byDay[s.day] = { date: s.day, visits: s.visits, duration: s.duration, redirections: 0 };
  }
  for (const r of dailyRedir) {
    if (!byDay[r.day]) byDay[r.day] = { date: r.day, visits: 0, duration: 0, redirections: 0 };
    byDay[r.day].redirections = r.redirections;
  }

  const daily = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    total_visits:    totals.visits,
    total_duration:  totals.duration,
    month_visits:    month.visits,
    month_duration:  month.duration,
    avg_duration:    month.visits > 0 ? Math.round(month.duration / month.visits) : 0,
    daily,
  });
});

// ── Favoris ─────────────────────────────────────────────────────────────────

app.get('/favorites', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM favorites WHERE user_id = ?').all(req.user.id));
});

app.post('/favorites', requireAuth, (req, res) => {
  const { scooter_id, operator } = req.body || {};
  if (!scooter_id || !operator) return res.status(400).json({ error: 'scooter_id et operator requis' });
  try {
    db.prepare('INSERT INTO favorites (user_id, scooter_id, operator, created_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, scooter_id, operator, Date.now());
  } catch {}
  res.json({ ok: true });
});

app.delete('/favorites/:scooter_id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND scooter_id = ?')
    .run(req.user.id, req.params.scooter_id);
  res.json({ ok: true });
});

app.get('/scooters', (_req, res) => {
  res.json(cache);
});

app.get('/geofence', (_req, res) => {
  if (!geofenceCache && !accionaGeofenceCache) {
    return res.status(503).json({ error: 'Géofences non chargées' });
  }
  const result = {};
  if (geofenceCache) result.cooltra = geofenceCache;
  if (accionaGeofenceCache) result.acciona = accionaGeofenceCache;
  res.json(result);
});

app.get('/status', (_req, res) => {
  res.json({
    count:      cache.length,
    lastUpdate: lastUpdate,
    operators:  OPERATORS.map(o => o.name),
  });
});

// ── Démarrage ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  loadGeofence();
  loadAccionaGeofence();
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
});
