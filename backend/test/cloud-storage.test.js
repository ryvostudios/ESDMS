import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeCloudFetch } from './fixtures/cloud-provider-fake.js';

// Disposable test process only. No runtime flag or production mock endpoint.
process.env.CLOUD_STORAGE_MASTER_KEY=crypto.randomBytes(32).toString('base64');
process.env.CLOUD_STORAGE_OAUTH_ORIGIN='http://localhost:5173';
process.env.FRONTEND_ORIGIN='http://localhost:5173';
process.env.DROPBOX_CLIENT_ID='test-dropbox-app';process.env.DROPBOX_CLIENT_SECRET='fake-dropbox-app-secret';
process.env.GOOGLE_DRIVE_CLIENT_ID='test-google-app';process.env.GOOGLE_DRIVE_CLIENT_SECRET='fake-google-app-secret';
const {default:pool}=await import('../src/config/database.js');
const {startTestServer,seedUsers}=await import('./setup.js');
const {authHeader,apiRequest}=await import('./gate-pass-helpers.js');
const {seal,unseal}=await import('../src/shared/storage/cloud-crypto.js');
const {storageService}=await import('../src/shared/storage/storage-service.js');
const {safeSegment,folderPath}=await import('../src/shared/storage/cloud-paths.js');
const {cloudRequest,DropboxProvider,GoogleDriveProvider}=await import('../src/shared/storage/cloud-providers.js');
const originalFetch=globalThis.fetch;
const remote=fakeCloudFetch(originalFetch);
let server,users,tokens;
const call=(token,method,path,body)=>apiRequest(server.baseUrl,method,`/api/v1${path}`,{token,body});
const getStatus=async()=> (await call(tokens.ceo,'GET','/cms/cloud-storage')).body.data;
const begin=async(provider,token=tokens.ceo)=>{
  const result=await call(token,'POST',`/cms/cloud-storage/${provider}/connect`,{});
  assert.equal(result.status,200,JSON.stringify(result.body));return new URL(result.body.data.authorizeUrl).searchParams.get('state');
};
async function complete(provider,state,token=tokens.ceo,code='valid-code') {
  const response=await originalFetch(`${server.baseUrl}/api/v1/cms/cloud-storage/${provider}/callback?${new URLSearchParams({state,code})}`,{headers:{Cookie:token},redirect:'manual'});
  return {status:response.status,text:await response.text()};
}
const connect=async provider=>{remote.revoked=false;const result=await complete(provider,await begin(provider));assert.equal(result.status,303,result.text);};
const activate=async provider=>{const status=await getStatus();const r=await call(tokens.ceo,'POST','/cms/cloud-storage/active',{provider,revision:status.revision});assert.equal(r.status,200,JSON.stringify(r.body));};
before(async()=>{
  globalThis.fetch=remote.fetch;server=await startTestServer();users=await seedUsers();tokens={};
  for(const [key,email]of Object.entries({ceo:'ceo',hr:'hr',manager:'manager',employee:'employee'}))tokens[key]=await authHeader(server.baseUrl,`${email}@test.eset.local`);
});
after(async()=>{
  globalThis.fetch=originalFetch;
  await pool.query('UPDATE cloud_storage_active SET connection_id=NULL');
  await pool.query("UPDATE cloud_storage_connections SET credentials=NULL,status='disconnected',account_id=NULL,account_label=NULL,last_success_at=NULL,last_error=NULL,last_test_at=NULL");
  await pool.query('DELETE FROM cloud_storage_oauth_states');
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code='cms.integrations.manage')",[users.siteManager]);
  await server.close();await pool.end();
});

test('authenticated encryption is randomized, context-bound, key-versioned and tamper-evident',()=>{
  const plaintext={refreshToken:'test-private-refresh',accessToken:'test-private-access'};
  const one=seal(plaintext,'connection:test'),two=seal(plaintext,'connection:test');
  assert.notEqual(one,two);assert.ok(!one.includes(plaintext.refreshToken));assert.deepEqual(unseal(one,'connection:test'),plaintext);
  assert.throws(()=>unseal(one,'connection:other'));
  assert.throws(()=>unseal(one,'connection:test',{key:crypto.randomBytes(32).toString('base64'),keyVersion:'1'}));
  const tampered=JSON.parse(one);tampered.data=Buffer.from('tampered').toString('base64');assert.throws(()=>unseal(JSON.stringify(tampered),'connection:test'));
});
test('folder segments resist traversal, ambiguity, control characters and length attacks',()=>{
  for(const value of ['../','a/b\\c','\u0000name','CON','NUL','x'.repeat(2000),'Ｒｅｐｏｒｔ','a\u202eb','..']) {
    const safe=safeSegment(value);assert.match(safe,/^[A-Za-z0-9 _-]+$/);assert.ok(safe.length<=77);assert.equal(safe,safeSegment(value));assert.ok(!['CON','NUL'].includes(safe));
  }
  assert.throws(()=>safeSegment(''));assert.throws(()=>safeSegment('  '));assert.notEqual(safeSegment('a/b'),safeSegment('a\\b'));
  assert.deepEqual(folderPath({namespace:'gate-pass',site:'MAIN',category:'departure',identifier:'GP-1',year:2026}),['ESDMS','MAIN','Gate Pass','2026','GP-1','Departure']);
  assert.deepEqual(folderPath({namespace:'workforce',site:'MAIN',category:'document-id',identifier:'E001'}),['ESDMS','MAIN','Workforce','E001','Documents']);
  assert.deepEqual(folderPath({namespace:'procurement',site:'MAIN',category:'ipo',identifier:'IPO-1',year:2026}),['ESDMS','MAIN','IPO','2026','IPO-1']);
});
test('cloud management requires independent authority, DENY wins and delegation stays CEO-controlled',async()=>{
  assert.equal((await call(null,'GET','/cms/cloud-storage')).status,401);
  for(const token of [tokens.employee,tokens.hr,tokens.manager]) {
    assert.equal((await call(token,'GET','/cms/cloud-storage')).status,403);
    assert.equal((await call(token,'POST','/cms/cloud-storage/dropbox/connect',{})).status,403);
    assert.equal((await call(token,'POST','/cms/cloud-storage/active',{provider:'legacy',revision:1})).status,403);
  }
  await call(tokens.ceo,'PUT',`/users/${users.siteManager}/permissions/cms.integrations.manage`,{effect:'GRANT'});
  assert.equal((await call(tokens.manager,'GET','/cms/cloud-storage')).status,200);
  await call(tokens.ceo,'PUT',`/users/${users.siteManager}/permissions/cms.integrations.manage`,{effect:'DENY'});
  assert.equal((await call(tokens.manager,'POST','/cms/cloud-storage/dropbox/connect',{})).status,403);
});
test('OAuth state is session/user/provider bound, expiring, single-use; codes and secrets never escape',async()=>{
  const state=await begin('dropbox');
  assert.equal((await complete('dropbox','')).status,400);
  assert.equal((await complete('dropbox','x'.repeat(43))).status,400);
  assert.equal((await complete('google_drive',state)).status,400);
  assert.equal((await complete('dropbox',state,tokens.employee)).status,403);
  await call(tokens.ceo,'PUT',`/users/${users.siteManager}/permissions/cms.integrations.manage`,{effect:'GRANT'});
  assert.equal((await complete('dropbox',state,tokens.manager)).status,400);
  await new Promise(resolve=>setTimeout(resolve,1100));
  const otherSession=await authHeader(server.baseUrl,'ceo@test.eset.local');
  assert.notEqual(otherSession,tokens.ceo);
  assert.equal((await complete('dropbox',state,otherSession)).status,400);
  assert.equal((await complete('dropbox',state)).status,303);
  assert.equal((await complete('dropbox',state)).status,400);
  const expired=await begin('dropbox');await pool.query("UPDATE cloud_storage_oauth_states SET expires_at=now()-interval '1 second'");
  assert.equal((await complete('dropbox',expired)).status,400);
  const fail=await begin('dropbox');const result=await complete('dropbox',fail,tokens.ceo,'fail-exchange');assert.equal(result.status,503);assert.ok(!result.text.includes('private-token'));
  assert.equal((await complete('dropbox',fail)).status,400);
  const saved=(await pool.query("SELECT * FROM cloud_storage_connections WHERE provider='dropbox'")).rows[0];
  assert.ok(!saved.credentials.includes('fake-refresh'));assert.equal(unseal(saved.credentials,`connection:${saved.id}`).refreshToken,'fake-refresh-test-account-1');
  const data=JSON.stringify(await getStatus());assert.ok(!/accessToken|refreshToken|credentials|fake-access|fake-refresh|clientSecret/.test(data));
  const audits=JSON.stringify((await pool.query("SELECT metadata FROM governance_audit_log WHERE action='CLOUD_STORAGE_CHANGED'")).rows);
  assert.ok(!/fake-access|fake-refresh|valid-code|fail-exchange|client_secret/.test(audits));
  assert.equal((await getStatus()).activeProvider,'legacy');
});
test('legacy, Dropbox and Drive records coexist; future routing never rewrites old file references',async()=>{
  const params={namespace:'cms',gatePassId:'branding',category:'logo',extension:'png'};
  const legacy=await storageService.save(Buffer.from('legacy'),params);
  await activate('dropbox');const dropbox=await storageService.save(Buffer.from('dropbox'),params);
  await connect('google_drive');assert.equal((await getStatus()).activeProvider,'dropbox');
  await activate('google_drive');const drive=await storageService.save(Buffer.from('drive'),params);
  assert.ok(dropbox.storageKey.startsWith('cloud:'));assert.ok(drive.storageKey.startsWith('cloud:'));
  for(const [saved,value]of [[legacy,'legacy'],[dropbox,'dropbox'],[drive,'drive']])assert.equal((await storageService.read(saved.storageKey)).toString(),value);
  await activate('legacy');
  const status=await getStatus();for(const provider of status.providers)assert.equal((await call(tokens.ceo,'POST',`/cms/cloud-storage/${provider.provider}/disconnect`,{revision:provider.revision})).status,409);
  const before=(await pool.query("SELECT credentials FROM cloud_storage_connections WHERE provider='dropbox'")).rows[0].credentials;
  remote.account='test-account-2';const replacement=await complete('dropbox',await begin('dropbox'));assert.equal(replacement.status,409);remote.account='test-account-1';
  assert.equal((await pool.query("SELECT credentials FROM cloud_storage_connections WHERE provider='dropbox'")).rows[0].credentials,before);
  await connect('dropbox');assert.equal((await storageService.read(dropbox.storageKey)).toString(),'dropbox');
  await storageService.remove(legacy.storageKey);await storageService.remove(dropbox.storageKey);await storageService.remove(drive.storageKey);
});
test('refresh, transient errors, revoked tokens, bounded retries, missing files and failed cleanup are controlled',async()=>{
  const conn=(await pool.query("SELECT * FROM cloud_storage_connections WHERE provider='dropbox'")).rows[0];
  const tokens=unseal(conn.credentials,`connection:${conn.id}`);tokens.expiresAt=0;
  await pool.query('UPDATE cloud_storage_connections SET credentials=$2 WHERE id=$1',[conn.id,seal(tokens,`connection:${conn.id}`)]);
  assert.equal((await call(tokensForCEO(),'POST','/cms/cloud-storage/dropbox/test',{})).status,200);assert.ok(remote.refreshes>0);
  await activate('dropbox');remote.once=429;
  const params={namespace:'cms',gatePassId:'branding',category:'logo',extension:'png'};
  const saved=await storageService.save(Buffer.from('retry'),params);
  assert.equal((await storageService.read(saved.storageKey)).toString(),'retry');
  remote.revoked=true;await assert.rejects(()=>storageService.read(saved.storageKey),{statusCode:503});remote.revoked=false;
  const object=(await pool.query('SELECT * FROM cloud_storage_objects WHERE id=$1',[saved.storageKey.slice(6)])).rows[0];remote.objects.delete(object.provider_id);
  await assert.rejects(()=>storageService.read(saved.storageKey),{statusCode:503});await storageService.remove(saved.storageKey);
  remote.fail=503;await assert.rejects(()=>storageService.save(Buffer.from('outage'),params),{statusCode:503});remote.fail=null;
  const pending=(await pool.query("SELECT * FROM cloud_storage_objects WHERE state='cleanup_pending'")).rows;assert.ok(pending.length>0);
  await pool.query("UPDATE cloud_storage_objects SET created_at=now()-interval '2 hours' WHERE state='cleanup_pending'");
  const cleanup=await call(tokensForCEO(),'POST','/cms/cloud-storage/dropbox/cleanup',{});assert.equal(cleanup.status,200);assert.ok(cleanup.body.data.removed>0);
  await activate('legacy');
});
function tokensForCEO(){return tokens.ceo;}
test('provider requests reject SSRF/redirect targets; duplicate provider uploads reuse stable identities',async()=>{
  await assert.rejects(()=>cloudRequest('http://127.0.0.1/private'));
  await assert.rejects(()=>cloudRequest('https://attacker.invalid/private'));
  const bytes=Buffer.from('idempotent'),dropbox=new DropboxProvider('test');
  const one=await dropbox.upload({path:'ESDMS/test-idempotent',buffer:bytes});assert.equal(await dropbox.upload({path:'ESDMS/test-idempotent',buffer:bytes}),one);
  const drive=new GoogleDriveProvider('test');const id=await drive.allocateId();
  const args={id,name:'idempotent.pdf',parent:'parent-test',buffer:bytes,mimeType:'application/pdf'};
  assert.equal(await drive.upload(args),id);assert.equal(await drive.upload(args),id);
  const large=Buffer.alloc(9*1024*1024,7);
  const largeId=await dropbox.upload({path:'ESDMS/large-document',buffer:large});assert.deepEqual(await dropbox.download(largeId),large);
  const hostile=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{headers:{location:'https://attacker.invalid/upload?upload_id=secret'}});
  try {await assert.rejects(()=>drive.upload({...args,id:'new-id'}));}finally{globalThis.fetch=hostile;}
});
test('in-flight uploads pin the account and do not lock active selection across provider I/O',async()=>{
  assert.equal((await call(tokens.ceo,'POST','/cms/cloud-storage/dropbox/test',{})).status,200);
  await activate('dropbox');
  let release,entered;
  const paused=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const fetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith('/files/upload')){entered();await paused;}
    return fetch(url,options);
  };
  const upload=storageService.save(Buffer.from('race-file'),{namespace:'cms',gatePassId:'branding',category:'logo',extension:'png'});
  try {
    await started;await activate('legacy');
    const snapshot=await getStatus(),row=snapshot.providers.find(p=>p.provider==='dropbox');
    assert.equal((await call(tokens.ceo,'POST','/cms/cloud-storage/dropbox/disconnect',{revision:row.revision})).status,409);
    remote.account='different-account';assert.equal((await complete('dropbox',await begin('dropbox'))).status,409);remote.account='test-account-1';
  } finally {release();globalThis.fetch=fetch;}
  const stored=await upload;assert.equal((await storageService.read(stored.storageKey)).toString(),'race-file');await storageService.remove(stored.storageKey);
});
test('disconnect revokes credentials only after deactivation and removal of dependent files',async()=>{
  const before=await getStatus();const row=before.providers.find(p=>p.provider==='dropbox');
  const result=await call(tokens.ceo,'POST','/cms/cloud-storage/dropbox/disconnect',{revision:row.revision});assert.equal(result.status,200,JSON.stringify(result.body));
  const stored=(await pool.query("SELECT credentials,status FROM cloud_storage_connections WHERE provider='dropbox'")).rows[0];assert.equal(stored.credentials,null);assert.equal(stored.status,'disconnected');
});
