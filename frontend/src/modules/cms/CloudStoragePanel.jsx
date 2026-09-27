import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../core/api/client.js';
import { useAuth } from '../../core/auth/AuthContext.jsx';
import { Button } from '../../shared/components/Button.jsx';
import { ErrorState, LoadingState } from '../../shared/components/StatePanel.jsx';
import styles from './CmsPage.module.css';
const LABELS={legacy:'Current legacy storage',dropbox:'Dropbox',google_drive:'Google Drive'};
export function CloudStoragePanel() {
  const {hasPermission}=useAuth();
  const manages=hasPermission('cms.integrations.manage');
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const load=useCallback(async()=>{const response=await apiClient.get('/cms/cloud-storage');setData(response.data);},[]);
  useEffect(()=>{
    let active=true;
    apiClient.get('/cms/cloud-storage').then(response=>{if(active)setData(response.data);}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[]);
  async function action(path,body={}) {
    setBusy(true);setError('');setNotice('');
    try {
      const result=await apiClient.post(`/cms/cloud-storage/${path}`,body);
      if(result.data.authorizeUrl) {
        const url=new URL(result.data.authorizeUrl);
        if(!['https://www.dropbox.com','https://accounts.google.com'].includes(url.origin)) throw new Error('Invalid authorization destination.');
        window.location.assign(url.toString());return;
      }
      await load();setNotice('Storage settings updated. Existing files remain with their original provider.');
    } catch(e) {setError(e.message);await load().catch(()=>{});}
    finally {setBusy(false);}
  }
  return <section aria-label="Cloud Storage">
    <h2>Cloud Storage</h2>
    <p>Connect an account, then explicitly select it for new files. Existing files stay with their original account.</p>
    {error&&<ErrorState message={error}/>}{notice&&<p role="status">{notice}</p>}
    {!data&&!error&&<LoadingState/>}
    {data&&<>
      <p><strong>Active storage provider: {LABELS[data.activeProvider]}</strong></p>
      {manages&&data.activeProvider!=='legacy'&&<Button disabled={busy} onClick={()=>action('active',{provider:'legacy',revision:data.revision})}>Use legacy storage for new files</Button>}
      <div className={styles.cards}>{data.providers.map(provider=><section className={styles.panel} key={provider.provider}>
        <h3>{LABELS[provider.provider]}</h3>
        <p>{!provider.setupComplete?'Provider setup incomplete':provider.last_error||provider.status==='error'?'Error':provider.status==='connected'?'Connected':provider.status==='disconnecting'?'Disconnect pending':'Not connected'}</p>
        {!provider.setupComplete&&<p>A deployment administrator must configure the provider application and encryption before connecting an account.</p>}
        {provider.account_label&&<p>Account: {provider.account_label}</p>}
        <p>Root folder: {provider.rootFolder}</p>
        <p>Dependent files: {provider.dependent_files}</p>
        <p>Last successful operation: {provider.last_success_at?new Date(provider.last_success_at).toLocaleString():'None'}</p>
        <p>Last connection test: {provider.last_test_at?new Date(provider.last_test_at).toLocaleString():'None'}</p>
        {provider.dependent_files>0&&<p>Disconnect and account replacement are blocked while files depend on this account. Reconnect must use the same account.</p>}
        {manages&&<div className={styles.cloudActions}>
          <Button disabled={busy||!provider.setupComplete||provider.status==='disconnecting'} onClick={()=>action(`${provider.provider}/connect`)}>{provider.status==='connected'?'Reconnect':'Connect'} {LABELS[provider.provider]}</Button>
          <Button disabled={busy||!provider.setupComplete||provider.status!=='connected'} onClick={()=>action(`${provider.provider}/test`)}>Test connection</Button>
          <Button disabled={busy||!provider.setupComplete||provider.status!=='connected'||provider.active||!!provider.last_error} onClick={()=>action('active',{provider:provider.provider,revision:data.revision})}>Use {LABELS[provider.provider]} for new files</Button>
          <Button disabled={busy||!provider.setupComplete||provider.status==='disconnected'||provider.active||provider.dependent_files>0} onClick={()=>action(`${provider.provider}/disconnect`,{revision:provider.revision})}>{provider.status==='disconnecting'?'Retry disconnect':'Disconnect'}</Button>
          {provider.cleanup_pending>0&&<><p>{provider.cleanup_pending} failed uploads await cleanup. Only unreferenced failed files older than one hour are eligible.</p><Button disabled={busy||!provider.setupComplete} onClick={()=>action(`${provider.provider}/cleanup`)}>Retry failed-file cleanup</Button></>}
        </div>}
      </section>)}</div>
    </>}
  </section>;
}
