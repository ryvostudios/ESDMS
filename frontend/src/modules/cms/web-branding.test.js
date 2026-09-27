import { beforeEach, expect, test, vi } from 'vitest';
import { loadWebBranding } from './web-branding.js';
const state=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('../../core/api/client.js',()=>({apiClient:{get:state.get}}));

beforeEach(()=>{
  state.get.mockReset();
  document.head.innerHTML='<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">';
});

test('public icon version switches all shell links to versioned Permit-independent ESDMS endpoints',async()=>{
  const version='a'.repeat(64);
  state.get.mockResolvedValue({data:{appIconVersion:version}});
  await loadWebBranding();
  expect(document.querySelector('link[rel="icon"]').href).toContain(`/api/v1/cms/branding/app-icon/32?v=${version}`);
  expect(document.querySelector('link[rel="apple-touch-icon"]').href).toContain(`/api/v1/cms/branding/app-icon/180?v=${version}`);
  expect(document.querySelector('link[rel="manifest"]').href).toContain('/api/v1/cms/branding/manifest.webmanifest');
});

test('CMS unavailable or malformed leaves bundled manifest and icons usable',async()=>{
  state.get.mockRejectedValue(new Error('offline'));
  await loadWebBranding();
  expect(document.querySelector('link[rel="icon"]').getAttribute('href')).toBe('/favicon.png');
  expect(document.querySelector('link[rel="manifest"]').getAttribute('href')).toBe('/manifest.webmanifest');
  state.get.mockResolvedValue({data:{appIconVersion:'not-a-version'}});
  await loadWebBranding();
  expect(document.querySelector('link[rel="icon"]').getAttribute('href')).toBe('/favicon.png');
});

test('public CMS with no readable logo or icon (version null) uses its manifest with bundled icon fallbacks',async()=>{
  state.get.mockResolvedValue({data:{appIconVersion:null}});
  await loadWebBranding();
  expect(document.querySelector('link[rel="icon"]').getAttribute('href')).toBe('/favicon.png');
  expect(document.querySelector('link[rel="manifest"]').getAttribute('href')).toBe('/api/v1/cms/branding/manifest.webmanifest');
});
