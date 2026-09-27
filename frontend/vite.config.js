import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// ESDMS_DEV_API_TARGET (optional, dev-only): points the Vite dev server's
// /api proxy at a remote backend (e.g. a deployed test environment) instead
// of the browser calling it directly cross-origin. Keeps every request
// same-origin from the browser's perspective, so it rides the existing
// HttpOnly session cookie without touching backend CORS/cookie config.
// Unset by default — normal local dev is unaffected.
const devApiTarget = process.env.ESDMS_DEV_API_TARGET;
const buildRevision = process.env.VITE_BUILD_REVISION || process.env.RENDER_GIT_COMMIT || 'development';

if (!/^[A-Za-z0-9._-]{1,100}$/.test(buildRevision)) {
  throw new Error('VITE_BUILD_REVISION must be a non-secret revision label using letters, numbers, dots, underscores or hyphens.');
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_REVISION': JSON.stringify(buildRevision),
  },
  server: devApiTarget
    ? {
        proxy: {
          "/api": {
            target: devApiTarget,
            changeOrigin: true,
            secure: true,
          },
        },
      }
    : undefined,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
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
