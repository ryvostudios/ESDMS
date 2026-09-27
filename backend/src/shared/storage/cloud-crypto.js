import crypto from 'node:crypto';
import { cloudConfig } from './cloud-config.js';
import { ServiceUnavailableError } from '../errors/app-error.js';

export function seal(value, context, settings = cloudConfig()) {
  if (!settings.key) throw new ServiceUnavailableError('Cloud storage encryption is unavailable.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(settings.key, 'base64'), iv);
  cipher.setAAD(Buffer.from(`${settings.keyVersion}:${context}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: settings.keyVersion, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}
export function unseal(envelope, context, settings = cloudConfig()) {
  try {
    const value = JSON.parse(envelope);
    if (!settings.key || value.version !== settings.keyVersion) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(settings.key, 'base64'), Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${value.version}:${context}`));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new ServiceUnavailableError('Cloud storage credentials cannot be decrypted. Check deployment key configuration.');
  }
}
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
