import { randomUUID } from 'node:crypto';
import { mutateConfiguration } from '../src/shared/audit/configuration-audit.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/database.js';
import { startTestServer, seedUsers } from './setup.js';
import { authHeader, apiRequest } from './gate-pass-helpers.js';
let server, users, tokens;
const call = (token, method, path, body) => apiRequest(server.baseUrl,method,`/api/v1${path}`,{token,body});
const grant = (id,code,effect='GRANT') => call(tokens.ceo,'PUT',`/users/${id}/permissions/${code}`,{effect});
before(async()=>{
  server=await startTestServer(); users=await seedUsers();
  await pool.query('DELETE FROM user_permission_overrides WHERE user_id=ANY($1::uuid[])',[[users.hr,users.upperManagement,users.siteManager,users.employee]]);
  tokens={};for(const [key,email]of Object.entries({ceo:'ceo',hr:'hr',um:'um',manager:'manager',employee:'employee'}))tokens[key]=await authHeader(server.baseUrl,`${email}@test.eset.local`);
});
after(async()=>{
  await pool.query('DELETE FROM user_permission_overrides WHERE user_id=ANY($1::uuid[])',[[users.hr,users.upperManagement,users.siteManager,users.employee]]);
  await server.close();await pool.end();
});
test('CMS areas require effective capabilities; HR and explicitly authorized UM/manager stay bounded',async()=>{
  assert.equal((await call(null,'GET','/cms')).status,401);
  for(const path of ['/cms','/cms/permissions','/cms/audit','/cms/system','/cms/settings/content','/cms/sites','/cms/integrations']) assert.equal((await call(tokens.employee,'GET',path)).status,403,path);
  const ceo=await call(tokens.ceo,'GET','/cms');assert.equal(ceo.status,200);assert.equal(ceo.body.data.length,9);
  const hr=await call(tokens.hr,'GET','/cms');assert.equal(hr.status,200);assert.ok(hr.body.data.some(a=>a.id==='organization'));assert.ok(hr.body.data.every(a=>['organization','users','workforce'].includes(a.id)));
  for(const token of [tokens.hr,tokens.um,tokens.manager]) assert.equal((await call(token,'GET','/cms/settings/content')).status,403);
  for(const id of [users.upperManagement,users.siteManager])assert.equal((await grant(id,'cms.permissions.view')).status,200);
  for(const token of [tokens.um,tokens.manager]){
    assert.equal((await call(token,'GET','/cms/permissions')).status,200);
    assert.equal((await call(token,'PATCH','/cms/permissions/users.view',{})).status,403);
    assert.equal((await call(token,'GET','/cms/system')).status,403);
  }
  assert.equal((await grant(users.upperManagement,'cms.permissions.view','DENY')).status,200);
  assert.equal((await call(tokens.um,'GET','/cms/permissions')).status,403);
});
test('Organization sites retain assigned-site filtering and CEO company visibility',async()=>{
  const hr=await call(tokens.hr,'GET','/cms/sites');assert.equal(hr.status,200);assert.deepEqual(hr.body.data.map(s=>s.id),[users.mainSite]);
  const ceo=await call(tokens.ceo,'GET','/cms/sites');assert.ok(ceo.body.data.some(s=>s.id===users.otherSite));
});
test('permission metadata is meaningful and editable without creation, rename or enforcement changes',async()=>{
  const catalog=await call(tokens.ceo,'GET','/cms/permissions');assert.equal(catalog.status,200);
  assert.ok(catalog.body.data.every(p=>p.display_name.trim()&&p.description.trim()&&p.category.trim()));
  const original=catalog.body.data.find(p=>p.code==='employees.view');
  const form={displayName:'View Employee Records',description:original.description,category:'Workforce',helpText:'Within permitted scope.'};
  assert.equal((await call(tokens.ceo,'PATCH','/cms/permissions/employees.view',{...form,code:'root.all'})).status,400);
  assert.equal((await call(tokens.ceo,'POST','/cms/permissions',{code:'root.all',...form})).status,404);
  assert.equal((await call(tokens.ceo,'PATCH','/cms/permissions/root.all',form)).status,404);
  const changed=await call(tokens.ceo,'PATCH','/cms/permissions/employees.view',form);assert.equal(changed.status,200);assert.equal(changed.body.data.code,'employees.view');
  assert.equal((await pool.query("SELECT count(*) FROM permissions WHERE code='root.all'")).rows[0].count,'0');
  const audit=await pool.query("SELECT metadata FROM governance_audit_log WHERE action='PERMISSION_METADATA_CHANGED' AND metadata->>'code'='employees.view' ORDER BY created_at DESC LIMIT 1");
  assert.equal(audit.rows[0].metadata.before.display_name,original.display_name);
  await call(tokens.ceo,'PATCH','/cms/permissions/employees.view',{displayName:original.display_name,description:original.description,category:original.category,helpText:original.help_text});
});
test('public text uses allowlisted typed keys, optimistic locking, transactional audit and independent category authority',async()=>{
  const get=()=>call(tokens.ceo,'GET','/cms/settings/content');
  const row=(await get()).body.data.find(r=>r.key==='login.heading');
  const patch=value=>call(tokens.ceo,'PATCH','/cms/settings/login.heading',{value,revision:row.revision});
  for(const value of ['<img src=x onerror=alert(1)>','<script>alert(1)</script>','',42,'x'.repeat(121)])assert.equal((await patch(value)).status,400);
  assert.equal((await call(tokens.ceo,'PATCH','/cms/settings/arbitrary.script',{value:'x',revision:1})).status,404);
  assert.equal((await call(tokens.ceo,'PATCH','/cms/settings/login.heading',{value:'Safe',revision:row.revision,secret:'not accepted'})).status,400);
  const changed=await patch('Welcome to E-Set');assert.equal(changed.status,200,JSON.stringify(changed.body));
  assert.equal((await patch('Stale overwrite')).status,409);
  const publicResult=await call(null,'GET','/cms/public-content');assert.equal(publicResult.status,200);assert.equal(publicResult.body.data['login.heading'],'Welcome to E-Set');assert.equal(Object.keys(publicResult.body.data).length,8);assert.ok(!('company.logo' in publicResult.body.data));
  const audit=await pool.query("SELECT metadata,scope_site_id FROM governance_audit_log WHERE action='CMS_SETTING_CHANGED' ORDER BY created_at DESC LIMIT 1");
  assert.equal(audit.rows[0].metadata.before,row.value);assert.equal(audit.rows[0].metadata.after,'Welcome to E-Set');assert.equal(audit.rows[0].scope_site_id,null);
  assert.equal((await grant(users.siteManager,'cms.content.manage')).status,200);
  assert.equal((await call(tokens.manager,'GET','/cms/settings/content')).status,200);
  assert.equal((await call(tokens.manager,'PATCH','/cms/settings/company.short_name',{value:'No',revision:1})).status,403);
  assert.equal((await grant(users.siteManager,'cms.content.manage','DENY')).status,200);
  assert.equal((await call(tokens.manager,'PATCH','/cms/settings/login.heading',{value:'No',revision:changed.body.data.revision})).status,403);
  await call(tokens.ceo,'PATCH','/cms/settings/login.heading',{value:row.value,revision:changed.body.data.revision});
});
test('audit projection retains historical site, paginates deterministically and withholds sensitive metadata',async()=>{
  assert.equal((await grant(users.siteManager,'cms.audit.view')).status,200);
  const inserted=[];
  for(const target of [users.employee,users.otherSiteTeamLead]){
    const r=await pool.query("INSERT INTO governance_audit_log(actor_user_id,target_user_id,action,metadata) VALUES ($1,$2,'USER_CREATED',$3) RETURNING id,scope_site_id",[users.ceo,target,{password:'DO_NOT_DISCLOSE',amount:123456,token:'DO_NOT_DISCLOSE'}]);inserted.push(r.rows[0]);
  }
  assert.equal(inserted[0].scope_site_id,users.mainSite);assert.equal(inserted[1].scope_site_id,users.otherSite);
  await pool.query('UPDATE users SET site_id=$1,department_id=$3 WHERE id=$2',[users.otherSite,users.employee,users.otherSiteDepartment]);
  try{
    const result=await call(tokens.manager,'GET','/cms/audit?action=USER_CREATED');assert.equal(result.status,200);
    assert.ok(result.body.data.items.some(r=>r.id===inserted[0].id));assert.ok(!result.body.data.items.some(r=>r.id===inserted[1].id));
    assert.ok(!JSON.stringify(result.body).includes('DO_NOT_DISCLOSE'));assert.ok(!JSON.stringify(result.body).includes('123456'));
    assert.equal((await call(tokens.manager,'GET',`/cms/audit?siteId=${users.otherSite}`)).status,403);
    const other=await call(tokens.ceo,'GET',`/cms/audit?siteId=${users.otherSite}&action=USER_CREATED`);assert.ok(other.body.data.items.some(r=>r.id===inserted[1].id));
    const p1=(await call(tokens.ceo,'GET','/cms/audit?pageSize=1')).body.data;
    const p2=(await call(tokens.ceo,'GET','/cms/audit?pageSize=1&page=2')).body.data;
    assert.equal(p1.hasMore,true);assert.notEqual(p1.items[0].id,p2.items[0].id);
    assert.equal((await call(tokens.ceo,'GET','/cms/audit?pageSize=10000')).status,400);
    assert.equal((await call(tokens.ceo,'GET','/cms/audit?unknown=x')).status,400);
  }finally{await pool.query('UPDATE users SET site_id=$1,department_id=$3 WHERE id=$2',[users.mainSite,users.employee,users.departmentA]);}
});
test('system and integration status only expose fixed safe projections, no credential endpoints',async()=>{
  const system=await call(tokens.ceo,'GET','/cms/system');assert.equal(system.status,200,JSON.stringify(system.body));
  assert.deepEqual(Object.keys(system.body.data).sort(),['backendRevision','environment','expectedMigration','latestMigration','expectedProvisioning','actualProvisioning','ready','schemaCompatible','authServingHealthy','runtimeAccessHealthy','runtimeProvisioningCompatible'].sort());
  assert.equal(system.body.data.expectedMigration,'1787437000000_cms-web-pwa-branding');
  const integrations=await call(tokens.ceo,'GET','/cms/integrations');assert.equal(integrations.status,200);
  assert.ok(integrations.body.data.filter(i=>['Dropbox','Google Drive','Attendance'].includes(i.name)).every(i=>i.state==='not_configured'));
  assert.equal((await call(tokens.ceo,'POST','/cms/integrations',{token:'not accepted'})).status,404);
});

test('audit date ranges compare instants when timestamp precision differs',async()=>{
  const range = (from, to) => `/cms/audit?${new URLSearchParams({from,to})}`;
  const start = '2026-01-01T00:00:00Z';
  const later = '2026-01-01T00:00:00.100Z';
  assert.equal((await call(tokens.ceo,'GET',range(start,later))).status,200);
  assert.equal((await call(tokens.ceo,'GET',range(later,start))).status,400);
  assert.equal((await call(tokens.ceo,'GET',range(start,'2026-01-01T00:00:00.000Z'))).status,200);
});

test('reused Organization and Workforce reference writes audit atomically without changing lifecycle rules',async()=>{
  const created=await call(tokens.hr,'POST','/departments',{name:`CMS audit department ${Date.now()}`});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const id=created.body.data.id;
  assert.equal((await call(tokens.hr,'PATCH',`/departments/${id}`,{isActive:false})).status,200);
  const rows=await pool.query("SELECT metadata,scope_site_id FROM governance_audit_log WHERE action='CONFIGURATION_CHANGED' AND metadata->>'targetId'=$1 ORDER BY created_at,id",[id]);
  assert.equal(rows.rowCount,2);assert.equal(rows.rows[0].metadata.operation,'create');
  assert.equal(rows.rows[1].metadata.before.is_active,true);assert.equal(rows.rows[1].metadata.after.is_active,false);assert.equal(rows.rows[1].scope_site_id,users.mainSite);
  assert.equal((await call(tokens.hr,'PATCH',`/departments/${id}`,{isActive:true})).status,200);
  const global=await call(tokens.hr,'POST','/employment-types',{code:`CMS${Date.now()}`,name:'CMS audit employment type'});
  assert.equal(global.status,201,JSON.stringify(global.body));
  const globalAudit=await pool.query("SELECT scope_site_id FROM governance_audit_log WHERE metadata->>'targetId'=$1",[global.body.data.id]);assert.equal(globalAudit.rows[0].scope_site_id,null);
});

test('reference update rolls back when its audit cannot be recorded',async()=>{
  const before=(await pool.query('SELECT name FROM departments WHERE id=$1',[users.departmentA])).rows[0].name;
  await assert.rejects(()=>mutateConfiguration({id:randomUUID()},'departments',users.departmentA,
    async client=>(await client.query("UPDATE departments SET name='Must roll back' WHERE id=$1 RETURNING id",[users.departmentA])).rows[0]),{code:'23503'});
  assert.equal((await pool.query('SELECT name FROM departments WHERE id=$1',[users.departmentA])).rows[0].name,before);
});

test('audit names the target user and override capability, never the free-text reason',async()=>{
  const denied=await call(tokens.ceo,'PUT',`/users/${users.employee}/permissions/demand.view`,{effect:'DENY',reason:'DO_NOT_DISCLOSE_REASON'});
  assert.equal(denied.status,200,JSON.stringify(denied.body));
  try{
    const result=await call(tokens.ceo,'GET','/cms/audit?action=PERMISSION_DENIED&pageSize=5');
    assert.equal(result.status,200);
    const row=result.body.data.items.find(item=>item.target_user_id===users.employee);
    assert.ok(row,'the DENY event is listed');
    assert.equal(row.target_user_email,'employee@test.eset.local');
    assert.equal(row.target_user_name,'Test Employee');
    assert.equal(row.capability_code,'demand.view');
    assert.ok(!JSON.stringify(result.body).includes('DO_NOT_DISCLOSE_REASON'));
  }finally{
    await call(tokens.ceo,'DELETE',`/users/${users.employee}/permissions/demand.view`);
  }
});
