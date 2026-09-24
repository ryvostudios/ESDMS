import { ServiceUnavailableError } from '../errors/app-error.js';

export const PROVIDERS = ['dropbox', 'google_drive'];
export function cloudConfig(env = process.env) {
  const key = env.CLOUD_STORAGE_MASTER_KEY;
  if (key && (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32)) {
    throw new Error('Cloud storage encryption key must be a base64-encoded 32-byte key.');
  }
  const providers = {
    dropbox: { clientId: env.DROPBOX_CLIENT_ID, clientSecret: env.DROPBOX_CLIENT_SECRET },
    google_drive: { clientId: env.GOOGLE_DRIVE_CLIENT_ID, clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET },
  };
  if (!key && Object.values(providers).some(p => p.clientId || p.clientSecret)) {
    throw new Error('Cloud storage encryption must be configured before provider application credentials.');
  }
  const origin = env.CLOUD_STORAGE_OAUTH_ORIGIN;
  if (origin) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('Invalid cloud storage callback origin.'); }
    if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) {
      throw new Error('Cloud storage callback requires a bare HTTPS origin (loopback HTTP is allowed locally).');
    }
  }
  const keyVersion = env.CLOUD_STORAGE_KEY_VERSION || '1';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyVersion)) throw new Error('Invalid cloud storage key version.');
  return { key, keyVersion, origin, providers };
}
export function providerSetup(provider, settings = cloudConfig()) {
  const app = settings.providers[provider];
  if (!app?.clientId || !app?.clientSecret || !settings.key || !settings.origin) {
    throw new ServiceUnavailableError('Provider setup incomplete. Contact the deployment administrator.');
  }
  return { ...app, redirectUri: `${settings.origin}/api/v1/cms/cloud-storage/${provider}/callback` };
}
