import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'E-Set Digital Management System',
        short_name: 'E-Set DMS',
        description: 'Secure Gate Pass and Workforce operations for E-Set sites.',
        theme_color: '#15191e',
        background_color: '#eef2f5',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/maskable-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/maskable-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precached, cache-first: only the built app shell (HTML/JS/CSS/
        // icons) — static, non-sensitive, versioned per build.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // Everything under /api/ is private operational data, auth state,
        // or audit/authorization information — never cached, always live.
        // NetworkOnly, not NetworkFirst, so a stale response is never
        // served even as a fallback.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/api/'),
            handler: 'NetworkOnly',
          },
        ],
        // The SPA navigation fallback (serving index.html for any
        // unmatched route, so client-side routing works on a hard
        // refresh/deep link) must never apply to a direct browser
        // navigation to /api/... — that must reach the real API (and get
        // its real 404/401/whatever), never the app shell HTML.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
})
