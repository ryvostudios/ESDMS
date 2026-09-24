export const shorthands = undefined;

// Document branding, inside the existing allowlisted cms_settings model.
//
//   document.company_name  issuer name printed on newly generated documents
//                          (previously the hard-coded COMPANY.name).
//   company.logo           managed by the logo endpoints only, never by the
//                          generic setting PATCH. '' means "use the bundled
//                          real E-Set logo"; otherwise a server-written JSON
//                          reference to bytes held by the existing storage
//                          service. Never returned to clients as-is.
//
// Only the allowlist grows: the plain-text CHECK (no '<' / '>', <= 1000
// chars) and revision CHECK stay exactly as they are, so the logo value
// can never carry markup either.
const OLD_ALLOWLIST = `
  (category='branding' AND key IN ('company.display_name','company.short_name','company.contact_details')) OR
  (category='content' AND key IN ('login.heading','login.help','dashboard.announcement','support.help'))`;
const NEW_ALLOWLIST = `
  (category='branding' AND key IN ('company.display_name','company.short_name','company.contact_details',
    'document.company_name','company.logo')) OR
  (category='content' AND key IN ('login.heading','login.help','dashboard.announcement','support.help'))`;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE cms_settings DROP CONSTRAINT cms_settings_allowlist;
    ALTER TABLE cms_settings ADD CONSTRAINT cms_settings_allowlist CHECK (${NEW_ALLOWLIST});
    INSERT INTO cms_settings(key,category,value) VALUES
      ('document.company_name','branding','E-Set Engineering Services'),
      ('company.logo','branding','')
    ON CONFLICT (key) DO NOTHING;
  `);
}

// Branding choices and their audit trail are configuration history; like the
// CMS foundation this is forward-only rather than silently discarding them.
export async function down() {
  throw new Error(`Document branding is forward-only; preserve configuration. Previous allowlist: ${OLD_ALLOWLIST.trim()}`);
}
