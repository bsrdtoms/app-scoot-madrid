# 🛵 ScootMap — Madrid

Carte en temps réel des scooters en libre-service à Madrid.  
Aggrège **Cooltra**, **Acciona** et **Cabify (Movo)** sur une seule carte Leaflet.

![scooters](https://img.shields.io/badge/scooters-~2500-7c3aed)
![node](https://img.shields.io/badge/node-22+-green)

## Fonctionnalités

- 🗺️ Carte Leaflet + OpenStreetMap
- 🔄 Mise à jour automatique toutes les 30 secondes
- 🔋 Indicateur de batterie par scooter
- 📍 Géofence Cooltra + Acciona
- 📱 Deep links vers les apps opérateurs
- 🚀 Prêt pour Fly.io (free tier)

## Démarrage local

```bash
npm install

# Token Cabify requis (voir ci-dessous)
export CABIFY_TOKEN="eyJ..."

node server.js
# → http://localhost:3000
```

## Variables d'environnement

| Variable | Requis | Description |
|---|---|---|
| `CABIFY_TOKEN` | Oui | Bearer token extrait de l'app Cabify Android |
| `CABIFY_DEVICE_UUID` | Non | UUID de l'appareil (par défaut : `fc87fbe80fb7da7a`) |
| `PORT` | Non | Port d'écoute (défaut : `3000`) |

### Obtenir le token Cabify

Le token Cabify est lié à un compte utilisateur. Pour l'extraire :

```bash
# Avec un émulateur Android rooté (ou appareil rooté)
adb root
adb pull /data/data/com.cabify.rider/databases/ ./cabify-db/

# Dans la DB SQLite, table OAuthAuthorizationForUser,
# colonne data (JSON), champ authorization.accessToken
```

> **Note :** Le token expire après ~30 min mais la session (`sid`) reste valide bien plus longtemps.

## Déploiement sur Fly.io (gratuit)

```bash
# Installer flyctl
curl -L https://fly.io/install.sh | sh

# Créer et déployer l'app
fly launch --name scootmap --region ams
fly secrets set CABIFY_TOKEN="eyJ..."
fly deploy

# Logs en direct
fly logs
```

## Architecture

```
GET /scooters  → JSON array de tous les scooters (cache 30s)
GET /geofence  → GeoJSON des zones de service Cooltra + Acciona
GET /status    → état du serveur
```

## Opérateurs

| Opérateur | Auth | Endpoint |
|---|---|---|
| Cooltra | Aucune (public) | `api.zeus.cooltra.com` |
| Acciona | OAuth2 client_credentials | `api.accionamobility.com` |
| Cabify (Movo) | Bearer token utilisateur | `rider.cabify.com` |
