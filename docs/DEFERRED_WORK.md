# Deferred work

Planned after handover. None of these are current handover blockers; the
application works without them.

1. **WhatsApp production integration.** Meta WhatsApp Cloud API, approved
   message templates and webhooks. The outbox and a simulated provider exist;
   production delivery is not enabled.
2. **Attendance (ZKTeco K-50) integration.** Connect the local attendance
   device through a secure outbound/local-agent design. Not implemented.
3. **Google Drive live verification.** The provider is implemented but has not
   been verified against a live company Google account; Dropbox is the
   live-tested external provider.
4. **Digital Permit System shared infrastructure.** The Permit System is a
   separate application. Any shared PostgreSQL/Supabase arrangement needs its
   own design (separate schemas, runtime roles and migration identities).
5. **Product decisions noted in manual QA** (current behaviour is intended;
   revisit only if the company wants a change):
   - CEO has no Gate Pass view by default; grant `gate_pass.view_site` /
     `gate_pass.view_history` if management visibility is wanted
     ([GATE_PASS_SPEC.md](./GATE_PASS_SPEC.md)).
   - The completion PDF is issued once at completion; additional inbound
     evidence added later appears on the Gate Pass page, not in that PDF.
   - The pricing screen's "previous actual price" uses only IPOs whose
     purchasing has been closed.
   - Site-wide reviewers and Procurement can read (not edit) draft Demands at
     their site.
