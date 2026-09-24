export const AREAS = [
  { id: 'organization', label: 'Organization', permissions: ['departments.manage', 'positions.manage'] },
  { id: 'users', label: 'Users & Access', permissions: ['users.view'] },
  { id: 'permissions', label: 'Permission Catalog', permissions: ['cms.permissions.view', 'cms.permissions.manage'] },
  { id: 'workforce', label: 'Workforce Configuration', permissions: ['workforce.configuration.manage', 'employment_types.manage', 'rotation.manage', 'leave.manage'] },
  { id: 'branding', label: 'Branding', permissions: ['cms.branding.manage'] },
  { id: 'content', label: 'Application Content', permissions: ['cms.content.manage'] },
  { id: 'integrations', label: 'Integrations', permissions: ['cms.integrations.view'] },
  { id: 'audit', label: 'Audit Center', permissions: ['cms.audit.view'] },
  { id: 'system', label: 'System', permissions: ['cms.system.view'] },
];
export const SETTINGS = Object.freeze({
  'company.display_name': { category:'branding', label:'Company display name', description:'Public company name on the sign-in screen. Does not change issued documents.', max:150, min:1 },
  'company.short_name': { category:'branding', label:'Company short name', description:'Public company name on small screens.', max:60, min:1 },
  'company.contact_details': { category:'branding', label:'Company contact details', description:'Public contact information. Reserved for future versioned document branding.', max:500, min:0 },
  'login.heading': { category:'content', label:'Sign-in heading', description:'Public heading on the sign-in form.', max:100, min:1 },
  'login.help': { category:'content', label:'Sign-in help', description:'Public explanatory text below the sign-in heading.', max:500, min:0 },
  'dashboard.announcement': { category:'content', label:'Dashboard announcement', description:'Public company announcement displayed in the authenticated application. Do not enter confidential information.', max:1000, min:0 },
  'support.help': { category:'content', label:'Support information', description:'Public support instructions displayed in the application.', max:500, min:0 },
});
