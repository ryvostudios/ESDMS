import { apiClient } from '../../core/api/client.js';

// The static HTML remains the offline/login fallback. Only a successful,
// public CMS response replaces icon/manifest links; no auth or token is used.
export async function loadWebBranding() {
  try {
    const response=await apiClient.get('/cms/branding/public');
    const version=response?.data?.appIconVersion;
    if (version !== null && (typeof version!=='string' || !/^[a-f0-9]{64}$/.test(version))) return;
    for (const link of document.querySelectorAll('link[rel="manifest"]')) {
      link.href='/api/v1/cms/branding/manifest.webmanifest';
    }
    if (!version) return;
    for (const link of document.querySelectorAll('link[rel="icon"]')) {
      const size=link.sizes?.value==='192x192'?192:32;
      link.href=`/api/v1/cms/branding/app-icon/${size}?v=${version}`;
      link.type='image/png';
    }
    for (const link of document.querySelectorAll('link[rel="apple-touch-icon"]')) {
      link.href=`/api/v1/cms/branding/app-icon/180?v=${version}`;
    }
  } catch { /* bundled fallback */ }
}
