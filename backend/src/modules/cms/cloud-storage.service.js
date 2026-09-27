import crypto from 'node:crypto';
import pool from '../../config/database.js';
import config from '../../config/env.js';
import { withTransaction } from '../../shared/db/with-transaction.js';
import { extractToken } from '../../shared/http/extract-token.js';
import { cloudConfig, providerSetup, PROVIDERS } from '../../shared/storage/cloud-config.js';
import { seal, unseal, digest } from '../../shared/storage/cloud-crypto.js';
import { authorizationUrl, exchangeTokens, providerClient } from '../../shared/storage/cloud-providers.js';
import { connectionClient, ensureFolders, health, recordCloudAudit } from '../../shared/storage/cloud-store.js';
import { ConflictError, ValidationError, ServiceUnavailableError } from '../../shared/errors/app-error.js';

export function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new ValidationError('Unknown cloud storage provider.');
}
function setup(provider) {
  const settings=cloudConfig();
  if (!config.frontendOrigins.includes(settings.origin)) throw new ServiceUnavailableError('Provider setup incomplete. Callback origin must match an allowed application origin.');
  return providerSetup(provider,settings);
}
const connection = async (provider, db=pool, lock=false) => (await db.query(`SELECT * FROM cloud_storage_connections WHERE provider=$1${lock?' FOR UPDATE':''}`,[provider])).rows[0];
const dependentCount = async (id,db=pool) => Number((await db.query("SELECT count(*) FROM cloud_storage_objects WHERE connection_id=$1 AND kind='file' AND state<>'deleted'",[id])).rows[0].count);

export async function status() {
  const rows=(await pool.query(`SELECT c.id,c.provider,c.status,c.account_label,c.revision,c.last_success_at,c.last_test_at,c.last_error,
      (SELECT count(*)::integer FROM cloud_storage_objects o WHERE o.connection_id=c.id AND o.kind='file' AND o.state<>'deleted') AS dependent_files,
      (SELECT count(*)::integer FROM cloud_storage_objects o WHERE o.connection_id=c.id AND o.kind='file' AND o.state='cleanup_pending') AS cleanup_pending
      FROM cloud_storage_connections c ORDER BY c.provider`)).rows;
  const active=(await pool.query('SELECT connection_id,revision FROM cloud_storage_active WHERE singleton')).rows[0];
  return { activeProvider:rows.find(row=>row.id===active.connection_id)?.provider || 'legacy', revision:active.revision,
    legacyProvider:config.storageProvider, providers:rows.map(({id,...row})=>{
      let configured=true;try{setup(row.provider);}catch{configured=false;}
      return {...row,setupComplete:configured,rootFolder:'ESDMS',active:id===active.connection_id};
    }) };
}
export async function initiate(req, provider) {
  assertProvider(provider);const app=setup(provider);
  const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url');
  await withTransaction(async db=>{
    const row=await connection(provider,db,true);
    if (row.status==='disconnecting') throw new ConflictError('Finish disconnecting this provider before reconnecting.');
    await db.query('DELETE FROM cloud_storage_oauth_states WHERE expires_at<now() OR (actor_id=$1 AND provider=$2)',[req.user.id,provider]);
    await db.query(`INSERT INTO cloud_storage_oauth_states(state_hash,provider,actor_id,session_hash,verifier,redirect_uri,connection_revision,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,[digest(state),provider,req.user.id,digest(extractToken(req)),seal({verifier},`state:${digest(state)}`),app.redirectUri,row.revision]);
    await recordCloudAudit(db,req.user.id,'CONNECT_STARTED',row);
  });
  return {authorizeUrl:authorizationUrl(provider,state,verifier)};
}
export async function callback(req,provider) {
  assertProvider(provider);const app=setup(provider);
  const {state,code,error}=req.query;
  if (typeof state!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ValidationError('Invalid or expired OAuth state.');
  // Consume before exchanging the code. A failed exchange needs a new flow;
  // neither a refresh nor a browser replay can reuse this authorization.
  const consumed=(await pool.query(`DELETE FROM cloud_storage_oauth_states WHERE state_hash=$1 AND provider=$2 AND actor_id=$3
    AND session_hash=$4 AND expires_at>now() RETURNING *`,[digest(state),provider,req.user.id,digest(extractToken(req))])).rows[0];
  if (!consumed || consumed.redirect_uri!==app.redirectUri) throw new ValidationError('Invalid or expired OAuth state.');
  const previous=await connection(provider);
  try {
    if (error || typeof code!=='string' || !code || code.length>8192) throw new ValidationError('Provider authorization was not completed.');
    const {verifier}=unseal(consumed.verifier,`state:${digest(state)}`);
    const tokens=await exchangeTokens(provider,{grant_type:'authorization_code',code,...(provider==='dropbox'?{code_verifier:verifier}:{})});
    if (!tokens.refreshToken) throw new ServiceUnavailableError('Provider did not grant offline access. Restart connection with consent.');
    const client=providerClient(provider,tokens.accessToken);
    const account=await client.account();
    if (typeof account.id!=='string' || !account.id || account.id.length>200 || typeof account.label!=='string') throw new ServiceUnavailableError('Provider account identity is unavailable.');
    const saved=await withTransaction(async db=>{
      const active=(await db.query('SELECT connection_id FROM cloud_storage_active WHERE singleton FOR UPDATE')).rows[0];
      const row=await connection(provider,db,true);
      if (row.revision!==consumed.connection_revision || row.status==='disconnecting') throw new ConflictError('Connection changed. Start a new connection flow.');
      const replacing=row.account_id && row.account_id!==account.id;
      if (replacing && (active.connection_id===row.id || await dependentCount(row.id,db))) throw new ConflictError('This account still owns stored files or is active. Reconnect the same account; account replacement is blocked.');
      const updated=(await db.query(`UPDATE cloud_storage_connections SET status='connected',account_id=$2,account_label=$3,credentials=$4,
        revision=revision+1,token_revision=token_revision+1,updated_by_user_id=$5,updated_at=now(),last_error=NULL,last_success_at=NULL WHERE id=$1 RETURNING *`,
      [row.id,account.id,account.label.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200),seal(tokens,`connection:${row.id}`),req.user.id])).rows[0];
      await recordCloudAudit(db,req.user.id,row.credentials?'RECONNECTED':'CONNECTED',row,{accountLabel:updated.account_label});
      return updated;
    });
    await ensureFolders(saved,client,['ESDMS']);
    await health(saved,true,true);
    return {connected:true};
  } catch (failure) {
    await recordCloudAudit(pool,req.user.id,'CONNECT_FAILED',previous);
    if (failure instanceof ConflictError || failure instanceof ValidationError) throw failure;
    throw new ServiceUnavailableError('Provider connection could not be completed. Restart connection or test its status.');
  }
}
export async function activate(actor, provider, revision) {
  if (provider!=='legacy') assertProvider(provider);
  return withTransaction(async db=>{
    const active=(await db.query('SELECT * FROM cloud_storage_active WHERE singleton FOR UPDATE')).rows[0];
    if (active.revision!==revision) throw new ConflictError('Storage selection changed. Reload before saving.');
    let row=null;
    if(provider!=='legacy') {
      setup(provider);row=await connection(provider,db,true);
      if(row.status!=='connected' || !row.last_success_at || row.last_error) throw new ConflictError('Connect and successfully test the provider before activation.');
      unseal(row.credentials,`connection:${row.id}`);
    }
    await db.query('UPDATE cloud_storage_active SET connection_id=$1,revision=revision+1,updated_at=now() WHERE singleton',[row?.id || null]);
    await recordCloudAudit(db,actor.id,'ACTIVE_PROVIDER_CHANGED',row);
    return {activeProvider:provider};
  });
}
export async function testConnection(actor,provider) {
  assertProvider(provider);setup(provider);const row=await connection(provider);
  if(!row.credentials || !['connected','error'].includes(row.status)) throw new ConflictError('Connect this provider first.');
  try {
    const {client}=await connectionClient(row);
    const account=await client.account();
    if(account.id!==row.account_id) throw new Error('Provider account mismatch.');
    const root=await ensureFolders(row,client,['ESDMS']);
    const metadata=await client.metadata(root);
    if(metadata.trashed || (provider==='dropbox' ? metadata['.tag']!=='folder' : metadata.mimeType!=='application/vnd.google-apps.folder')) throw new Error('Root unavailable.');
    await health(row,true,true);await recordCloudAudit(pool,actor.id,'CONNECTION_TEST_PASSED',row);
    return {ok:true};
  } catch {
    await health(row,false,true);await recordCloudAudit(pool,actor.id,'CONNECTION_TEST_FAILED',row);
    throw new ServiceUnavailableError('Cloud storage connection test failed. Reconnect the same account or check provider availability.');
  }
}
export async function disconnect(actor,provider,revision) {
  assertProvider(provider);setup(provider);
  let row;
  try {
    row=await withTransaction(async db=>{
      const active=(await db.query('SELECT connection_id FROM cloud_storage_active WHERE singleton FOR UPDATE')).rows[0];
      const conn=await connection(provider,db,true);
      if(conn.revision!==revision) throw new ConflictError('Connection changed. Reload before disconnecting.');
      if(active.connection_id===conn.id || await dependentCount(conn.id,db)) throw new ConflictError('Disconnect refused: deactivate first and resolve all dependent files. Historical files are never migrated or deleted automatically.');
      if(!conn.credentials) throw new ConflictError('Provider is already disconnected.');
      await db.query("UPDATE cloud_storage_connections SET status='disconnecting',revision=revision+1 WHERE id=$1",[conn.id]);
      await recordCloudAudit(db,actor.id,'DISCONNECT_STARTED',conn);
      return {...conn,revision:conn.revision+1};
    });
  } catch(error) {
    await recordCloudAudit(pool,actor.id,'DISCONNECT_REFUSED',await connection(provider));throw error;
  }
  try {
    // Revocation uses the saved refresh token for Google, access token for Dropbox.
    // Refresh a Dropbox token before entering disconnecting when needed below.
    const tokens=unseal(row.credentials,`connection:${row.id}`);
    if(provider==='dropbox' && tokens.expiresAt<Date.now()+60_000) {
      const refreshed=await exchangeTokens(provider,{grant_type:'refresh_token',refresh_token:tokens.refreshToken});
      tokens.accessToken=refreshed.accessToken;
    }
    await providerClient(provider,tokens.accessToken).revoke(tokens.refreshToken);
    await withTransaction(async db=>{
      const result=await db.query(`UPDATE cloud_storage_connections SET credentials=NULL,status='disconnected',revision=revision+1,
        token_revision=token_revision+1,last_error=NULL,updated_at=now(),updated_by_user_id=$3 WHERE id=$1 AND revision=$2`,[row.id,row.revision,actor.id]);
      if(!result.rowCount) throw new ConflictError('Connection changed.');
      await recordCloudAudit(db,actor.id,'DISCONNECTED',row);
    });
    return {disconnected:true};
  } catch {
    await health(row,false);await recordCloudAudit(pool,actor.id,'DISCONNECT_FAILED',row);
    throw new ServiceUnavailableError('Revocation could not be confirmed. Credentials remain encrypted; retry disconnect.');
  }
}
export async function cleanup(actor,provider) {
  assertProvider(provider);setup(provider);
  const row=await connection(provider);
  if(!row.credentials || row.status!=='connected') throw new ConflictError('Reconnect this provider before cleanup.');
  const {storageService}=await import('../../shared/storage/storage-service.js');
  const result=await storageService.reconcile(row.id);
  await recordCloudAudit(pool,actor.id,'CLEANUP_RECONCILED',row,result);
  return result;
}
