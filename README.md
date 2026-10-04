# 🛵 ScootMap

**Tous les scooters en libre-service d'une ville, sur une seule carte en temps réel.**

À Madrid, trois opérateurs de scooters partagés cohabitent — **Cooltra**, **Acciona** et **Cabify/Movo** — chacun avec sa propre application. Pour trouver le scooter disponible le plus proche avec assez de batterie, il faut ouvrir les trois apps, les comparer une à une, et espérer ne pas en avoir raté un plus proche.

ScootMap remplace cette comparaison app-par-app par **un seul coup d'œil** : une carte qui agrège en temps réel la position de tous les scooters, tous opérateurs confondus.

> Né d'un besoin réel pendant un Erasmus à Madrid. Le même problème existe à Paris (Cooltra, Yego) et dans la plupart des grandes villes européennes.

---

## ✨ Fonctionnalités

- 🗺️ **Carte temps réel** (Leaflet / OpenStreetMap) centrée sur la position de l'utilisateur
- 🎨 **Marqueurs par opérateur**, couleur dédiée + niveau de batterie
- 🔄 **Rafraîchissement automatique toutes les 30 s**
- 🚫 **Géofence** intégrée : zones de service et zones interdites
- 👤 **Comptes utilisateurs** (JWT + bcrypt), **réservations**, **favoris**, **statistiques d'usage**
- 📱 **PWA installable** (manifest, service worker, icônes maskables)
- 🧪 Ébauche d'une **app mobile native** (React Native / Expo) dans `mobile/`

## 🏗️ Architecture

```
┌──────────────┐   poll /30s    ┌─────────────────────┐
│  Frontend    │ ◀───────────── │  Backend Express     │
│  Leaflet PWA │   GET /scooters│  (Node.js)           │
└──────────────┘                │                      │
                                │  ┌────────────────┐  │
                                │  │ Cooltra  (REST) │  │
                                │  │ Acciona (OAuth2)│  │
                                │  │ Cabify  (Bearer)│  │
                                │  └────────────────┘  │
                                │  SQLite (users, …)   │
                                └─────────────────────┘
```

Les trois opérateurs sont interrogés **en parallèle** (`Promise.allSettled`) : si l'un échoue, les autres continuent. Le détail de chaque API (auth, format de réponse, pièges) est documenté dans **[BACKEND.md](BACKEND.md)**.

## 🚀 Démarrage

```bash
npm install
cp .env.example .env     # puis renseigner les credentials opérateurs
npm start                # → http://localhost:3000
```

Les identifiants des opérateurs ne sont **pas** versionnés : voir [`.env.example`](.env.example).

## 📡 API

| Route            | Description                               |
|------------------|-------------------------------------------|
| `GET /scooters`  | Tous les scooters en cache (JSON)         |
| `GET /geofence`  | Contour de service + zones interdites     |
| `GET /status`    | Compteur, dernier update, opérateurs      |
| `POST /auth/*`   | Inscription / connexion (JWT)             |
| `GET /me`, `/reservations`, `/favorites`, `/stats` | Espace utilisateur |

Format `/scooters` :

```json
[{ "id": "cooltra_abc", "lat": 40.4168, "lng": -3.7038,
   "operator": "cooltra", "battery": 87, "model": "NIU MQi GT" }]
```

## 🗺️ Roadmap

- [ ] **App iOS native** (SwiftUI + MapKit) à partir du prototype web
- [ ] **Siri & App Intents** — « Trouve-moi le scooter le plus proche »
- [ ] **Extension à Paris** (Cooltra, Yego) puis d'autres villes
- [ ] Vérification d'identité / permis et paiement intégré

## 🛠️ Stack

Node.js · Express · SQLite (better-sqlite3) · JWT · bcrypt · Leaflet · PWA · React Native/Expo

---

*Projet personnel — Thomas Bossard.*
