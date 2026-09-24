import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../core/api/client.js';
import { useAuth } from '../../core/auth/AuthContext.jsx';
import { PageHeader } from '../../shared/components/PageHeader.jsx';
import { Button } from '../../shared/components/Button.jsx';
import { Input, Textarea, FormField } from '../../shared/components/FormField.jsx';
import { ErrorState, LoadingState } from '../../shared/components/StatePanel.jsx';
import { useCompanyLogo } from './company-logo.js';
import { WorkforceConfigPage } from '../workforce/pages/WorkforceConfigPage.jsx';
import { GovernancePage } from '../workforce/pages/GovernancePage.jsx';
import styles from './CmsPage.module.css';

export function CmsPage() {
  const {area} = useParams();
  const {hasPermission} = useAuth();
  const [areas,setAreas] = useState(null);
  const [error,setError] = useState('');
  useEffect(()=>{apiClient.get('/cms').then(r=>setAreas(r.data)).catch(e=>setError(e.message));},[]);
  if(error) return <ErrorState message={error}/>;
  if(!areas) return <LoadingState/>;
  const selected = areas.find(item=>item.id===area);
  if(area && !selected) return <ErrorState title="Access denied" message="This area requires its own capability."/>;
  return <div className={styles.page}>
    <Link to="/cms">System Administration</Link>
    <PageHeader title={selected?.label || 'System Administration'} description="Each area uses its own permissions. Organizational titles do not grant application authority."/>
    {!area && <div className={styles.cards}>{areas.map(item=><Link className={styles.card} key={item.id} to={`/cms/${item.id}`}><h2>{item.label}</h2><span>Open {item.label.toLowerCase()}</span></Link>)}</div>}
    {area==='organization' && <><ReadOnly path="sites" render={sites=><section className={styles.panel}><h2>Sites</h2><p>Site lifecycle remains release-managed. Existing sites and historical relationships are preserved.</p>{sites.map(site=><p key={site.id}>{site.name} · {site.code} · {site.is_active?'Active':'Inactive'}</p>)}</section>}/><WorkforceConfigPage section="organization"/></>}
    {area==='users' && <>{hasPermission('employees.view') && <p><Link to="/workforce/employees">Employee records and employee/user association</Link></p>}<GovernancePage/></>}
    {area==='workforce' && <WorkforceConfigPage section="workforce"/>}
    {area==='permissions' && <PermissionCatalog/>}
    {['branding','content'].includes(area) && <Settings key={area} category={area}/>}
    {area==='integrations' && <ReadOnly path="integrations" render={items=><><p>No credentials are stored or accepted here. Provider connections are deferred.</p><div className={styles.cards}>{items.map(item=><section className={styles.panel} key={item.name}><h2>{item.name}</h2><p>{item.state.replaceAll('_',' ')}</p><p>{item.detail}</p></section>)}</div></>}/>}
    {area==='audit' && <AuditCenter/>}
    {area==='system' && <ReadOnly path="system" render={data=><section className={styles.panel}><h2>Serving status</h2><p>{data.ready?'Ready':'Not ready — release verification required'}</p><dl className={styles.details}>{Object.entries(data).map(([key,value])=><div key={key}><dt>{key.replace(/([A-Z])/g,' $1')}</dt><dd>{String(value??'Not available')}</dd></div>)}</dl><p>Frontend revision: {import.meta.env.VITE_BUILD_REVISION || 'development'}</p></section>}/>}
  </div>;
}
function ReadOnly({path,render}) {
  const [data,setData]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;apiClient.get(`/cms/${path}`).then(r=>{if(active)setData(r.data);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[path]);
  if(error)return <ErrorState message={error}/>;
  return data?render(data):<LoadingState/>;
}
function Settings({category}) {
  const [rows,setRows]=useState(null),[error,setError]=useState('');
  const load=useCallback(()=>apiClient.get(`/cms/settings/${category}`).then(r=>setRows(r.data)).catch(e=>setError(e.message)),[category]);
  useEffect(()=>{load();},[load]);
  return <>{error&&<ErrorState message={error}/>}<p>Company-wide, public plain text. Never enter passwords, API keys or confidential information.</p>{category==='branding'&&<p>Branding applies to newly generated documents. Issued Gate Pass, IPO and Delivery Challan PDFs keep the branding they were issued with; Demand List PDFs are regenerated from live data and always use the current branding.</p>}{rows?.map(row=>row.type==='logo'?<LogoEditor key={`${row.key}:${row.revision}`} row={row} onSaved={load}/>:<SettingEditor key={`${row.key}:${row.revision}`} row={row} onSaved={load}/>)}{!rows&&!error&&<LoadingState/>}</>;
}
function SettingEditor({row,onSaved}) {
  const [value,setValue]=useState(row.value),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  async function save(event){event.preventDefault();setSaving(true);try{await apiClient.patch(`/cms/settings/${row.key}`,{value,revision:row.revision});setMessage('Saved');await onSaved();}catch(e){setMessage(e.message);}finally{setSaving(false);}}
  return <section className={styles.panel}><h2>{row.label}</h2><p>{row.description}</p><form onSubmit={save}><FormField label={row.label} htmlFor={row.key}><Textarea id={row.key} value={value} onChange={e=>setValue(e.target.value)} maxLength={row.max} required={row.min>0}/></FormField><span className={styles.secondary}>{row.key} · plain text · company-wide</span><Button type="submit" loading={saving}>Save {row.label.toLowerCase()}</Button>{message&&<p role="status">{message}</p>}</form></section>;
}
const MAX_LOGO_BYTES = 2*1024*1024;
function LogoEditor({row,onSaved}) {
  const logoUrl=useCompanyLogo(row.revision);
  const [file,setFile]=useState(null),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  function choose(event){
    const selected=event.target.files?.[0]??null;setMessage('');
    // Convenience only: the server re-validates the actual bytes.
    if(selected&&!['image/png','image/jpeg'].includes(selected.type)){setFile(null);setMessage('Choose a PNG or JPEG image.');return;}
    if(selected&&selected.size>MAX_LOGO_BYTES){setFile(null);setMessage('The logo must be 2 MB or smaller.');return;}
    setFile(selected);
  }
  async function run(action){setSaving(true);try{await action();setMessage('Saved');await onSaved();}catch(e){setMessage(e.message);}finally{setSaving(false);}}
  function upload(event){event.preventDefault();if(!file)return;const form=new FormData();form.append('revision',String(row.revision));form.append('logo',file);run(()=>apiClient.put('/cms/branding/logo',form,{isForm:true}));}
  return <section className={styles.panel}><h2>{row.label}</h2><p>{row.description}</p>
    <div className={styles.logoPreview}>{logoUrl?<img src={logoUrl} alt="Current company logo"/>:<span>Logo unavailable — documents show the company name only.</span>}</div>
    <p className={styles.secondary}>{row.logo.description}</p>
    <form onSubmit={upload}><FormField label="Replace logo (PNG or JPEG, up to 2 MB)" htmlFor="companyLogo"><input id="companyLogo" type="file" accept="image/png,image/jpeg" onChange={choose}/></FormField>
      <Button type="submit" loading={saving} disabled={!file}>Upload logo</Button>
      {row.logo.source==='uploaded'&&<Button type="button" variant="secondary" disabled={saving} onClick={()=>run(()=>apiClient.del('/cms/branding/logo',{body:{revision:row.revision}}))}>Restore default E-Set logo</Button>}
      {message&&<p role="status">{message}</p>}</form></section>;
}
function PermissionCatalog() {
  const {hasPermission}=useAuth();const [rows,setRows]=useState(null),[search,setSearch]=useState(''),[error,setError]=useState('');
  useEffect(()=>{apiClient.get('/cms/permissions').then(r=>setRows(r.data)).catch(e=>setError(e.message));},[]);
  return <>{error&&<ErrorState message={error}/>}<p>Descriptions explain permissions. Editing them never changes enforcement or assigns authority.</p><FormField label="Find a permission" htmlFor="permissionSearch"><Input id="permissionSearch" value={search} onChange={e=>setSearch(e.target.value)}/></FormField>{rows?.filter(row=>`${row.display_name} ${row.description} ${row.code}`.toLowerCase().includes(search.toLowerCase())).map(row=><PermissionEditor key={row.code} row={row} editable={hasPermission('cms.permissions.manage')}/>)}{!rows&&!error&&<LoadingState/>}</>;
}
function PermissionEditor({row,editable}) {
  const [form,setForm]=useState({displayName:row.display_name,description:row.description,category:row.category,helpText:row.help_text}),[message,setMessage]=useState('');
  async function save(e){e.preventDefault();try{await apiClient.patch(`/cms/permissions/${row.code}`,form);setMessage('Metadata saved. Enforcement is unchanged.');}catch(error){setMessage(error.message);}}
  return <details className={styles.panel}><summary>{form.displayName}</summary><p>{form.description}</p><p className={styles.secondary}>Immutable code: {row.code}</p>{editable&&<form onSubmit={save}>{[['displayName','Display name',150],['description','Description',1000],['category','Category',80],['helpText','Help text',500]].map(([key,label,max])=><FormField key={key} label={label} htmlFor={`${row.code}-${key}`}><Input id={`${row.code}-${key}`} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})} maxLength={max} required={key!=='helpText'}/></FormField>)}<Button type="submit">Save metadata</Button>{message&&<p role="status">{message}</p>}</form>}</details>;
}
function AuditCenter() {
  const {user}=useAuth();const [filters,setFilters]=useState({action:'',siteId:'',from:'',to:''}),[query,setQuery]=useState(''),[page,setPage]=useState(1),[data,setData]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;apiClient.get(`/cms/audit?page=${page}&${query}`).then(r=>{if(active){setData(r.data);setError('');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[page,query]);
  function apply(e){e.preventDefault();const params=new URLSearchParams();for(const [key,value]of Object.entries(filters))if(value)params.set(key,['from','to'].includes(key)?new Date(value).toISOString():value);setPage(1);setQuery(params.toString());}
  return <><p>Governance, Workforce and configuration events. Operational workflow history remains in its module. Historical events without a captured site are CEO-only. Sensitive audit payloads are withheld.</p><form className={styles.filters} onSubmit={apply}>
    <FormField label="Action code (optional)" htmlFor="auditAction"><Input id="auditAction" value={filters.action} onChange={e=>setFilters({...filters,action:e.target.value})}/></FormField>
    {user.role==='CEO'&&<FormField label="Site ID (optional)" htmlFor="auditSite"><Input id="auditSite" value={filters.siteId} onChange={e=>setFilters({...filters,siteId:e.target.value})}/></FormField>}
    {['from','to'].map(key=><FormField key={key} label={key==='from'?'From':'Until'} htmlFor={`audit-${key}`}><Input id={`audit-${key}`} type="datetime-local" value={filters[key]} onChange={e=>setFilters({...filters,[key]:e.target.value})}/></FormField>)}<Button type="submit">Apply filters</Button></form>
    {error&&<ErrorState message={error}/>}{data?.items.map(row=><article className={styles.panel} key={row.id}><h3>{row.action.toLowerCase().replaceAll('_',' ')}</h3><p>{row.actor_name} · {new Date(row.created_at).toLocaleString()}</p>{row.configuration_key&&<p>{row.configuration_key}{row.configuration_target_id && ` · ${row.configuration_target_id}`}</p>}{row.change&&<p>Before: {String(row.change.before)}<br/>After: {String(row.change.after)}</p>}<small>Event {row.id}</small></article>)}{data?.items.length===0&&<p>No matching events.</p>}
    <div className={styles.pager}><Button disabled={page===1} onClick={()=>setPage(page-1)}>Previous</Button><span>Page {page}</span><Button disabled={!data?.hasMore} onClick={()=>setPage(page+1)}>Next</Button></div></>;
}
