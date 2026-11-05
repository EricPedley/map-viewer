import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// Served from the root of the custom domain https://navigation.ericpedley.com/
// (GitHub Pages custom domain), so assets resolve from '/'.
export default defineConfig({
  base: '/',
  define: {
    // package.json's version is the single source of truth for the version
    // shown in the app — bump it there when tagging a release.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
        name: "Eric's Cycling App",
        short_name: "Eric's Cycling",
        description: 'Offline map and turn-by-turn viewer for cycling routes.',
        display: 'standalone',
        background_color: '#14161a',
        theme_color: '#14161a',
        // No leading slash: vite-plugin-pwa prepends the resolved `base`
        // (see `base` above) to these itself.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
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
