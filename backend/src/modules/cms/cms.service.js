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

export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError('Invalid configuration.',result.error.flatten());
  return result.data;
}
export async function publicContent() {
  const rows = await repo.settings();
  return Object.fromEntries(rows.filter(row => Object.hasOwn(SETTINGS,row.key)).map(row => [row.key,row.value]));
}
export async function listSettings(category) {
  return (await repo.settings()).filter(row => SETTINGS[row.key]?.category === category).map(row => ({...row,...SETTINGS[row.key],type:'plain_text',scope:'company'}));
}
export async function updateSetting(actor, key, body) {
  const definition = Object.hasOwn(SETTINGS,key) ? SETTINGS[key] : null;
  if (!definition) throw new NotFoundError('Unknown configuration key.');
  if (!actor.permissions.has(`cms.${definition.category}.manage`)) throw new ForbiddenError();
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
    {name:'Dropbox',state:'not_configured',detail:'Not implemented. Future account linking will use OAuth.'},
    {name:'Google Drive',state:'not_configured',detail:'Not implemented. Future account linking will use OAuth.'},
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
