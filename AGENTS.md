# Database routing for ChatGPT and coding agents

**Repository:** `marcusdhaynes/Minternet`
**Online PostgreSQL:** Existing Supabase project `tbrqqjrzknhdnwcpkqro` (Somniel Holdings LLC)
**Only this app's schema:** `app_minternet`
**App-scoped database role:** `app_minternet_executor` (NOLOGIN until an authenticated backend gateway is configured).

When the user says "add this to the database", "update the database", or similar while working on this repository, interpret it as a request for `app_minternet`, never another app's schema or `public`. Verify the registry row before any SQL:
```sql
SELECT repository, schema_name, project_ref
FROM app_directory.app_routes
WHERE repository = 'Minternet';
```
Use the connected Supabase tool for database edits and schema-qualified SQL such as `app_minternet.new_table`. If the app identity cannot be established reliably, clarify instead of guessing.

Security: new application schemas are private and not Data API-exposed; do not grant `anon`, `authenticated`, or `service_role` broad access simply to make a call succeed. For app features, design proper identity, RLS and a least-privileged backend before exposing data. Keep app data logically separate; all apps share the same PostgreSQL project and resources.

Database schema provisioning is NOT the same as migrating existing Firebase, SQLite, JSON, remote service, or local app data. Do not delete existing data or switch production until backed up, imported, verified, and tested. Never commit credentials. Do not create another paid Supabase project.

Note: The existing `supabase/migrations` scripts have project-specific Supabase Auth and Realtime dependencies and are NOT yet applied to this schema; migration is separately required.

Canonical route directory: private `marcusdhaynes/somniel-holdings` repository, `database-routing.json`, and PostgreSQL table `app_directory.app_routes`.
