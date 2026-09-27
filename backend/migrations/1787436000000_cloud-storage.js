export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE cloud_storage_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL UNIQUE CHECK (provider IN ('dropbox','google_drive')),
      status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected','disconnecting','error')),
      account_id text, account_label text, credentials text,
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      token_revision integer NOT NULL DEFAULT 1,
      last_success_at timestamptz, last_test_at timestamptz, last_error text CHECK (last_error IN ('provider_unavailable','configuration_error')),
      updated_by_user_id uuid REFERENCES users ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO cloud_storage_connections(provider) VALUES ('dropbox'),('google_drive');
    CREATE TABLE cloud_storage_active (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      connection_id uuid REFERENCES cloud_storage_connections ON DELETE RESTRICT,
      revision integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO cloud_storage_active(singleton) VALUES (true);
    CREATE TABLE cloud_storage_oauth_states (
      state_hash text PRIMARY KEY, provider text NOT NULL CHECK (provider IN ('dropbox','google_drive')),
      actor_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
      session_hash text NOT NULL, verifier text NOT NULL, redirect_uri text NOT NULL,
      connection_revision integer NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX cloud_storage_oauth_expiry ON cloud_storage_oauth_states(expires_at);
    CREATE TABLE cloud_storage_objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id uuid NOT NULL REFERENCES cloud_storage_connections ON DELETE RESTRICT,
      account_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('file','folder')),
      logical_path text NOT NULL, provider_id text,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','cleanup_pending','deleted')),
      size_bytes bigint, checksum_sha256 text, mime_type text,
      site_id uuid REFERENCES sites ON DELETE RESTRICT,
      entity_id text, namespace text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(connection_id,account_id,logical_path)
    );
    CREATE INDEX cloud_storage_objects_connection_state ON cloud_storage_objects(connection_id,state);
    ALTER TABLE cloud_storage_connections ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cloud_storage_active ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cloud_storage_oauth_states ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cloud_storage_objects ENABLE ROW LEVEL SECURITY;
    INSERT INTO permissions(code,description,display_name,category,help_text)
      VALUES ('cms.integrations.manage','Manage company-wide cloud storage connections and the provider for future files.','Manage Cloud Storage','System Administration','Company-wide; CEO-delegated. Does not grant access to business files.');
    INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='CEO' AND p.code='cms.integrations.manage';
    DO $$ DECLARE old_check text; BEGIN
      SELECT pg_get_constraintdef(oid) INTO old_check FROM pg_constraint WHERE conrelid='governance_audit_log'::regclass AND conname='governance_audit_log_action_check';
      ALTER TABLE governance_audit_log DROP CONSTRAINT governance_audit_log_action_check;
      EXECUTE 'ALTER TABLE governance_audit_log ADD CONSTRAINT governance_audit_log_action_check CHECK (' || substring(old_check from 7) || ' OR action=''CLOUD_STORAGE_CHANGED'')';
    END $$;
    CREATE OR REPLACE FUNCTION cms_audit_scope_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action IN ('CMS_SETTING_CHANGED','PERMISSION_METADATA_CHANGED','CLOUD_STORAGE_CHANGED') THEN NEW.scope_site_id := NULL;
      ELSIF NEW.action='CONFIGURATION_CHANGED' THEN NEW.scope_site_id := (NEW.metadata->>'siteId')::uuid;
      ELSE NEW.scope_site_id := COALESCE(
        (SELECT site_id FROM users WHERE id=NEW.target_user_id),
        (SELECT primary_site_id FROM employees WHERE id=NEW.target_employee_id),
        (SELECT site_id FROM users WHERE id=NEW.actor_user_id));
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION cms_audit_scope_snapshot() FROM PUBLIC;
  `);
}
export async function down() { throw new Error('Cloud storage is forward-only: preserve connection and historical file references.'); }
