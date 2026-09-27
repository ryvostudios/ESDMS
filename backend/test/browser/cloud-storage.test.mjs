import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fakeCloudFetch} from '../fixtures/cloud-provider-fake.js';
const origin='http://localhost:5179';
process.env.FRONTEND_ORIGIN=origin;
process.env.CLOUD_STORAGE_OAUTH_ORIGIN=origin;
process.env.CLOUD_STORAGE_MASTER_KEY=crypto.randomBytes(32).toString('base64');
process.env.DROPBOX_CLIENT_ID='browser-test-app';process.env.DROPBOX_CLIENT_SECRET='browser-fake-secret';
process.env.GOOGLE_DRIVE_CLIENT_ID='browser-test-app';process.env.GOOGLE_DRIVE_CLIENT_SECRET='browser-fake-secret';
const {startTestServer,seedUsers,TEST_PASSWORD}=await import('../setup.js');
const {default:pool}=await import('../../src/config/database.js');
const root=path.resolve(import.meta.dirname,'../../..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('Chrome: cloud CMS, simulated OAuth, mixed files, authorization and disconnect protection',{timeout:180000},async()=>{
  const nativeFetch=globalThis.fetch,remote=fakeCloudFetch(nativeFetch);globalThis.fetch=remote.fetch;
  const server=await startTestServer(),users=await seedUsers();
  let vite,chrome,ws;const profile=await mkdtemp(`${tmpdir()}/esdms-cloud-browser-`);
  try {
    vite=spawn(process.execPath,[`${root}/frontend/node_modules/vite/bin/vite.js`,'--host','localhost','--port','5179','--strictPort'],{cwd:`${root}/frontend`,env:{...process.env,VITE_API_URL:'/api/v1',ESDMS_DEV_API_TARGET:server.baseUrl},stdio:'ignore'});
    for(let i=0;i<100;i++){try{if((await nativeFetch(origin)).ok)break;}catch{}await delay(100);}
    chrome=spawn(process.env.CHROME_BINARY||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
    const url=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);chrome.stderr.on('data',chunk=>{out+=chunk;const match=out.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
    ws=new WebSocket(url);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
    let seq=0;const pending=new Map();let intercepted=0;
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
    ws.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(pending.has(message.id)){const promise=pending.get(message.id);pending.delete(message.id);message.error?promise.reject(Error('CDP request failed')):promise.resolve(message.result);}
      if(message.method==='Fetch.requestPaused') {
        const request=new URL(message.params.request.url);intercepted++;
        const redirect=new URL(request.searchParams.get('redirect_uri'));
        assert.equal(redirect.origin,origin);assert.ok(request.searchParams.get('state'));
        redirect.searchParams.set('state',request.searchParams.get('state'));redirect.searchParams.set('code','browser-test-code');
        send('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:302,responseHeaders:[{name:'Location',value:redirect.toString()}]},message.sessionId).catch(()=>{});
      }
    });
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const cdp=(method,params={})=>send(method,params,sessionId);
    await cdp('Fetch.enable',{patterns:[{urlPattern:'https://www.dropbox.com/oauth2/authorize*'},{urlPattern:'https://accounts.google.com/o/oauth2/v2/auth*'}]});
    const evaluate=async expression=>{const response=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.exceptionDetails)throw Error('Browser script failed');return response.result.value;};
    const until=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw Error(`Browser timeout: ${expression}`);};
    const go=async route=>{await cdp('Page.navigate',{url:origin+route});await delay(200);await until('document.readyState==="complete"');};
    const fill=(id,value)=>evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const click=label=>evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent===${JSON.stringify(label)}).click()`);
    const login=async email=>{await go('/login');await evaluate("fetch('/api/v1/auth/logout',{method:'POST'})");await go('/login');await until('!!document.getElementById("email")');await fill('email',email);await fill('password',TEST_PASSWORD);await evaluate('document.querySelector("button[type=submit]").click()');await until('location.pathname!=="/login"');};
    const api=(method,route,body)=>evaluate(`fetch('/api/v1'+${JSON.stringify(route)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body?JSON.stringify(JSON.stringify(body)):'undefined'}}).then(async response=>({status:response.status,body:await response.json()}))`);
    await login('ceo@test.eset.local');await go('/cms/integrations');await until('document.body.innerText.includes("Active storage provider:")');
    const employee=await api('POST','/employees',{employeeCode:`CLOUD-${Date.now()}`,fullLegalName:'Cloud Browser Fixture',joiningDate:'2026-01-01',siteId:users.mainSite});assert.equal(employee.status,201);
    const type=await api('POST','/workforce-config/document-types',{name:`Cloud file ${Date.now()}`,allowedMimeTypes:['application/pdf'],hrCanUpload:true});assert.equal(type.status,201);
    const files=[];
    const upload=async()=>{
      const result=await evaluate(`(async()=>{const form=new FormData();form.append('documentTypeId',${JSON.stringify(type.body.data.id)});form.append('file',new Blob(['%PDF-1.4\\n%cloud-browser-fixture'],{type:'application/pdf'}),'record.pdf');const response=await fetch('/api/v1/employees/'+${JSON.stringify(employee.body.data.id)}+'/documents',{method:'POST',body:form});return {status:response.status,body:await response.json()};})()`);
      assert.equal(result.status,201,JSON.stringify(result.body));files.push(result.body.data.id);
    };
    await upload(); // legacy baseline
    for(const provider of ['Dropbox','Google Drive']) {
      await click(`Connect ${provider}`);await until('location.pathname==="/cms/integrations" && document.body.innerText.includes("Connected")');
      await until(`[...document.querySelectorAll('button')].some(b=>b.textContent===${JSON.stringify(`Use ${provider} for new files`)}&&!b.disabled)`);
      await click(`Use ${provider} for new files`);await until(`document.body.innerText.includes(${JSON.stringify(`Active storage provider: ${provider}`)})`);
      await upload();
    }
    assert.equal(intercepted,2);
    for(const id of files){const result=await evaluate(`fetch('/api/v1/employees/${employee.body.data.id}/documents/${id}/download').then(async r=>({status:r.status,text:await r.text()}))`);assert.equal(result.status,200);assert.match(result.text,/%PDF-1.4/);}
    assert.ok([...remote.objects.values()].some(file=>file.provider==='dropbox'&&file.path.includes('/Workforce/')));
    assert.ok([...remote.objects.values()].some(file=>file.provider==='google_drive'&&file.folder&&file.name==='ESDMS'));
    await go('/cms/integrations');await until('document.body.innerText.includes("Dependent files: 1")');
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].filter(b=>b.textContent==='Disconnect').every(b=>b.disabled)`),true);
    await click('Test connection');await until('document.body.innerText.includes("Storage settings updated.")');
    await evaluate('window.cloudPriorDocument=true');
    await click('Reconnect Dropbox');await until('!window.cloudPriorDocument && location.pathname==="/cms/integrations" && document.body.innerText.includes("Reconnect Dropbox")');
    const snapshot=(await api('GET','/cms/cloud-storage')).body.data;
    const dropbox=snapshot.providers.find(p=>p.provider==='dropbox');assert.equal((await api('POST','/cms/cloud-storage/dropbox/disconnect',{revision:dropbox.revision})).status,409);
    await click('Use legacy storage for new files');await until('document.body.innerText.includes("Active storage provider: Current legacy storage")');
    await go('/cms/audit');await until('document.body.innerText.includes("ACTIVE_PROVIDER_CHANGED")');
    for(const width of [1440,768,390]){await go('/cms/integrations');await until('document.body.innerText.includes("Cloud Storage")');await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await delay(100);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);const screenshot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(`${tmpdir()}/esdms-cloud-${width}.png`,Buffer.from(screenshot.data,'base64'));}
    await login('employee@test.eset.local');assert.equal((await api('GET','/cms/cloud-storage')).status,403);assert.equal((await api('POST','/cms/cloud-storage/dropbox/connect',{})).status,403);
    const before=remote.calls.length;for(const id of files)assert.ok([403,404].includes((await api('GET',`/employees/${employee.body.data.id}/documents/${id}/download`)).status));assert.equal(remote.calls.length,before);
    // Cross-site actor holds file capabilities but still cannot reach this site.
    await login('ceo@test.eset.local');for(const code of ['employees.view','employee_documents.view','employee_documents.download'])assert.equal((await api('PUT',`/users/${users.otherSiteAdmin}/permissions/${code}`,{effect:'GRANT'})).status,200);
    await login('admin-othersite@test.eset.local');const beforeCross=remote.calls.length;
    for(const id of files)assert.ok([403,404].includes((await api('GET',`/employees/${employee.body.data.id}/documents/${id}/download`)).status));assert.equal(remote.calls.length,beforeCross);
    console.log('PASS: real browser/login/CMS and mixed-provider file authorization; OAuth consent/provider HTTP simulated, no live provider claim.');
  } finally {
    globalThis.fetch=nativeFetch;ws?.close();chrome?.kill();vite?.kill();await server.close();await pool.end();await delay(300);await rm(profile,{recursive:true,force:true});
  }
});
