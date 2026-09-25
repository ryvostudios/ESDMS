import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import pool from '../../src/config/database.js';
import { startTestServer, seedUsers } from '../setup.js';
import { authHeader } from '../gate-pass-helpers.js';
import { storageService } from '../../src/shared/storage/storage-service.js';

const db = new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/(?:eset_test|esdms_test_[a-z0-9_]+)$/);
const server = await startTestServer();
let saves=0, externalCalls=0;
const save=storageService.save;
const originalFetch=globalThis.fetch;
storageService.save=async()=>{saves++;throw new Error('Unexpected storage call');};
globalThis.fetch=(url,...args)=>{
  if(new URL(url).hostname!=='127.0.0.1') { externalCalls++; throw new Error('External provider access is forbidden in this fixture'); }
  return originalFetch(url,...args);
};
const boundary='esdms-security-boundary';
const marker='do-not-echo-multipart-value';
function body(fields=[], file=null, close=true) {
  const pieces=[];
  if(file) pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="test.bin"\r\nContent-Type: ${file.mime}\r\n\r\n`),file.bytes,Buffer.from('\r\n'));
  for(const [key,value]of fields) pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  if(close) pieces.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(pieces);
}
async function snapshot() {
  const tables=['gate_pass_files','employee_documents','employee_profile_photos','employee_contracts','procurement_documents','cloud_storage_objects'];
  const values=[];
  for(const table of tables) values.push((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n);
  values.push((await pool.query("SELECT value,revision FROM cms_settings WHERE key='company.logo'")).rows[0]);
  return values;
}
try {
  await seedUsers();
  const ceo=await authHeader(server.baseUrl,'ceo@test.eset.local');
  const guard=await authHeader(server.baseUrl,'guard@test.eset.local');
  const id=crypto.randomUUID();
  const routes=[
    ['POST',`/employees/${id}/documents`,ceo,'file','application/pdf',10],
    ['POST',`/employees/${id}/contracts/${id}/file`,ceo,'file','application/pdf',10],
    ['POST',`/employees/${id}/profile/photo`,ceo,'photo','image/png',5],
    ['POST','/employees/import/preview',ceo,'file','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',2],
    ['POST','/employees/import/confirm',ceo,'file','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',2],
    ['PUT','/cms/branding/logo',ceo,'logo','image/png',2],
    ['POST',`/gate-passes/${id}/exit`,guard,'photos','image/png',5],
    ['POST',`/gate-passes/${id}/return`,guard,'photos','image/png',5],
    ['POST',`/gate-passes/${id}/evidence`,guard,'photos','image/png',5],
  ];
  const before=await snapshot();
  for(const [method,route,token,name,mime,mb]of routes) {
    const file={name,mime,bytes:Buffer.from('test-file')};
    const cases=[
      body([['a[4294967294]',marker],['a[]',marker]],file),
      body([['a[b]',marker]],file),
      body([['a'.repeat(120),marker]],file),
      body(Array.from({length:5},(_,i)=>['x'+i,marker]),file),
      body([['note','x'.repeat(2100)]],file),
      body([],file,false),
      body([],{...file,bytes:Buffer.alloc(mb*1024*1024+1)}),
      Buffer.concat([...Array.from({length:name==='photos'?11:2},()=>body([],file,false)),Buffer.from(`--${boundary}--\r\n`)]),
    ];
    for(const [index,payload] of cases.entries()) {
      const r=await fetch(server.baseUrl+'/api/v1'+route,{method,headers:{Cookie:token,'Content-Type':`multipart/form-data; boundary=${boundary}`},body:payload});
      assert.equal(r.status,index===6?413:400,`${route}: case ${index}`);
      const text=await r.text();assert.doesNotMatch(text,/stack|node_modules|password|secret|do-not-echo-multipart-value/i);
      assert.equal((await fetch(server.baseUrl+'/api/v1/health')).status,200);
    }
  }
  // Abort after sending a partial accepted file: no controller/storage commit.
  await new Promise(resolve=>{
    const url=new URL(server.baseUrl+'/api/v1/cms/branding/logo');
    const req=http.request(url,{method:'PUT',headers:{Cookie:ceo,'Content-Type':`multipart/form-data; boundary=${boundary}`}});
    req.on('error',()=>resolve());
    req.write(body([],{name:'logo',mime:'image/png',bytes:Buffer.alloc(1024)},false));
    setTimeout(()=>{req.destroy();resolve();},30);
  });
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await fetch(server.baseUrl+'/api/v1/health')).status,200);
  assert.deepEqual(await snapshot(),before);
  assert.equal(saves,0);assert.equal(externalCalls,0);
  console.log('MULTIPART_SECURITY_PASS');
} finally {
  storageService.save=save;globalThis.fetch=originalFetch;
  await server.close();await pool.end();
}
