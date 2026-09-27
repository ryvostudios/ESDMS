export const shorthands = undefined;

// A separate managed square icon keeps installation artwork independent of
// the document/logo setting. Existing issued document branding is untouched.
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE cms_settings DROP CONSTRAINT cms_settings_allowlist;
    ALTER TABLE cms_settings ADD CONSTRAINT cms_settings_allowlist CHECK (
      (category='branding' AND key IN ('company.display_name','company.short_name','company.contact_details',
        'document.company_name','company.logo','company.app_icon')) OR
      (category='content' AND key IN ('login.heading','login.help','dashboard.announcement','support.help')));
    INSERT INTO cms_settings(key,category,value) VALUES ('company.app_icon','branding','')
      ON CONFLICT (key) DO NOTHING;
  `);
}

export async function down() {
  throw new Error('CMS web/PWA branding is forward-only; preserve published artwork and audit history.');
}
