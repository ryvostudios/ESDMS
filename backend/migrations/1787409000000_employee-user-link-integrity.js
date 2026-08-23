export async function up(pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      -- Refuse migration if existing data would violate one User -> one Employee.
      IF EXISTS (
        SELECT user_id
        FROM public.employees
        WHERE user_id IS NOT NULL
        GROUP BY user_id
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION
          'Cannot enforce Employee/User one-to-one link: duplicate employees.user_id values exist';
      END IF;

      -- Refuse migration if an Employee points at a nonexistent User.
      IF EXISTS (
        SELECT 1
        FROM public.employees e
        LEFT JOIN public.users u ON u.id = e.user_id
        WHERE e.user_id IS NOT NULL
          AND u.id IS NULL
      ) THEN
        RAISE EXCEPTION
          'Cannot enforce Employee/User foreign key: orphaned employees.user_id values exist';
      END IF;

      -- Some environments already have the UNIQUE relationship from the
      -- original Workforce migration. Add our repair index only when no
      -- equivalent unique index exists.
      IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a
          ON a.attrelid = t.oid
         AND a.attname = 'user_id'
        WHERE n.nspname = 'public'
          AND t.relname = 'employees'
          AND i.indisunique
          AND i.indnatts = 1
          AND a.attnum = ANY(i.indkey::smallint[])
      ) THEN
        CREATE UNIQUE INDEX employees_user_id_link_unique_idx
          ON public.employees (user_id)
          WHERE user_id IS NOT NULL;
      END IF;

      -- Restore the intended User FK when it is missing.
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attname = 'user_id'
        WHERE c.conrelid = 'public.employees'::regclass
          AND c.contype = 'f'
          AND c.confrelid = 'public.users'::regclass
          AND a.attnum = ANY(c.conkey)
      ) THEN
        ALTER TABLE public.employees
          ADD CONSTRAINT employees_user_id_link_fkey
          FOREIGN KEY (user_id)
          REFERENCES public.users(id)
          ON DELETE SET NULL;
      END IF;
    END
    $$;

    ALTER TABLE public.governance_audit_log
      DROP CONSTRAINT governance_audit_log_action_check;

    ALTER TABLE public.governance_audit_log
      ADD CONSTRAINT governance_audit_log_action_check
      CHECK (action IN (
        'USER_CREATED',
        'USER_ROLE_CHANGED',
        'USER_ACTIVATED',
        'USER_DEACTIVATED',
        'PERMISSION_GRANTED',
        'PERMISSION_DENIED',
        'PERMISSION_OVERRIDE_REMOVED',
        'PRIVILEGE_ESCALATION_ATTEMPT',
        'EMPLOYEE_CREATED',
        'EMPLOYEE_TRANSFERRED',
        'COMPENSATION_RECORDED',
        'CONTRACT_FINALIZED',
        'CONTRACT_AMENDED',
        'CONTRACT_VIEWED',
        'CONTRACT_DOWNLOADED',
        'HISTORY_REMOVED',
        'WORKFORCE_EXPORT_GENERATED',
        'WORKFORCE_BULK_EXPORT_GENERATED',
        'WORKFORCE_BULK_IMPORT_COMPLETED',
        'EMPLOYEE_EXISTING_USER_LINKED'
      ));

    INSERT INTO public.permissions (code, description)
    VALUES (
      'employees.account.link_existing',
      'Link an existing non-CEO User account to an Employee record without changing the account role or credentials'
    )
    ON CONFLICT (code)
    DO UPDATE SET description = EXCLUDED.description;

    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id
    FROM public.roles r
    JOIN public.permissions p
      ON p.code = 'employees.account.link_existing'
    WHERE r.name = 'CEO'
    ON CONFLICT DO NOTHING;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public.user_permission_overrides o
        JOIN public.permissions p ON p.id = o.permission_id
        WHERE p.code = 'employees.account.link_existing'
      ) THEN
        RAISE EXCEPTION
          'Cannot remove employees.account.link_existing while user overrides exist';
      END IF;
    END
    $$;

    DELETE FROM public.role_permissions
    WHERE permission_id = (
      SELECT id
      FROM public.permissions
      WHERE code = 'employees.account.link_existing'
    );

    DELETE FROM public.permissions
    WHERE code = 'employees.account.link_existing';

    -- Only remove repair objects created by THIS migration. Never remove
    -- foundational constraints that may already have existed.
    ALTER TABLE public.employees
      DROP CONSTRAINT IF EXISTS employees_user_id_link_fkey;

    DROP INDEX IF EXISTS public.employees_user_id_link_unique_idx;
  `);
}
