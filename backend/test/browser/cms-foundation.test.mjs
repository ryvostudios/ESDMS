import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startTestServer, seedUsers, TEST_PASSWORD } from '../setup.js';
import pool from '../../src/config/database.js';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../..');
const origin='http://localhost:5179';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('real Chrome: CMS permissions, configuration, audit, safe status and responsive layouts', {timeout:180000}, async()=>{
 const server=await startTestServer(); const users=await seedUsers();
 let vite,chrome,ws; const profile=await mkdtemp(`${tmpdir()}/esdms-cms-browser-`);
 try {
  const login=await fetch(`${server.baseUrl}/api/v1/auth/login`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({email:'ceo@test.eset.local',password:TEST_PASSWORD})});
  assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const [id,codes] of [[users.siteManager,['cms.permissions.view','cms.audit.view','cms.content.manage']],[users.upperManagement,['cms.permissions.view']]]) {
   for(const code of codes) {
    const r=await fetch(`${server.baseUrl}/api/v1/users/${id}/permissions/${code}`,{method:'PUT',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:JSON.stringify({effect:'GRANT'})});assert.equal(r.status,200);
   }
  }
  vite=spawn(process.execPath,[`${root}/frontend/node_modules/vite/bin/vite.js`,'--host','localhost','--port','5179','--strictPort'],{cwd:`${root}/frontend`,env:{...process.env,VITE_API_URL:'/api/v1',ESDMS_DEV_API_TARGET:server.baseUrl},stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}await delay(100);}
  chrome=spawn(process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const url=await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);chrome.stderr.on('data',x=>{stderr+=x;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
  ws=new WebSocket(url); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const cdp=(m,p={})=>send(m,p,sessionId);
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw Error(`Browser timeout: ${expression}; ${await evaluate('document.body.innerText.slice(-1000)')}`);};
  const go=async path=>{await cdp('Page.navigate',{url:origin+path});await delay(200);await until('document.readyState === "complete"');};
  const fill=async(id,value)=>evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const signIn=async email=>{
   await go("/login");
   await evaluate(`fetch('/api/v1/auth/logout',{method:'POST'})`);
   await go('/login');await until('!!document.getElementById("email")');
   await fill('email',email+'@test.eset.local');await fill('password',TEST_PASSWORD);
   await evaluate('document.querySelector("button[type=submit]").click()');await until('location.pathname !== "/login"');
  };
  const status=path=>evaluate(`fetch(${JSON.stringify('/api/v1'+path)}).then(r=>r.status)`);
  await signIn('ceo');await go('/cms');await until(`[...document.querySelectorAll('a')].filter(a=>a.getAttribute('href')?.startsWith('/cms/')).length===9`);
  await go('/cms/organization');await until('document.body.innerText.includes("Test Secondary Site") && document.body.innerText.includes("Assistant WTG Team Lead")');
  await go('/cms/users');await until('document.body.innerText.includes("Test Employee")');
  await go('/cms/permissions');await until('document.body.innerText.includes("Manage Application Content")');
  assert.equal(await evaluate(`[...document.querySelectorAll('input')].some(input => input.value === 'cms.content.manage')`),false);
  await go('/cms/content');await until('!!document.getElementById("login.heading")');
  await fill('login.heading','Company browser verification');
  await evaluate(`document.getElementById('login.heading').closest('form').querySelector('button[type=submit]').click()`);
  await until(`fetch('/api/v1/cms/public-content').then(r=>r.json()).then(r=>r.data['login.heading']==='Company browser verification')`);
  await go('/cms/audit');await until('!!document.getElementById("auditAction")');await fill('auditAction','CMS_SETTING_CHANGED');
  await evaluate(`document.getElementById('auditAction').closest('form').querySelector('button[type=submit]').click()`);
  await until('document.body.innerText.includes("Company browser verification")');
  await go('/cms/system');await until('document.body.innerText.includes("1787434000000_cms-foundation")');
  assert.equal(await evaluate(`['DATABASE_URL','JWT_SECRET','postgresql://'].some(value=>document.body.innerText.includes(value))`),false);
  await go('/cms/integrations');await until('document.body.innerText.includes("Dropbox")');assert.equal(await evaluate('document.body.innerText.includes("not configured")'),true);
  await evaluate(`fetch('/api/v1/auth/logout',{method:'POST'})`);await go('/login');await until('document.querySelector("h1")?.textContent==="Company browser verification"');
  await signIn('hr');await go('/cms');await until('document.body.innerText.includes("Organization")');assert.equal(await status('/cms/audit'),403);assert.equal(await status('/cms/system'),403);
  await go('/cms/branding');await until('document.body.innerText.includes("Access denied")');
  await signIn('um');await go('/cms');await until('document.body.innerText.includes("Permission Catalog")');assert.equal(await status('/cms/settings/content'),403);
  await go('/cms/permissions');await until('document.body.innerText.includes("Manage Application Content")');assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="Save metadata")'),false);
  await signIn('manager');await go('/cms');await until('document.body.innerText.includes("Application Content")');assert.equal(await status('/cms/settings/content'),200);assert.equal(await status('/cms/settings/branding'),403);
  await go('/cms/audit');await until('!!document.getElementById("auditAction")');assert.equal(await evaluate('document.body.innerText.includes("Company browser verification")'),false);
  await signIn('employee');await until('!document.body.innerText.includes("System Administration")');assert.equal(await status('/cms'),403);await go('/cms');await until('document.body.innerText.includes("Access denied") || document.body.innerText.includes("permission")');
  await signIn('ceo');await go('/cms');await until(`[...document.querySelectorAll('a')].filter(a=>a.getAttribute('href')?.startsWith('/cms/')).length===9`);
  for(const width of [1440,768,390]){
   await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await delay(100);
   assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,`CMS overflow at ${width}`);
   const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(`${tmpdir()}/esdms-cms-${width}.png`,Buffer.from(shot.data,'base64'));
  }
  await go('/cms/content');await until('!!document.getElementById("login.heading")');assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  console.log('PASS: real CEO/HR/UM/manager/ordinary login; CMS navigation/API denial; organization/users/catalog; content change consumed by login; scoped audit/filter; safe system/status; 1440/768/390px.');
 } finally {
  ws?.close();chrome?.kill();vite?.kill();await server.close();await pool.end();
  await delay(300);await rm(profile,{recursive:true,force:true});
 }
});
