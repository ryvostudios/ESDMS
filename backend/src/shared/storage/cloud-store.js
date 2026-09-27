import crypto from 'node:crypto';
import pool from '../../config/database.js';
import { withTransaction } from '../db/with-transaction.js';
import { seal, unseal, digest } from './cloud-crypto.js';
import { exchangeTokens, providerClient, MAX_CLOUD_BYTES } from './cloud-providers.js';
import { folderPath, storageContext } from './cloud-paths.js';
import { ServiceUnavailableError } from '../errors/app-error.js';
import { logServerError } from '../logging/safe-logger.js';
import { recordGovernanceAudit } from '../audit/governance-audit.repository.js';

export async function connectionClient(connection) {
  let tokens = unseal(connection.credentials,`connection:${connection.id}`);
  if (tokens.expiresAt < Date.now()+60_000) {
    tokens = await exchangeTokens(connection.provider,{grant_type:'refresh_token',refresh_token:tokens.refreshToken});
    const updated = await pool.query(`UPDATE cloud_storage_connections SET credentials=$2,token_revision=token_revision+1
      WHERE id=$1 AND token_revision=$3 AND revision=$4 AND status IN ('connected','error') RETURNING id`,
    [connection.id,seal(tokens,`connection:${connection.id}`),connection.token_revision,connection.revision]);
    if (!updated.rowCount) {
      const latest = (await pool.query('SELECT * FROM cloud_storage_connections WHERE id=$1',[connection.id])).rows[0];
      if (!latest?.credentials || latest.revision!==connection.revision || latest.status==='disconnecting') throw new ServiceUnavailableError('Cloud storage connection changed. Retry the operation.');
      tokens = unseal(latest.credentials,`connection:${connection.id}`);
    }
  }
  return {client:providerClient(connection.provider,tokens.accessToken),tokens};
}
export async function recordCloudAudit(executor, actorId, event, connection, extra = {}) {
  await recordGovernanceAudit(executor,{actorUserId:actorId,action:'CLOUD_STORAGE_CHANGED',metadata:{
    event,provider:connection?.provider || 'legacy',connectionId:connection?.id || null,...extra,
  }});
}
export async function health(connection, ok, test = false) {
  await pool.query(`UPDATE cloud_storage_connections SET last_success_at=CASE WHEN $2 THEN now() ELSE last_success_at END,
    last_test_at=CASE WHEN $3 THEN now() ELSE last_test_at END,last_error=CASE WHEN $2 THEN NULL ELSE 'provider_unavailable' END
    WHERE id=$1 AND revision=$4`,[connection.id,ok,test,connection.revision]);
}
export async function ensureFolders(connection, client, segments) {
  let parent = null; const parts=[];
  for (const name of segments) {
    parts.push(name); const path=parts.join('/');
    let row=(await pool.query('SELECT * FROM cloud_storage_objects WHERE connection_id=$1 AND account_id=$2 AND logical_path=$3',[connection.id,connection.account_id,path])).rows[0];
    if (!row) {
      const id=await client.allocateId();
      row=(await pool.query(`INSERT INTO cloud_storage_objects(connection_id,account_id,kind,logical_path,provider_id)
        VALUES ($1,$2,'folder',$3,$4) ON CONFLICT(connection_id,account_id,logical_path) DO UPDATE SET logical_path=EXCLUDED.logical_path RETURNING *`,[connection.id,connection.account_id,path,id])).rows[0];
    }
    if (row.state!=='ready') {
      const id=await client.folder({path,id:row.provider_id,name,parent});
      await pool.query("UPDATE cloud_storage_objects SET provider_id=$2,state='ready' WHERE id=$1",[row.id,id]);
      row.provider_id=id;
    }
    parent=row.provider_id;
  }
  return parent;
}
const MIME = {pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const cloudId = key => {
  if (!/^cloud:[a-f0-9-]{36}$/.test(key)) throw new ServiceUnavailableError('Invalid cloud file reference.');
  return key.slice(6);
};
export class RoutedStorageService {
  constructor(legacy) { this.legacy=legacy; }
  verifyChecksum(...args) { return this.legacy.verifyChecksum(...args); }
  async save(buffer, params) {
    // Snapshot selection and reserve ownership under the same lock used by
    // activation/disconnect. Network calls happen AFTER this short transaction.
    const selected=(await pool.query('SELECT connection_id FROM cloud_storage_active WHERE singleton')).rows[0];
    if (!selected) throw new ServiceUnavailableError('Storage configuration is unavailable.');
    if (!selected.connection_id) return this.legacy.save(buffer,params);
    if (!Buffer.isBuffer(buffer) || buffer.length>MAX_CLOUD_BYTES || !MIME[params.extension]) throw new ServiceUnavailableError('Unsupported cloud file size or type.');
    const context=await storageContext(params);
    const segments=folderPath(context);
    const id=crypto.randomUUID(), name=`${params.category.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,55)}-${id}.${params.extension}`;
    const checksum=digest(buffer), logicalPath=[...segments,name].join('/');
    const connection=await withTransaction(async db=>{
      const active=(await db.query('SELECT connection_id FROM cloud_storage_active WHERE singleton FOR UPDATE')).rows[0];
      if (active.connection_id!==selected.connection_id) throw new ServiceUnavailableError('Storage selection changed. Retry the upload.');
      const conn=(await db.query('SELECT * FROM cloud_storage_connections WHERE id=$1 FOR UPDATE',[active.connection_id])).rows[0];
      if (!conn?.credentials || conn.status!=='connected') throw new ServiceUnavailableError('Active cloud storage is not connected.');
      await db.query(`INSERT INTO cloud_storage_objects(id,connection_id,account_id,kind,logical_path,size_bytes,checksum_sha256,mime_type,site_id,entity_id,namespace)
        VALUES ($1,$2,$3,'file',$4,$5,$6,$7,$8,$9,$10)`,[id,conn.id,conn.account_id,logicalPath,buffer.length,checksum,MIME[params.extension],context.siteId,context.entityId,context.namespace]);
      return conn;
    });
    try {
      const {client}=await connectionClient(connection);
      const parent=await ensureFolders(connection,client,segments);
      const allocated=await client.allocateId();
      await pool.query('UPDATE cloud_storage_objects SET provider_id=$2 WHERE id=$1',[id,allocated]);
      const objectId=await client.upload({id:allocated,path:logicalPath,name,parent,buffer,mimeType:MIME[params.extension]});
      await pool.query("UPDATE cloud_storage_objects SET provider_id=$2,state='ready' WHERE id=$1",[id,objectId]);
      await health(connection,true);
      return {storageKey:`cloud:${id}`,checksumSha256:checksum,sizeBytes:buffer.length};
    } catch (error) {
      // A timed-out upload may have succeeded remotely. Keep its reserved ID/path
      // and block disconnect until cleanup is proven; never fall back to legacy.
      await pool.query("UPDATE cloud_storage_objects SET state='cleanup_pending' WHERE id=$1",[id]);
      await health(connection,false);
      await recordCloudAudit(pool,connection.updated_by_user_id,'STORAGE_FAILED',connection,{objectId:id});
      throw new ServiceUnavailableError('Cloud file storage failed. Cleanup is pending; no alternate provider was used.');
    }
  }
  async read(key) {
    if (!key.startsWith('cloud:')) return this.legacy.read(key);
    const row=(await pool.query("SELECT * FROM cloud_storage_objects WHERE id=$1 AND kind='file' AND state='ready'",[cloudId(key)])).rows[0];
    if (!row) throw new ServiceUnavailableError('Stored cloud file is unavailable.');
    const conn=(await pool.query('SELECT * FROM cloud_storage_connections WHERE id=$1',[row.connection_id])).rows[0];
    if (!conn?.credentials || conn.account_id!==row.account_id) throw new ServiceUnavailableError('Stored cloud file connection is unavailable.');
    try {
      const {client}=await connectionClient(conn);
      const bytes=await client.download(row.provider_id);
      if (bytes.length!==Number(row.size_bytes) || digest(bytes)!==row.checksum_sha256) throw new Error('Integrity check failed.');
      await health(conn,true); return bytes;
    } catch {
      await health(conn,false);
      throw new ServiceUnavailableError('Stored cloud file could not be retrieved or failed its integrity check.');
    }
  }
  async remove(key) {
    if (!key.startsWith('cloud:')) return this.legacy.remove(key);
    try {
      const row=(await pool.query("SELECT * FROM cloud_storage_objects WHERE id=$1 AND kind='file' AND state<>'deleted'",[cloudId(key)])).rows[0];
      if (!row) return;
      await pool.query("UPDATE cloud_storage_objects SET state='cleanup_pending' WHERE id=$1",[row.id]);
      const conn=(await pool.query('SELECT * FROM cloud_storage_connections WHERE id=$1',[row.connection_id])).rows[0];
      if (conn.account_id!==row.account_id) throw new Error('Connection mismatch.');
      const {client}=await connectionClient(conn);
      if (row.provider_id) await client.remove(row.provider_id);
      else if (conn.provider==='dropbox') await client.remove(`/${row.logical_path}`);
      // A Google upload cannot start until its generated ID is persisted.
      await pool.query("UPDATE cloud_storage_objects SET state='deleted' WHERE id=$1",[row.id]);
    } catch (error) { logServerError(error,undefined,{operation:'cloud.cleanup'}); }
  }
  async reconcile(connectionId) {
    const rows=(await pool.query(`SELECT id FROM cloud_storage_objects WHERE connection_id=$1 AND kind='file'
      AND state='cleanup_pending' AND created_at<now()-interval '1 hour' ORDER BY created_at,id LIMIT 10`,[connectionId])).rows;
    let removed=0;
    for(const {id} of rows) {
      const key=`cloud:${id}`;
      const references=await pool.query(`SELECT 1 FROM gate_pass_files WHERE storage_key=$1
        UNION ALL SELECT 1 FROM employee_documents WHERE storage_key=$1
        UNION ALL SELECT 1 FROM employee_profile_photos WHERE storage_key=$1
        UNION ALL SELECT 1 FROM employee_contracts WHERE storage_key=$1
        UNION ALL SELECT 1 FROM procurement_documents WHERE storage_key=$1
        UNION ALL SELECT 1 FROM cms_settings WHERE key='company.logo' AND value LIKE '%' || $1 || '%' LIMIT 1`,[key]);
      if(references.rowCount) continue;
      await this.remove(key);
      if((await pool.query('SELECT state FROM cloud_storage_objects WHERE id=$1',[id])).rows[0].state==='deleted') removed++;
    }
    return {examined:rows.length,removed};
  }
}
