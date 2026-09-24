export const shorthands = undefined;
const capabilities = [
  ['cms.permissions.view', 'View Permission Catalog', 'Read human-readable permission metadata; grants no operational authority.'],
  ['cms.permissions.manage', 'Edit Permission Descriptions', 'Edit company-wide permission labels and help text, never enforcement codes.'],
  ['cms.branding.manage', 'Manage Company Branding', 'Manage company-wide display branding; does not alter issued documents.'],
  ['cms.content.manage', 'Manage Application Content', 'Manage allowlisted company-wide public application text.'],
  ['cms.integrations.view', 'View Integration Status', 'View safe integration configuration status; no credentials or connection controls.'],
  ['cms.audit.view', 'View Audit Center', 'View safe audit events at the assigned site; CEO can view company-wide events.'],
  ['cms.system.view', 'View System Information', 'View safe revision and database readiness information, never secrets.'],
];
export async function up(pgm) {
  pgm.addColumn('permissions', {
    display_name: { type: 'varchar(150)' }, category: { type: 'varchar(80)' }, help_text: { type: 'varchar(500)', notNull: true, default: '' },
  });
  for (const [code, label, description] of capabilities) {
    pgm.sql(`INSERT INTO permissions(code, description, display_name, category) VALUES ('${code}', '${description}', '${label}', 'System Administration');
      INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='CEO' AND p.code='${code}';`);
  }
  // Existing descriptions already explain the actual permission, including scope.
  // Labels reverse action/module ordering; preserve acronym/domain terminology.
  pgm.sql(`UPDATE permissions SET
    category = COALESCE(category, initcap(replace(split_part(code,'.',1),'_',' '))),
    display_name = COALESCE(display_name,
      initcap(replace(substring(code from position('.' in code)+1),'.',' ')) || ' — ' ||
      CASE split_part(code,'.',1) WHEN 'dc' THEN 'Delivery Challans' WHEN 'ipo' THEN 'IPO'
        WHEN 'employee_documents' THEN 'Employee Documents' WHEN 'permission_overrides' THEN 'User Permissions'
        ELSE initcap(replace(split_part(code,'.',1),'_',' ')) END);
    UPDATE permissions SET display_name = replace(display_name,'_',' ');
  `);
  pgm.alterColumn('permissions','display_name',{notNull:true, default:''});
  pgm.alterColumn('permissions','category',{notNull:true, default:''});
  pgm.createTable('cms_settings', {
    key: { type:'text', primaryKey:true }, category: { type:'text', notNull:true },
    value: { type:'text', notNull:true }, revision: {type:'integer', notNull:true, default:1},
    updated_at:{type:'timestamptz',notNull:true,default:pgm.func('CURRENT_TIMESTAMP')},
    updated_by_user_id:{type:'uuid',references:'users',onDelete:'RESTRICT'},
  });
  pgm.sql(`INSERT INTO cms_settings(key,category,value) VALUES
    ('company.display_name','branding','E-Set Digital Management System'),
    ('company.short_name','branding','E-Set DMS'),
    ('company.contact_details','branding',''),
    ('login.heading','content','Sign in'),
    ('login.help','content','Use your E-Set account to continue.'),
    ('dashboard.announcement','content',''),
    ('support.help','content','');
    ALTER TABLE cms_settings ADD CONSTRAINT cms_settings_allowlist CHECK (
      (category='branding' AND key IN ('company.display_name','company.short_name','company.contact_details')) OR
      (category='content' AND key IN ('login.heading','login.help','dashboard.announcement','support.help')));
    ALTER TABLE cms_settings ADD CONSTRAINT cms_settings_plain_text CHECK (length(value)<=1000 AND value !~ '[<>]');
    ALTER TABLE cms_settings ADD CONSTRAINT cms_settings_revision_positive CHECK (revision>0);
    ALTER TABLE cms_settings ENABLE ROW LEVEL SECURITY;
  `);
  // Extend the existing action constraint without restating or dropping any old action.
  pgm.sql(`DO $$ DECLARE old_check text; BEGIN
    SELECT pg_get_constraintdef(oid) INTO old_check FROM pg_constraint WHERE conrelid='governance_audit_log'::regclass AND conname='governance_audit_log_action_check';
    ALTER TABLE governance_audit_log DROP CONSTRAINT governance_audit_log_action_check;
    EXECUTE 'ALTER TABLE governance_audit_log ADD CONSTRAINT governance_audit_log_action_check CHECK (' ||
      substring(old_check from 7) || ' OR action IN (''CMS_SETTING_CHANGED'',''PERMISSION_METADATA_CHANGED'',''CONFIGURATION_CHANGED''))';
  END $$;`);
  pgm.addColumn('governance_audit_log', {scope_site_id:{type:'uuid', references:'sites',onDelete:'RESTRICT'}});
  pgm.sql(`CREATE FUNCTION cms_audit_scope_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action IN ('CMS_SETTING_CHANGED','PERMISSION_METADATA_CHANGED') THEN NEW.scope_site_id := NULL;
    ELSIF NEW.action='CONFIGURATION_CHANGED' THEN NEW.scope_site_id := (NEW.metadata->>'siteId')::uuid;
    ELSE
      NEW.scope_site_id := COALESCE(
        (SELECT site_id FROM users WHERE id=NEW.target_user_id),
        (SELECT primary_site_id FROM employees WHERE id=NEW.target_employee_id),
        (SELECT site_id FROM users WHERE id=NEW.actor_user_id));
    END IF;
    RETURN NEW;
  END $$;
  REVOKE ALL ON FUNCTION cms_audit_scope_snapshot() FROM PUBLIC;
  CREATE TRIGGER governance_audit_scope_snapshot BEFORE INSERT ON governance_audit_log
    FOR EACH ROW EXECUTE FUNCTION cms_audit_scope_snapshot();`);
  pgm.createIndex('governance_audit_log',['scope_site_id','created_at','id']);
}
// Audit and published configuration must not be silently destroyed by rollback.
export async function down() { throw new Error('CMS foundation is forward-only; preserve configuration and audit history.'); }
