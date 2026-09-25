import { useEffect, useState } from 'react';
import { apiClient } from '../../core/api/client.js';

// The active company logo as an object URL. Fetched (not <img src>) so the API
// keeps its same-origin resource policy. `version` refetches after a change.
// A missing or unavailable logo yields null: callers show text identity only.
export function useCompanyLogo(version = 0, path = '/cms/branding/logo') {
  const [url,setUrl] = useState(null);
  useEffect(()=>{
    let active = true, objectUrl = null;
    Promise.resolve().then(()=>apiClient.getBlob(path)).then(blob=>{
      if (!active || !['image/png','image/jpeg'].includes(blob.type)) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(()=>{ if (active) setUrl(null); });
    return ()=>{ active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  },[version,path]);
  return url;
}
