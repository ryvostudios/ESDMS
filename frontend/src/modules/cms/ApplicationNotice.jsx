import { usePublicContent } from './public-content.js';
export function ApplicationNotice() {
  const content=usePublicContent();
  return <>{content['dashboard.announcement'] && <aside aria-label="Company announcement"><p>{content['dashboard.announcement']}</p></aside>}{content['support.help'] && <p>{content['support.help']}</p>}</>;
}
