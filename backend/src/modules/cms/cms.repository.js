import pool from '../../config/database.js';
export async function settings(executor = pool) { return (await executor.query('SELECT key,category,value,revision,updated_at FROM cms_settings ORDER BY category,key')).rows; }
export async function permissions(executor = pool) { return (await executor.query('SELECT code,display_name,description,category,help_text FROM permissions ORDER BY category,display_name,code')).rows; }
export async function sites(scope) { return (await pool.query('SELECT id,code,name,is_active FROM sites WHERE ($1::uuid IS NULL OR id=$1) ORDER BY name,id',[scope])).rows; }
export async function audit({ scope, query, ceo }) {
  // Never SELECT raw audit metadata. Historical rows without a captured site
  // remain CEO-only: current employee/user sites cannot prove historical scope.
  const result = await pool.query(`SELECT a.id,a.action,a.created_at,a.scope_site_id,
      a.actor_user_id,u.full_name AS actor_name,a.target_user_id,a.target_employee_id,
      CASE WHEN a.action='CONFIGURATION_CHANGED' THEN a.metadata->>'targetId' END AS configuration_target_id,
      CASE WHEN a.action='CMS_SETTING_CHANGED' THEN a.metadata->>'key'
           WHEN a.action='PERMISSION_METADATA_CHANGED' THEN a.metadata->>'code'
           WHEN a.action='CONFIGURATION_CHANGED' THEN a.metadata->>'table' END AS configuration_key,
      CASE WHEN a.action='CMS_SETTING_CHANGED' THEN jsonb_build_object('before',a.metadata->'before','after',a.metadata->'after') END AS change
    FROM governance_audit_log a JOIN users u ON u.id=a.actor_user_id
    WHERE ($1::boolean OR a.scope_site_id=$2)
      AND ($3::uuid IS NULL OR a.scope_site_id=$3)
      AND ($4::text IS NULL OR a.action=$4) AND ($5::uuid IS NULL OR a.actor_user_id=$5)
      AND ($6::timestamptz IS NULL OR a.created_at >= $6) AND ($7::timestamptz IS NULL OR a.created_at <= $7)
      AND ($1::boolean OR a.action IN ('USER_CREATED','USER_ROLE_CHANGED','USER_ACTIVATED','USER_DEACTIVATED','PERMISSION_GRANTED','PERMISSION_DENIED','PERMISSION_OVERRIDE_REMOVED','EMPLOYEE_CREATED','EMPLOYEE_TRANSFERRED','EMPLOYEE_EXISTING_USER_LINKED','USER_TEMP_PASSWORD_REGENERATED','CAPABILITY_BUNDLE_ASSIGNED','CAPABILITY_BUNDLE_REMOVED','PRIVILEGE_ESCALATION_ATTEMPT','CONFIGURATION_CHANGED'))
    ORDER BY a.created_at DESC,a.id DESC LIMIT $8 OFFSET $9`,
    [ceo,scope,query.siteId||null,query.action||null,query.actorId||null,query.from||null,query.to||null,query.pageSize+1,(query.page-1)*query.pageSize]);
  return {items:result.rows.slice(0,query.pageSize),hasMore:result.rows.length>query.pageSize,page:query.page};
}
