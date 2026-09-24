export const shorthands = undefined;

// Add only the confirmed company's reference data at the existing MAIN site.
// Preserve historical/demo departments, existing spellings, inactive entries,
// employees and user authority. Other sites remain independently configured.
export async function up(pgm) {
  pgm.sql(`
    INSERT INTO departments (site_id, name)
    SELECT s.id, d.name FROM sites s
    CROSS JOIN (VALUES ('Administration'), ('Civil'), ('WTG'), ('HSE'), ('Procurement'), ('HR')) d(name)
    WHERE s.code = 'MAIN'
      AND NOT EXISTS (SELECT 1 FROM departments existing
        WHERE existing.site_id = s.id AND lower(existing.name) = lower(d.name));

    INSERT INTO positions (site_id, department_id, code, name, description)
    SELECT s.id, d.id, p.code, p.name,
      'Organizational position only. Application access is assigned separately through Governance.'
    FROM sites s
    CROSS JOIN (VALUES
      ('Administration', 'ADMINISTRATION_TL', 'Administration Team Lead'),
      ('Administration', 'ASSISTANT_ADMIN', 'Assistant Admin'),
      ('Administration', 'COOK', 'Cook'),
      ('Administration', 'JANITOR', 'Janitor'),
      ('Administration', 'DRIVER', 'Driver'),
      ('Civil', 'CIVIL_TL', 'Civil Team Lead'),
      ('Civil', 'CIVIL_WORKER', 'Civil Worker'),
      ('WTG', 'WTG_TL', 'WTG Team Lead'),
      ('WTG', 'WTG_ASSISTANT_TL', 'Assistant WTG Team Lead'),
      ('WTG', 'WTG_TECHNICIAN', 'WTG Technician'),
      ('HSE', 'HSE_TL', 'HSE Team Lead / Health & Safety Officer'),
      ('HSE', 'PARAMEDIC', 'Paramedic'),
      ('Procurement', 'PROCUREMENT_STAFF', 'Procurement Staff'),
      ('HR', 'HR_STAFF', 'HR Staff'),
      (NULL, 'SITE_MANAGER', 'Site Manager'),
      (NULL, 'CFO', 'CFO'),
      (NULL, 'CTO', 'CTO')
    ) p(department, code, name)
    LEFT JOIN departments d ON d.site_id = s.id AND lower(d.name) = lower(p.department)
    WHERE s.code = 'MAIN' AND (p.department IS NULL OR d.id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM positions existing WHERE existing.site_id = s.id
        AND (lower(existing.code) = lower(p.code) OR lower(existing.name) = lower(p.name)))
    ON CONFLICT DO NOTHING;
  `);
}

// Reference rows can acquire historical relationships immediately. Rollback
// deliberately retains them; removing company records is an audited archive
// operation, never an automatic destructive migration rollback.
export async function down() {}
