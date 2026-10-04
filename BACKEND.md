# Backend ScootMap — Documentation

## Démarrage

```bash
node server.js
# ou
npm start
```

Serveur Express sur **http://localhost:3000**. Au démarrage il charge la géofence puis fait un premier fetch immédiat, ensuite toutes les 30s.

---

## Endpoints

| Route | Description |
|---|---|
| `GET /` | Sert `index.html` (le frontend) |
| `GET /scooters` | Cache JSON de tous les scooters |
| `GET /geofence` | Géofence Cooltra (boundary + exclusions) |
| `GET /status` | Compte, date dernier update, liste opérateurs |

### Format `/scooters`

```json
[
  {
    "id": "cooltra_abc123",
    "lat": 40.4168,
    "lng": -3.7038,
    "operator": "cooltra",
    "battery": 87,
    "model": "NIU MQi GT"
  },
  {
    "id": "acciona_456",
    "custom_id": "M1234",
    "lat": 40.42,
    "lng": -3.71,
    "operator": "acciona",
    "battery": 62,
    "model": "Acciona City"
  }
]
```

> Le champ `custom_id` est présent uniquement pour les scooters Acciona — c'est le code visible sur le QR du scooter, utilisable via le bouton "ID" dans l'app.

---

## Opérateurs

### Cooltra

- **URL** : `GET https://api.zeus.cooltra.com/mobile-cooltra/v3/vehicles?system_id=madrid`
- **Auth** : aucune (endpoint public)
- **⚠️ position** : format GeoJSON `[longitude, latitude]` — le normalize inverse bien en `lat/lng`
- **Volume** : ~855 scooters

### Acciona

- **URL** : `GET https://api.accionamobility.com/v1/fleet/info/region/1` (region 1 = Madrid)
- **Auth** : OAuth2 `client_credentials`
  - `client_id` : `<ACCIONA_CLIENT_ID>`
  - `client_secret` : `<ACCIONA_CLIENT_SECRET>` (URL-encodé : `%3A%3F`)
  - Token valide **~7 jours** (`expires_in: 604799`)
  - Le backend gère le renouvellement automatique (le token est mis en cache dans `tokenCache['acciona']` et renouvelé si expiré)
- **Volume** : ~1323 scooters

### Cabify (Movo)

- **URL** : `GET https://rider.cabify.com/rider-cp/api/v3/asset_sharing/assets?lat=40.4168&lon=-3.7038&radius=30000&max_elements_per_type=500`
- **Auth** : Bearer token JWT ES256, **extrait manuellement de l'app Android** (voir section Token Cabify)
- **⚠️ Cabify agrège plusieurs providers** : son API retourne aussi les scooters Cooltra. En mode `USE_DIRECT_COOLTRA=false` (défaut), on garde tout et on relabellise `provider=movo` → `operator=cabify`. En mode `USE_DIRECT_COOLTRA=true`, on filtre `provider === 'movo'` pour éviter les doublons.
- **Volume** : ~804 scooters Movo + les Cooltra si mode agrégation

---

## Flag USE_DIRECT_COOLTRA

En haut de `server.js` :

```js
const USE_DIRECT_COOLTRA = false; // défaut recommandé
```

| Mode | Description |
|---|---|
| `false` (défaut) | Cooltra vient de l'API Cabify → une requête de moins, pas de doublons à filtrer, mais le label affiché est `cooltra` (provider Cabify) |
| `true` | Cooltra vient de son API directe + Cabify filtrée sur `provider=movo` uniquement → deux requêtes, labels plus précis |

---

## Token Acciona — comment ça marche

Contrairement à Cabify, **rien n'est à faire manuellement** : le backend gère le token Acciona de façon entièrement automatique.

L'auth utilise le flow OAuth2 **`client_credentials`** (machine-to-machine) : le backend appelle directement l'endpoint token avec les identifiants de l'app mobile, sans intervention humaine.

```
POST https://api.accionamobility.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<ACCIONA_CLIENT_ID>
&client_secret=<ACCIONA_CLIENT_SECRET (url-encoded)>
```

Le token reçu est mis en cache dans `tokenCache['acciona']` avec son `expiresAt`. Avant chaque requête, le backend vérifie si le token est expiré et en demande un nouveau si besoin. Le token dure ~7 jours (`expires_in: 604799`).

### Si ça casse quand même

Le seul cas où ça peut échouer est si Acciona révoque les credentials `<ACCIONA_CLIENT_ID>` (changement de version d'app, rotation de secrets). Dans ce cas :

1. Regarder la console — le log sera `[acciona] erreur : HTTP 401` ou `Token HTTP 401`
2. Extraire les nouveaux credentials depuis l'APK Acciona à jour :
   - Décoder l'APK avec `apktool`
   - Lire `assets/app.config` → chercher `client_id` et `client_secret`
3. Mettre à jour les valeurs dans `server.js` dans la fonction `getToken` de l'opérateur acciona
4. Redémarrer le serveur

> Le fichier `app.config` extrait est disponible ici pour référence :
> `apk-patch/acciona/base-decoded/assets/app.config`

---

## Token Cabify — comment le renouveler

Le JWT a `exp` à **30 min**, mais le serveur Cabify valide par **session** (`sid`) donc le token reste valide tant que la session est active côté serveur (plusieurs heures voire jours).

Quand la session expire (le backend retourne 401 sur l'endpoint Cabify), il faut extraire un nouveau token :

### Procédure

1. Lancer l'émulateur Android `cabify_avd`
2. Ouvrir l'app Cabify et se connecter
3. Extraire la base SQLite :

```bash
adb root
adb pull /data/data/com.cabify.rider/databases/
```

4. Ouvrir le fichier DB extrait avec un outil SQLite (ex: `sqlite3`, DB Browser for SQLite)
5. Dans la table `OAuthAuthorizationForUser`, colonne `data` (JSON) → extraire `authorization.accessToken`
6. Coller le nouveau token dans `server.js` dans le header `Authorization` de l'opérateur cabify :

```js
'Authorization': 'Bearer NOUVEAU_TOKEN_ICI',
```

7. Redémarrer le serveur

---

## Cache et refresh

- Les données sont stockées en mémoire dans `cache` (tableau de scooters)
- `lastUpdate` : timestamp du dernier fetch réussi
- Refresh automatique toutes les **30s** (`setInterval`)
- Les opérateurs sont fetchés en parallèle (`Promise.allSettled`) — si un opérateur échoue, les autres continuent
- Les erreurs par opérateur sont loggées en console mais n'interrompent pas le cycle

---

## Géofence

Chargée au démarrage depuis l'API Cooltra :

```
GET https://api.zeus.cooltra.com/mobile-cooltra/v3/geofence
```

Exposée via `GET /geofence` avec deux clés :

```json
{
  "boundary": { "type": "MultiPolygon", ... },
  "exclusions": { "type": "MultiPolygon", ... }
}
```

- `boundary` : contour de la zone de service Madrid
- `exclusions` : zones interdites à l'intérieur (parcs, aéroport, etc.)

Utilisée par le frontend pour masquer le reste du monde et afficher les zones grises.
Si la géofence n'a pas pu être chargée, `/geofence` retourne `503`.

---

## CORS

Middleware global qui ajoute `Access-Control-Allow-Origin: *` sur toutes les routes → le frontend (et l'app mobile) peuvent requêter depuis n'importe quelle origine.
