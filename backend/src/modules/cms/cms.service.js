import { z } from 'zod';
import { SETTINGS } from './cms.config.js';
import { plainText } from './cms.validation.js';
import * as repo from './cms.repository.js';
import { withTransaction } from '../../shared/db/with-transaction.js';
import { recordGovernanceAudit } from '../../shared/audit/governance-audit.repository.js';
import { ValidationError, NotFoundError, ForbiddenError, ConflictError } from '../../shared/errors/app-error.js';
import { inspectSchemaCompatibility } from '../../shared/db/schema-compatibility.js';
import { inspectRuntimeCompatibility } from '../../shared/db/runtime-compatibility.js';
import pool from '../../config/database.js';
import config from '../../config/env.js';
import { storageService, verifyChecksum } from '../../shared/storage/storage-service.js';
import { defaultLogoBytes, parseLogoReference } from '../../shared/documents/branding.js';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError('Invalid configuration.',result.error.flatten());
  return result.data;
}
const isManaged = key => Boolean(SETTINGS[key]?.managed);
export async function publicContent() {
  const rows = await repo.settings();
  return Object.fromEntries(rows.filter(row => Object.hasOwn(SETTINGS,row.key) && !isManaged(row.key)).map(row => [row.key,row.value]));
}
// Safe, human-readable description of a logo reference: used for the CMS view
// and the audit trail. Never the storage key, never bytes.
export function describeLogo(reference) {
  if (!reference) return 'Default E-Set logo';
  return `Uploaded ${reference.mimeType==='image/png'?'PNG':'JPEG'} ${reference.width}×${reference.height}, ${Math.ceil(reference.sizeBytes/1024)} KB, sha256 ${reference.sha256.slice(0,12)}`;
}
const describeManagedArtwork = (key,reference) => key==='company.app_icon' && !reference
  ? 'No custom icon (uses the company logo)' : describeLogo(reference);
export async function listSettings(category) {
  return (await repo.settings()).filter(row => SETTINGS[row.key]?.category === category).map(row => {
    const {managed,...definition} = SETTINGS[row.key];
    if (!managed) return {...row,...definition,type:'plain_text',scope:'company'};
    const reference = parseLogoReference(row.value);
    return {key:row.key,category:row.category,revision:row.revision,updated_at:row.updated_at,...definition,type:'logo',scope:'company',
      logo:{source:reference?'uploaded':'default',description:describeManagedArtwork(row.key,reference)}};
  });
}
export async function updateSetting(actor, key, body) {
  const definition = Object.hasOwn(SETTINGS,key) ? SETTINGS[key] : null;
  if (!definition) throw new NotFoundError('Unknown configuration key.');
  if (!actor.permissions.has(`cms.${definition.category}.manage`)) throw new ForbiddenError();
  if (definition.managed) throw new ValidationError('This setting is changed through its own upload endpoint.');
  const input = parse(z.object({value:plainText(definition.max,definition.min),revision:z.number().int().positive()}).strict(),body);
  return withTransaction(async client => {
    const current = (await client.query('SELECT value,revision FROM cms_settings WHERE key=$1 FOR UPDATE',[key])).rows[0];
    if (!current) throw new NotFoundError('Configuration not found.');
    if (current.revision !== input.revision) throw new ConflictError('Configuration changed. Reload before saving.');
    if (current.value === input.value) return {key,...current};
    const updated = await client.query('UPDATE cms_settings SET value=$2,revision=revision+1,updated_at=CURRENT_TIMESTAMP,updated_by_user_id=$3 WHERE key=$1 RETURNING key,value,revision',[key,input.value,actor.id]);
    await recordGovernanceAudit(client,{actorUserId:actor.id,action:'CMS_SETTING_CHANGED',metadata:{key,before:current.value,after:input.value}});
    return updated.rows[0];
  });
}
export async function updatePermission(actor, code, input) {
  return withTransaction(async client => {
    const before = (await client.query('SELECT display_name,description,category,help_text FROM permissions WHERE code=$1 FOR UPDATE',[code])).rows[0];
    if (!before) throw new NotFoundError('Permission not found.');
    const after = {display_name:input.displayName,description:input.description,category:input.category,help_text:input.helpText};
    await client.query('UPDATE permissions SET display_name=$2,description=$3,category=$4,help_text=$5 WHERE code=$1',[code,input.displayName,input.description,input.category,input.helpText]);
    await recordGovernanceAudit(client,{actorUserId:actor.id,action:'PERMISSION_METADATA_CHANGED',metadata:{code,before,after}});
    return {code,...after};
  });
}
export async function audit(actor, query) {
  const ceo = actor.role === 'CEO';
  if (!ceo && query.siteId && query.siteId !== actor.siteId) throw new ForbiddenError('Audit is limited to your assigned site.');
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new ValidationError('Invalid date range.');
  const result = await repo.audit({scope:actor.siteId,ceo,query});
  return {...result,items:result.items.map(row=>({...row,change:Object.hasOwn(SETTINGS,row.configuration_key) ? row.change : null}))};
}
export function integrations() {
  return [
    {name:'Attendance',state:'not_configured',detail:'Deferred until the company PC attendance application is supplied.'},
    {name:'Current file storage',state:'configured',detail:`${config.storageProvider} provider selected; connectivity is not verified here.`},
    {name:'Notifications',state:config.whatsapp.enabled?'configured':'not_configured',detail:'Provider configuration only; delivery and connectivity are not verified here.'},
  ];
}
export async function systemInfo() {
  const [schema,runtime] = await Promise.all([inspectSchemaCompatibility(pool),inspectRuntimeCompatibility(pool,{requireRuntimeRole:config.isProduction})]);
  return {backendRevision:config.buildRevision,environment:config.nodeEnv,
    expectedMigration:schema.expectedMigration,latestMigration:schema.latestAppliedMigration,
    expectedProvisioning:runtime.expectedRuntimeProvisioning,actualProvisioning:runtime.actualRuntimeProvisioning,
    ready:schema.ready && runtime.runtimeProvisioningCompatible,
    schemaCompatible:schema.schemaCompatible,authServingHealthy:schema.authServingHealthy,
    runtimeAccessHealthy:schema.runtimeAccessHealthy,runtimeProvisioningCompatible:runtime.runtimeProvisioningCompatible};
}

// Public read of the active logo (the sign-in screen needs it before
// authentication). A configured logo that cannot be read or fails its
// checksum is reported missing — never silently replaced by another logo.
export async function activeLogo() {
  const row = (await repo.settings()).find(item => item.key === 'company.logo');
  const reference = parseLogoReference(row?.value);
  if (!reference) {
    const buffer = defaultLogoBytes();
    if (!buffer) throw new NotFoundError('Logo not available.');
    return {buffer,mimeType:'image/png',etag:'default'};
  }
  let buffer;
  try { buffer = await storageService.read(reference.storageKey); } catch { throw new NotFoundError('Logo not available.'); }
  if (!verifyChecksum(buffer,reference.sha256)) throw new NotFoundError('Logo not available.');
  return {buffer,mimeType:reference.mimeType,etag:reference.sha256};
}

async function writeLogo(actor, revision, nextValue, key = 'company.logo') {
  if (key !== 'company.logo' && key !== 'company.app_icon') throw new ValidationError('Unknown managed artwork.');
  return withTransaction(async client => {
    const current = (await client.query('SELECT value,revision FROM cms_settings WHERE key=$1 FOR UPDATE',[key])).rows[0];
    if (!current) throw new NotFoundError('Configuration not found.');
    if (current.revision !== revision) throw new ConflictError('Configuration changed. Reload before saving.');
    const updated = await client.query(
      'UPDATE cms_settings SET value=$1,revision=revision+1,updated_at=CURRENT_TIMESTAMP,updated_by_user_id=$2 WHERE key=$3 RETURNING revision',
      [nextValue,actor.id,key]);
    await recordGovernanceAudit(client,{actorUserId:actor.id,action:'CMS_SETTING_CHANGED',metadata:{
      key,before:describeManagedArtwork(key,parseLogoReference(current.value)),after:describeManagedArtwork(key,parseLogoReference(nextValue))}});
    return {key,revision:updated.rows[0].revision,logo:{source:nextValue?'uploaded':'default',description:describeManagedArtwork(key,parseLogoReference(nextValue))}};
  });
}
const revisionSchema = z.object({revision:z.coerce.number().int().positive()}).strict();

// Bytes are stored through the existing storage service under a
// server-generated key. Superseded logos are kept, not deleted: they are
// configuration history, and issued documents already embed their own copy.
export async function replaceLogo(actor, body, logo) {
  if (!actor.permissions.has('cms.branding.manage')) throw new ForbiddenError();
  const {revision} = parse(revisionSchema,body);
  const saved = await storageService.save(logo.buffer,{namespace:'cms',gatePassId:'branding',category:'logo',extension:logo.extension});
  try {
    return await writeLogo(actor,revision,JSON.stringify({storageKey:saved.storageKey,sha256:saved.checksumSha256,
      mimeType:logo.mimeType,width:logo.width,height:logo.height,sizeBytes:saved.sizeBytes}));
  } catch (error) {
    await storageService.remove(saved.storageKey);
    throw error;
  }
}
export async function resetLogo(actor, body) {
  if (!actor.permissions.has('cms.branding.manage')) throw new ForbiddenError();
  return writeLogo(actor,parse(revisionSchema,body).revision,'');
}

export async function replaceAppIcon(actor, body, icon) {
  if (!actor.permissions.has('cms.branding.manage')) throw new ForbiddenError();
  const {revision} = parse(revisionSchema,body);
  const saved = await storageService.save(icon.buffer,{namespace:'cms',gatePassId:'branding',category:'app-icon',extension:'png'});
  try {
    return await writeLogo(actor,revision,JSON.stringify({storageKey:saved.storageKey,sha256:saved.checksumSha256,
      mimeType:'image/png',width:512,height:512,sizeBytes:saved.sizeBytes}),'company.app_icon');
  } catch (error) {
    await storageService.remove(saved.storageKey);
    throw error;
  }
}

export async function resetAppIcon(actor, body) {
  if (!actor.permissions.has('cms.branding.manage')) throw new ForbiddenError();
  return writeLogo(actor,parse(revisionSchema,body).revision,'','company.app_icon');
}

// Missing CMS/storage never blocks login or the shell: callers retain the
// bundled icons. Public responses contain only a digest/version, no key.
export async function activeAppIcon() {
  const row = (await repo.settings()).find(item => item.key === 'company.app_icon');
  const reference = parseLogoReference(row?.value);
  if (!reference || reference.mimeType !== 'image/png' || reference.width !== 512 || reference.height !== 512) return null;
  try {
    const buffer = await storageService.read(reference.storageKey);
    if (!verifyChecksum(buffer,reference.sha256)) return null;
    return {buffer,version:reference.sha256};
  } catch { return null; }
}

// Browser/PWA artwork: the custom square icon, otherwise the active company
// logo. null (nothing readable) leaves the bundled static icons in place.
async function activeIconSource() {
  const icon = await activeAppIcon();
  if (icon) return icon;
  try {
    const logo = await activeLogo();
    return {buffer:logo.buffer,fromLogo:true,
      version:createHash('sha256').update('logo-icon\0').update(logo.buffer).digest('hex')};
  } catch { return null; }
}

export async function appIconVariant(size) {
  if (![32,180,192,512].includes(size)) throw new NotFoundError('Icon not available.');
  const icon = await activeIconSource();
  if (!icon) throw new NotFoundError('Icon not available.');
  let buffer;
  if (!icon.fromLogo) {
    buffer = size === 512 ? icon.buffer : await sharp(icon.buffer,{limitInputPixels:512*512,failOn:'warning'})
      .resize(size,size).png().toBuffer();
  } else {
    // Letterboxed, never stretched or cropped; transparency is kept, except
    // the Apple touch icon, which iOS would otherwise fill with black.
    buffer = await sharp(icon.buffer,{limitInputPixels:4096*4096,failOn:'warning'})
      .resize(size,size,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    // A second pass: sharp flattens before resizing, which would leave the letterbox transparent.
    if (size === 180) buffer = await sharp(buffer).flatten({background:'#ffffff'}).png().toBuffer();
  }
  return {buffer,etag:`${icon.version}-${size}`};
}

export async function publicWebBranding() {
  let version = null;
  try { version = (await activeIconSource())?.version || null; } catch { /* bundled fallback */ }
  return {appIconVersion:version};
}

export async function publicManifest() {
  let content = {};
  try { content = await publicContent(); } catch { /* bundled fallback */ }
  const {appIconVersion} = await publicWebBranding();
  const iconUrl = (size,maskable=false) => appIconVersion
    ? `/api/v1/cms/branding/app-icon/${size}?v=${appIconVersion}`
    : `/${maskable?'maskable-':''}icon-${size}.png`;
  const icons = appIconVersion ? [
    {src:iconUrl(192),sizes:'192x192',type:'image/png',purpose:'any'},
    {src:iconUrl(512),sizes:'512x512',type:'image/png',purpose:'any'},
  ] : [
    {src:iconUrl(192),sizes:'192x192',type:'image/png',purpose:'any'},
    {src:iconUrl(512),sizes:'512x512',type:'image/png',purpose:'any'},
    {src:iconUrl(192,true),sizes:'192x192',type:'image/png',purpose:'maskable'},
    {src:iconUrl(512,true),sizes:'512x512',type:'image/png',purpose:'maskable'},
  ];
  const manifest = {
    name:content['company.display_name'] || 'E-Set Digital Management System',
    short_name:content['company.short_name'] || 'E-Set DMS',
    theme_color:'#15191e',background_color:'#eef2f5',display:'standalone',start_url:'/',scope:'/',
    icons,
  };
  const body = JSON.stringify(manifest);
  return {body,etag:createHash('sha256').update(body).digest('hex')};
}
