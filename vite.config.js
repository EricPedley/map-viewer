import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    // route.json is a single ~450KB bundled data file; raise the default
    // chunk-size warning threshold instead of pointlessly code-splitting it.
    chunkSizeWarningLimit: 1000,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      manifest: {
        name: 'Of Milk and Navvies — Offline Map',
        short_name: 'Milk & Navvies',
        description: 'Offline map viewer for the Of Milk and Navvies bikepacking route (Norway).',
        start_url: '/',
        display: 'standalone',
        background_color: '#14161a',
        theme_color: '#14161a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell + route/POI data + icons — always available offline.
        globPatterns: ['**/*.{js,css,html,json,svg,png,ico,webmanifest}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // Esri World Imagery satellite tiles. Matches both tiles fetched
            // by Leaflet while panning online and tiles fetched by the
            // in-app "Download for offline" feature — both paths write into
            // the same cache so pre-downloaded areas work with no signal.
            urlPattern: /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'satellite-tiles-v1',
              expiration: {
                maxEntries: 40000,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
