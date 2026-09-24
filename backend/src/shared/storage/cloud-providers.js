import crypto from 'node:crypto';
import { ServiceUnavailableError } from '../errors/app-error.js';
import { providerSetup } from './cloud-config.js';

// Existing Gate Pass completion PDFs can include forty 5 MB evidence images.
// Keep their aggregate envelope while retaining a hard download/upload bound.
export const MAX_CLOUD_BYTES = 256 * 1024 * 1024;
const API_HOSTS = new Set(['api.dropboxapi.com','content.dropboxapi.com','www.googleapis.com','oauth2.googleapis.com']);
export class CloudProviderError extends ServiceUnavailableError {
  constructor(status = 0, notFound = false) {
    super('Cloud storage is temporarily unavailable. No alternate storage was used.');
    this.providerStatus = status;
    this.notFound = notFound;
  }
}
// Never log provider bodies. Bound headers AND streamed body consumption. Never
// follow redirects carrying a bearer token. URLs are authored below, not supplied
// by users or taken from provider response links.
export async function cloudRequest(url, options = {}, { binary = false, retry = false, headersOnly = false } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !API_HOSTS.has(target.hostname) || target.username || target.password || target.port) throw new CloudProviderError();
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let delay = 0;
    try {
      const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        let notFound=response.status===404;
        if(response.status===409) {
          const chunks=[];let length=0;
          for await(const chunk of response.body || []) {
            length+=chunk.length;if(length>16_384){controller.abort();throw new CloudProviderError(response.status);}
            chunks.push(chunk);
          }
          try {const error=JSON.parse(Buffer.concat(chunks).toString());notFound=error.error?.path?.['.tag']==='not_found';}catch{/* discard all provider error text */}
        } else await response.body?.cancel();
        if (retry && attempt === 0 && (response.status === 429 || response.status >= 500)) {
          const wait = Number(response.headers.get('retry-after') || 1);
          if (!Number.isFinite(wait) || wait > 2) throw new CloudProviderError(response.status);
          delay = Math.max(250, wait * 1000);
        } else throw new CloudProviderError(response.status,notFound);
      } else {
        if (headersOnly) { await response.body?.cancel(); return response.headers; }
        const limit = binary ? MAX_CLOUD_BYTES : 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) throw new CloudProviderError();
        const chunks = []; let size = 0;
        for await (const chunk of response.body || []) {
          size += chunk.length;
          if (size > limit) { controller.abort(); throw new CloudProviderError(); }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        return binary ? body : body.length ? JSON.parse(body.toString('utf8')) : {};
      }
    } catch (error) {
      if (error instanceof CloudProviderError) throw error;
      throw new CloudProviderError();
    } finally { clearTimeout(timer); }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  }
}
const json = data => ({ 'Content-Type':'application/json', ...data });
const auth = token => ({ Authorization:`Bearer ${token}` });
const idPart = id => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(id)) throw new CloudProviderError();
  return encodeURIComponent(id);
};
export const SCOPES = {
  dropbox: 'account_info.read files.metadata.read files.content.write files.content.read',
  google_drive: 'https://www.googleapis.com/auth/drive.file',
};
export function authorizationUrl(provider, state, verifier) {
  const app = providerSetup(provider);
  const params = new URLSearchParams({ client_id:app.clientId, redirect_uri:app.redirectUri, response_type:'code', state, scope:SCOPES[provider] });
  if (provider === 'dropbox') {
    params.set('token_access_type','offline');
    params.set('code_challenge',crypto.createHash('sha256').update(verifier).digest('base64url'));
    params.set('code_challenge_method','S256');
    return `https://www.dropbox.com/oauth2/authorize?${params}`;
  }
  params.set('access_type','offline'); params.set('prompt','consent select_account');
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
export async function exchangeTokens(provider, input) {
  const app = providerSetup(provider);
  const body = new URLSearchParams({ client_id:app.clientId, client_secret:app.clientSecret, ...input });
  if (input.grant_type === 'authorization_code') body.set('redirect_uri',app.redirectUri);
  const result = await cloudRequest(provider === 'dropbox' ? 'https://api.dropboxapi.com/oauth2/token' : 'https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body,
  });
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 8192 ||
      !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 86400 ||
      (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || result.refresh_token.length > 8192))) throw new CloudProviderError();
  if (result.scope && !SCOPES[provider].split(' ').every(scope => result.scope.split(' ').includes(scope))) throw new CloudProviderError();
  return { accessToken:result.access_token, refreshToken:result.refresh_token || input.refresh_token, expiresAt:Date.now() + result.expires_in * 1000 };
}
function dropboxHash(buffer) {
  const chunks = [];
  for (let i=0;i<buffer.length;i+=4*1024*1024) chunks.push(crypto.createHash('sha256').update(buffer.subarray(i,i+4*1024*1024)).digest());
  return crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}
export class DropboxProvider {
  constructor(token) { this.token = token; }
  rpc(method, body) { return cloudRequest(`https://api.dropboxapi.com/2/${method}`, { method:'POST', headers:json(auth(this.token)), body:JSON.stringify(body) }, { retry:true }); }
  async account() {
    const user = await this.rpc('users/get_current_account',null);
    return { id:user.account_id, label:user.email || user.name?.display_name };
  }
  async allocateId() { return null; } // deterministic app-folder path is the write identity
  metadata(id) { return this.rpc('files/get_metadata',{path:id}); }
  async folder({ path: logicalPath }) {
    try { return (await this.rpc('files/create_folder_v2',{path:`/${logicalPath}`,autorename:false})).metadata.id; }
    catch (error) {
      if (error.providerStatus !== 409) throw error;
      const found = await this.metadata(`/${logicalPath}`);
      if (found['.tag'] !== 'folder') throw new CloudProviderError();
      return found.id;
    }
  }
  async upload({ path:logicalPath, buffer }) {
    let file;
    const commit={path:`/${logicalPath}`,mode:'add',autorename:false,strict_conflict:true,mute:true};
    try {
      const chunkSize=8*1024*1024;
      const send=(method,args,body,retry=false)=>cloudRequest(`https://content.dropboxapi.com/2/files/${method}`,{
        method:'POST',headers:{...auth(this.token),'Content-Type':'application/octet-stream','Dropbox-API-Arg':JSON.stringify(args)},body,
      },{retry});
      if(buffer.length<=chunkSize) file=await send('upload',commit,buffer,true);
      else {
        const started=await send('upload_session/start',{close:false},buffer.subarray(0,chunkSize));
        if(typeof started.session_id!=='string')throw new CloudProviderError();
        let offset=chunkSize;
        while(buffer.length-offset>chunkSize){await send('upload_session/append_v2',{cursor:{session_id:started.session_id,offset},close:false},buffer.subarray(offset,offset+chunkSize));offset+=chunkSize;}
        file=await send('upload_session/finish',{cursor:{session_id:started.session_id,offset},commit},buffer.subarray(offset),true);
      }
    } catch (error) {
      if (error.providerStatus !== 409) throw error;
      file = await this.metadata(`/${logicalPath}`);
    }
    if (file.size !== buffer.length || file.content_hash !== dropboxHash(buffer) || !file.id) throw new CloudProviderError();
    return file.id;
  }
  download(id) { idPart(id); return cloudRequest('https://content.dropboxapi.com/2/files/download', {method:'POST',headers:{...auth(this.token),'Dropbox-API-Arg':JSON.stringify({path:id})}}, {binary:true,retry:true}); }
  async remove(id) {
    try { await this.rpc('files/delete_v2',{path:id}); }
    catch (error) {
      if(!error.notFound) throw error;
    }
  }
  revoke() { return this.rpc('auth/token/revoke',null); }
}
export class GoogleDriveProvider {
  constructor(token) { this.token = token; }
  api(resource, options = {}) { return cloudRequest(`https://www.googleapis.com/drive/v3/${resource}`, {...options,headers:{...json(auth(this.token)),...options.headers}}, {retry:true}); }
  async account() {
    const {user} = await this.api('about?fields=user(permissionId,emailAddress,displayName)');
    return {id:user?.permissionId,label:user?.emailAddress || user?.displayName};
  }
  async allocateId() { const result = await this.api('files/generateIds?count=1&space=drive&type=files'); idPart(result.ids?.[0]); return result.ids[0]; }
  metadata(id) { return this.api(`files/${idPart(id)}?fields=id,name,mimeType,size,md5Checksum,parents,trashed`); }
  async folder({id,name,parent}) {
    try {
      await this.api('files?fields=id',{method:'POST',body:JSON.stringify({id,name,mimeType:'application/vnd.google-apps.folder',parents:parent?[parent]:undefined})});
    } catch (error) { if (error.providerStatus !== 409) throw error; }
    const file = await this.metadata(id);
    if (file.trashed || file.mimeType !== 'application/vnd.google-apps.folder' || file.name !== name || (parent && !file.parents?.includes(parent))) throw new CloudProviderError();
    return id;
  }
  async upload({ id,name,parent,buffer,mimeType }) {
    try {
      const headers=await cloudRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
        method:'POST',headers:{...json(auth(this.token)),'X-Upload-Content-Type':mimeType,'X-Upload-Content-Length':String(buffer.length)},
        body:JSON.stringify({id,name,parents:[parent]}),
      }, {headersOnly:true,retry:true});
      const location=headers.get('location');
      let session;
      try { session=new URL(location); } catch { throw new CloudProviderError(); }
      if(session.origin!=='https://www.googleapis.com' || session.pathname!=='/upload/drive/v3/files' || session.username || session.password || !session.searchParams.get('upload_id')) throw new CloudProviderError();
      await cloudRequest(session.toString(),{method:'PUT',headers:{...auth(this.token),'Content-Type':mimeType,'Content-Length':String(buffer.length)},body:buffer},{retry:true});
    } catch (error) { if (error.providerStatus !== 409) throw error; }
    const file = await this.metadata(id);
    if (file.trashed || Number(file.size) !== buffer.length || file.md5Checksum !== crypto.createHash('md5').update(buffer).digest('hex') || !file.parents?.includes(parent)) throw new CloudProviderError();
    return id;
  }
  download(id) { return cloudRequest(`https://www.googleapis.com/drive/v3/files/${idPart(id)}?alt=media`, {headers:auth(this.token)}, {binary:true,retry:true}); }
  async remove(id) { try { await this.api(`files/${idPart(id)}`,{method:'DELETE'}); } catch(error) { if(error.providerStatus!==404) throw error; } }
  revoke(refreshToken) { return cloudRequest('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:refreshToken})}); }
}
export function providerClient(provider, token) { return provider === 'dropbox' ? new DropboxProvider(token) : new GoogleDriveProvider(token); }
