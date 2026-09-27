import { useEffect, useState } from 'react';
import { apiClient } from '../../core/api/client.js';
const DEFAULTS = {
  'company.display_name':'E-Set Digital Management System','company.short_name':'E-Set DMS',
  'login.heading':'Sign in','login.help':'Use your E-Set account to continue.',
  'dashboard.announcement':'','support.help':'',
};
export function usePublicContent() {
  const [content,setContent] = useState(DEFAULTS);
  useEffect(()=>{
    let active=true;
    apiClient.get('/cms/public-content',{suppressUnauthorizedHandling:true}).then(response=>{
      if (active) setContent({...DEFAULTS,...response.data});
    }).catch(()=>{}); // Optional display text must not block authentication.
    return ()=>{active=false;};
  },[]);
  return content;
}
