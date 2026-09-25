export const AREAS = [
  { id: 'organization', label: 'Organization', permissions: ['departments.manage', 'positions.manage'] },
  { id: 'users', label: 'Users & Access', permissions: ['users.view'] },
  { id: 'permissions', label: 'Permission Catalog', permissions: ['cms.permissions.view', 'cms.permissions.manage'] },
  { id: 'workforce', label: 'Workforce Configuration', permissions: ['workforce.configuration.manage', 'employment_types.manage', 'rotation.manage', 'leave.manage'] },
  { id: 'branding', label: 'Branding', permissions: ['cms.branding.manage'] },
  { id: 'content', label: 'Application Content', permissions: ['cms.content.manage'] },
  { id: 'integrations', label: 'Integrations', permissions: ['cms.integrations.view','cms.integrations.manage'] },
  { id: 'audit', label: 'Audit Center', permissions: ['cms.audit.view'] },
  { id: 'system', label: 'System', permissions: ['cms.system.view'] },
];
export const SETTINGS = Object.freeze({
  'company.display_name': { category:'branding', label:'Company display name', description:'Public company name on the sign-in screen. Does not change issued documents.', max:150, min:1 },
  'company.short_name': { category:'branding', label:'Company short name', description:'Public company name on small screens.', max:60, min:1 },
  'company.contact_details': { category:'branding', label:'Company contact details', description:'Public contact line printed under the company name on newly generated documents. Issued documents keep the details they were issued with.', max:500, min:0 },
  'document.company_name': { category:'branding', label:'Document issuer name', description:'Company name printed on newly generated business documents (Gate Pass, IPO, Delivery Challan, Demand List). Issued documents keep the name they were issued with.', max:150, min:1 },
  // Written only by the logo endpoints; its stored value is never returned to clients.
  'company.logo': { category:'branding', label:'Company logo', description:'Logo printed on newly generated documents and shown on the sign-in screen. PNG or JPEG, up to 2 MB. Issued documents keep the logo they were issued with.', managed:true },
  'company.app_icon': { category:'branding', label:'Application icon', description:'Square icon for the favicon and future PWA installs. PNG or JPEG, 512–4096 px on each side, up to 2 MB. Installed devices may retain a cached icon.', managed:true },
  'login.heading': { category:'content', label:'Sign-in heading', description:'Public heading on the sign-in form.', max:100, min:1 },
  'login.help': { category:'content', label:'Sign-in help', description:'Public explanatory text below the sign-in heading.', max:500, min:0 },
  'dashboard.announcement': { category:'content', label:'Dashboard announcement', description:'Public company announcement displayed in the authenticated application. Do not enter confidential information.', max:1000, min:0 },
  'support.help': { category:'content', label:'Support information', description:'Public support instructions displayed in the application.', max:500, min:0 },
});
