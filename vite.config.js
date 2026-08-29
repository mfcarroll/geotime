// vite.config.js

import { resolve } from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  // Change the base path for production builds
  base: '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html')
      }
    }
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['timezones.geojson', 'cities.json', 'track.json', 'route.json'],
      manifest: {
        name: 'GeoTime Dashboard',
        short_name: 'GeoTime',
        description: 'A world clock and timezone dashboard.',
        theme_color: '#1f2937',
        background_color: '#111827',
        display: 'standalone',
        start_url: '.',
        icons: [
          {
            src: 'icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          }
        ]
      }
    }),
    basicSsl()
  ],
  server: {
    https: true
  },
  preview: {
    https: true
  }
});