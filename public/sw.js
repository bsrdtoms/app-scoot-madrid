// Service Worker minimal — requis pour le prompt d'installation PWA
const CACHE = 'scootmap-v1';

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

// Pas de cache agressif — on laisse le réseau gérer (données temps réel)
self.addEventListener('fetch', _e => {});
