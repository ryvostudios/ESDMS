import { useState } from 'react';

// The company logo as-is (no tile behind it, so a transparent PNG stays
// transparent), or the styled "ES" text mark when no logo is available or
// the image fails to decode. Branding can never block the surface it is on.
export function CompanyMark({ logoUrl, logoClassName, fallbackClassName, alt = '', fallback = 'ES' }) {
  const [failedUrl, setFailedUrl] = useState(null);
  if (logoUrl && failedUrl !== logoUrl) {
    return <img className={logoClassName} src={logoUrl} alt={alt} onError={() => setFailedUrl(logoUrl)} />;
  }
  if (fallback === null) return null;
  return <span className={fallbackClassName} aria-hidden="true">{fallback}</span>;
}
