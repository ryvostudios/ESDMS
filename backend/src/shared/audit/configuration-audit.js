import { withTransaction } from '../db/with-transaction.js';
import { recordGovernanceAudit } from './governance-audit.repository.js';

// Only reference configuration, never employee values or integration secrets.
const TABLES = new Set(['departments','positions','employment_types','employee_profile_sections',
  'employee_custom_fields','employee_document_types','rotation_policies','leave_types']);
const SAFE_FIELDS = ['id','name','code','label','field_key','field_type','is_active','site_id',
  'department_id','section_id','is_required','employee_can_view','employee_can_edit',
  'hr_can_view','hr_can_edit','management_can_view','is_sensitive','is_searchable',
  'is_filterable','is_reportable','counts_toward_completion','sort_order','work_days','off_days',
  'employee_can_upload','hr_can_upload','expiry_required','verification_required'];
const project = row => row ? Object.fromEntries(SAFE_FIELDS.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]])) : null;

export async function mutateConfiguration(actor, table, id, mutate) {
  if (!TABLES.has(table) || !actor?.id) throw new Error('Invalid configuration audit context.');
  return withTransaction(async client => {
    const before = id ? (await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[id])).rows[0] : null;
    const result = await mutate(client);
    if (!result) return result;
    const after = (await client.query(`SELECT * FROM ${table} WHERE id=$1`,[result.id])).rows[0];
    await recordGovernanceAudit(client,{actorUserId:actor.id,action:'CONFIGURATION_CHANGED',metadata:{
      table, targetId:result.id, siteId:after.site_id ?? null, operation:id?'update':'create',
      before:project(before),after:project(after),
    }});
    return result;
  });
}
