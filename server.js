import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config opérateurs ───────────────────────────────────────────────────────

const USE_DIRECT_COOLTRA = false; // true = API Cooltra directe + filtre movo sur Cabify

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
    getToken: async () => {
      const res = await fetch('https://api.accionamobility.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&client_id=mobile_android_202009&client_secret=2agUcvp2EK%3A%3FSFs5mM',
      });
      if (!res.ok) throw new Error(`Acciona token HTTP ${res.status}`);
      const { access_token, expires_in } = await res.json();
      return { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
    },
    normalize: (v) => ({
      id:        `acciona_${v.id}`,
      custom_id: v.custom_id,
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
      // Set CABIFY_TOKEN env var with a valid Bearer token extracted from the app
      // See README for instructions
      'Authorization':         `Bearer ${process.env.CABIFY_TOKEN || ''}`,
      'Accept':                'application/com.cabify.api+json;version=1',
      'Accept-Language':       'en-US',
      'User-Agent':            'CabifyRider/8.228.0 Android/14',
      'x-device-uuid':         process.env.CABIFY_DEVICE_UUID || 'fc87fbe80fb7da7a',
      'bundle-id':             'com.cabify.rider',
      'three-ds2-sdk-version': '2.2.13',
      'dark-theme':            'false',
      'user-time-zone':        'Europe/Madrid',
      'geolocation':           'geo:40.4168,-3.7038;cgen=gps',
    },
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

const REFRESH_MS = 30_000;
let cache        = [];
let lastUpdate   = null;
let geofenceCache        = null;
let accionaGeofenceCache = null;
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
    const outerRings    = full.coordinates[0].slice(1).filter(isMadrid);
    const exclusionPolys = full.coordinates.slice(1).filter(poly => isMadrid(poly[0]));
    geofenceCache = {
      boundary:   { type: 'MultiPolygon', coordinates: outerRings.map(r => [r]) },
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
      headers: { 'Authorization': `Bearer ${tokenCache['acciona'].token}`, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { regions } = await res.json();
    const madrid = regions.find(r => r.id === 1);
    if (!madrid) throw new Error('Région Madrid introuvable');
    const { accepted, denied } = madrid.area;
    accionaGeofenceCache = {
      boundary:   { type: 'MultiPolygon', coordinates: accepted.map(ring => [ring.map(p => [p.lng, p.lat])]) },
      exclusions: { type: 'MultiPolygon', coordinates: denied.map(ring => [ring.map(p => [p.lng, p.lat])]) },
    };
    console.log(`[geofence acciona] ${accepted.length} zones + ${denied.length} interdites`);
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => res.sendFile(join(__dirname, 'index.html')));

app.get('/scooters', (_req, res) => res.json(cache));

app.get('/geofence', (_req, res) => {
  if (!geofenceCache && !accionaGeofenceCache) return res.status(503).json({ error: 'Géofences non chargées' });
  const result = {};
  if (geofenceCache) result.cooltra = geofenceCache;
  if (accionaGeofenceCache) result.acciona = accionaGeofenceCache;
  res.json(result);
});

app.get('/status', (_req, res) => res.json({
  count: cache.length,
  lastUpdate,
  operators: OPERATORS.map(o => o.name),
}));

// ── Démarrage ───────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ScootMap démarré sur http://0.0.0.0:${PORT}`);
  if (!process.env.CABIFY_TOKEN) console.warn('[cabify] CABIFY_TOKEN non défini — les scooters Cabify ne seront pas chargés');
  loadGeofence();
  loadAccionaGeofence();
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
});
