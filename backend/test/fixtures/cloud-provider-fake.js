import crypto from 'node:crypto';
const hash=(bytes,algorithm='sha256')=>crypto.createHash(algorithm).update(bytes).digest('hex');
function dropboxHash(bytes) {
  const chunks=[];for(let i=0;i<bytes.length;i+=4194304)chunks.push(Buffer.from(hash(bytes.subarray(i,i+4194304)),'hex'));
  return hash(Buffer.concat(chunks));
}
export function fakeCloudFetch(originalFetch=globalThis.fetch) {
  const objects=new Map(),paths=new Map(),sessions=new Map(),calls=[];
  let seq=0;
  const state={account:'test-account-1',fail:null,once:null,refreshes:0,objects,calls,revoked:false};
  const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});
  const metadata=file=>file.provider==='dropbox'
    ? {id:file.id,'.tag':file.folder?'folder':'file',size:file.bytes?.length,content_hash:file.bytes?dropboxHash(file.bytes):undefined}
    : {id:file.id,name:file.name,mimeType:file.folder?'application/vnd.google-apps.folder':file.mimeType,size:String(file.bytes?.length||0),md5Checksum:file.bytes?hash(file.bytes,'md5'):undefined,parents:file.parents,trashed:false};
  const missing=dropbox=>json(dropbox?{error:{'.tag':'path',path:{'.tag':'not_found'}}}:{error:'missing'},dropbox?409:404);
  state.fetch=async(input,opts={})=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if(!['api.dropboxapi.com','content.dropboxapi.com','oauth2.googleapis.com','www.googleapis.com'].includes(url.hostname))return originalFetch(input,opts);
    calls.push({url:url.origin+url.pathname,method:opts.method||'GET'});
    if(state.once){const status=state.once;state.once=null;return json({error:'private-provider-error'},status,{'retry-after':'0'});}
    if(state.fail)return json({error:'private-provider-error'},state.fail,{'retry-after':'0'});
    const isDropbox=url.hostname.includes('dropbox');
    if(url.pathname.endsWith('/token')) {
      const body=new URLSearchParams(opts.body);
      if(body.get('code')==='fail-exchange')return json({error:'private-token-exchange-error'},400);
      if(body.get('grant_type')==='refresh_token')state.refreshes++;
      return json({access_token:`fake-access-${state.account}`,refresh_token:`fake-refresh-${state.account}`,expires_in:3600});
    }
    if(url.pathname.endsWith('/revoke')){state.revoked=true;return json({});}
    if(state.revoked)return json({error:'revoked'},401);
    if(url.pathname.endsWith('/get_current_account'))return json({account_id:state.account,email:'test@example.invalid'});
    if(url.pathname.endsWith('/about'))return json({user:{permissionId:state.account,emailAddress:'test@example.invalid'}});
    if(url.pathname.endsWith('/generateIds'))return json({ids:[`drive-${++seq}`]});
    const body=typeof opts.body==='string'?JSON.parse(opts.body):null;
    if(url.pathname.endsWith('/create_folder_v2')) {
      if(paths.has(body.path))return json({error:'conflict'},409);
      const file={id:`id:db-${++seq}`,provider:'dropbox',folder:true,path:body.path};objects.set(file.id,file);paths.set(file.path,file.id);
      return json({metadata:metadata(file)});
    }
    if(url.pathname.endsWith('/get_metadata')) {
      const file=objects.get(paths.get(body.path)||body.path);return file?json(metadata(file)):missing(true);
    }
    if(url.pathname.endsWith('/files/upload')) {
      const args=JSON.parse(new Headers(opts.headers).get('Dropbox-API-Arg'));
      if(paths.has(args.path))return json({error:'conflict'},409);
      const file={id:`id:db-${++seq}`,provider:'dropbox',path:args.path,bytes:Buffer.from(opts.body)};objects.set(file.id,file);paths.set(file.path,file.id);
      return json(metadata(file));
    }
    if(url.pathname.includes('/upload_session/')) {
      const args=JSON.parse(new Headers(opts.headers).get('Dropbox-API-Arg'));
      if(url.pathname.endsWith('/start')){const session=`dropbox-session-${++seq}`;sessions.set(session,[Buffer.from(opts.body)]);return json({session_id:session});}
      const chunks=sessions.get(args.cursor.session_id);
      if(args.cursor.offset!==chunks.reduce((n,bytes)=>n+bytes.length,0))return json({error:'offset'},409);
      chunks.push(Buffer.from(opts.body));
      if(url.pathname.endsWith('/append_v2'))return json({});
      if(paths.has(args.commit.path))return json({error:'conflict'},409);
      const file={id:`id:db-${++seq}`,provider:'dropbox',path:args.commit.path,bytes:Buffer.concat(chunks)};
      objects.set(file.id,file);paths.set(file.path,file.id);return json(metadata(file));
    }
    if(url.pathname.endsWith('/files/download')) {
      const args=JSON.parse(new Headers(opts.headers).get('Dropbox-API-Arg'));
      const file=objects.get(args.path);return file?new Response(file.bytes):missing(true);
    }
    if(url.pathname.endsWith('/delete_v2')) {
      const id=paths.get(body.path)||body.path,file=objects.get(id);
      if(!file)return missing(true);objects.delete(id);paths.delete(file.path);return json({metadata:metadata(file)});
    }
    if(url.pathname==='/upload/drive/v3/files') {
      if(opts.method==='POST') {
        if(objects.has(body.id))return json({error:'exists'},409);
        const session=`session-${++seq}`;sessions.set(session,{...body,mimeType:new Headers(opts.headers).get('X-Upload-Content-Type')});
        return new Response(null,{status:200,headers:{location:`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${session}`}});
      }
      const info=sessions.get(url.searchParams.get('upload_id'));
      const file={...info,provider:'google_drive',bytes:Buffer.from(opts.body)};objects.set(file.id,file);return json(metadata(file));
    }
    if(url.pathname==='/drive/v3/files'&&opts.method==='POST') {
      if(objects.has(body.id))return json({error:'exists'},409);
      const file={...body,provider:'google_drive',folder:true};objects.set(file.id,file);return json({id:file.id});
    }
    if(url.pathname.startsWith('/drive/v3/files/')) {
      const id=decodeURIComponent(url.pathname.split('/').pop()),file=objects.get(id);
      if(!file)return missing(false);
      if(opts.method==='DELETE'){objects.delete(id);return new Response(null,{status:204});}
      return url.searchParams.get('alt')==='media'?new Response(file.bytes):json(metadata(file));
    }
    throw new Error(`Unexpected fake provider operation: ${url.pathname}`);
  };
  return state;
}
