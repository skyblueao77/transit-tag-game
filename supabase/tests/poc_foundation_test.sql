-- PoC foundation validation specification; no pgTAP extension is assumed.
--
-- The executable block below is read-only and rolls back its transaction. It
-- checks migration/catalog invariants only. Authenticated behavior tests must be
-- run separately against a disposable Hosted PoC project using ephemeral Auth
-- identities and the public client API; do not run them with service_role.
-- Do not paste credentials, JWTs, or real user data into this file.

BEGIN;

DO $catalog_assertions$
DECLARE
  v_table_name text;
  v_rls_enabled boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_helper_is_definer boolean;
  v_helper_has_safe_search_path boolean;
  v_rpc_count integer;
  v_safe_rpc_count integer;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'poc_schema_versions',
    'poc_sessions',
    'poc_session_memberships'
  ] LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table_name)) IS NULL THEN
      RAISE EXCEPTION 'Required PoC table is missing.';
    END IF;

    SELECT relation.relrowsecurity, relation.relforcerowsecurity
      INTO v_rls_enabled, v_force_rls
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table_name));

    IF NOT v_rls_enabled OR NOT v_force_rls THEN
      RAISE EXCEPTION 'RLS is not enabled and forced for a PoC table.';
    END IF;
  END LOOP;

  SELECT pg_catalog.count(*)
    INTO v_policy_count
  FROM pg_catalog.pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND policy.tablename IN ('poc_sessions', 'poc_session_memberships')
    AND policy.cmd = 'SELECT'
    AND 'authenticated' = ANY (policy.roles);
  IF v_policy_count <> 2 THEN
    RAISE EXCEPTION 'Expected member-scoped SELECT policies are missing.';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'public.poc_sessions', 'SELECT')
    OR pg_catalog.has_table_privilege('anon', 'public.poc_session_memberships', 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_sessions', 'INSERT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_sessions', 'UPDATE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_sessions', 'DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_session_memberships', 'INSERT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_session_memberships', 'UPDATE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_session_memberships', 'DELETE')
    OR pg_catalog.has_table_privilege('service_role', 'public.poc_sessions', 'SELECT')
    OR pg_catalog.has_table_privilege('service_role', 'public.poc_session_memberships', 'SELECT') THEN
    RAISE EXCEPTION 'A direct table privilege exceeds the PoC grant boundary.';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
      'authenticated', 'public.poc_sessions', 'id', 'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'authenticated', 'public.poc_sessions', 'created_by', 'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'authenticated', 'public.poc_sessions', 'join_code', 'SELECT'
    )
    OR NOT pg_catalog.has_column_privilege(
      'authenticated', 'public.poc_session_memberships', 'display_name', 'SELECT'
    ) THEN
    RAISE EXCEPTION 'Column-level Session or roster grants are incorrect.';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'public.poc_schema_versions', 'SELECT')
    OR pg_catalog.has_table_privilege('anon', 'public.poc_schema_versions', 'INSERT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_schema_versions', 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_schema_versions', 'INSERT')
    OR pg_catalog.has_table_privilege('service_role', 'public.poc_schema_versions', 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_schema_versions', 'UPDATE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.poc_schema_versions', 'DELETE') THEN
    RAISE EXCEPTION 'Schema version table is directly accessible to a client role.';
  END IF;

  SELECT procedure.prosecdef,
         EXISTS (
           SELECT 1
           FROM pg_catalog.unnest(procedure.proconfig) AS setting
           WHERE setting LIKE 'search_path=%'
         )
    INTO v_helper_is_definer, v_helper_has_safe_search_path
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = 'poc_private.is_session_member(uuid)'::pg_catalog.regprocedure;
  IF NOT v_helper_is_definer OR NOT v_helper_has_safe_search_path THEN
    RAISE EXCEPTION 'Membership helper is not SECURITY DEFINER with a fixed search_path.';
  END IF;

  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (
           WHERE procedure.prosecdef
             AND EXISTS (
               SELECT 1
               FROM pg_catalog.unnest(procedure.proconfig) AS setting
               WHERE setting LIKE 'search_path=%'
             )
         )
    INTO v_rpc_count, v_safe_rpc_count
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid IN (
    'public.poc_create_session(uuid,text,text)'::pg_catalog.regprocedure,
    'public.poc_join_session(text,text)'::pg_catalog.regprocedure
  );
  IF v_rpc_count <> 2 OR v_safe_rpc_count <> 2 THEN
    RAISE EXCEPTION 'Trusted RPCs are missing SECURITY DEFINER or fixed search_path.';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'authenticated', 'public.poc_create_session(uuid,text,text)', 'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'authenticated', 'public.poc_join_session(text,text)', 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon', 'public.poc_create_session(uuid,text,text)', 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon', 'public.poc_join_session(text,text)', 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role', 'public.poc_create_session(uuid,text,text)', 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role', 'public.poc_join_session(text,text)', 'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Trusted RPC execution grants are incorrect.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.poc_schema_versions AS version_row
    WHERE version_row.version = 1
      AND version_row.migration_name = '20261016131045_create_poc_foundation.sql'
  ) THEN
    RAISE EXCEPTION 'PoC schema version marker is missing.';
  END IF;
END;
$catalog_assertions$;

ROLLBACK;

-- Authenticated API validation matrix (manual; disposable project and fictional data only):
--
-- Positive:
-- 1. User A calls poc_create_session with a fresh request UUID; exactly one
--    Session and one Admin membership exist, and the returned code is 32 hex chars.
-- 2. Repeating the same request and payload returns the same Session/code with
--    duplicate=true; reusing the request UUID with different input is rejected.
-- 3. User B joins with the valid code; the only new role is participant.
-- 4. User A and User B can SELECT the allowed roster for their Session.
-- 5. A newly created User C can create a distinct Session and read only its roster.
--
-- Negative:
-- 6. No JWT: both trusted RPCs reject; anon cannot read or mutate any PoC table.
-- 7. An authenticated client cannot INSERT/UPDATE/DELETE Sessions or memberships,
--    including setting created_by, user_id, or membership_role to admin.
-- 8. User A cannot read User C's Session or roster, even with its UUID; denied
--    reads must not reveal whether the target Session exists.
-- 9. Invalid/unknown join code and inactive Session are rejected without a row.
-- 10. Rejoining as User B is a safe no-op; membership count and role are unchanged.
-- 11. Client roles cannot read or mutate poc_schema_versions.
-- 12. Blank, whitespace-only, or overlong Session/display names are rejected.
-- 13. Capture a Realtime subscription as User A and prove User C's membership
--     INSERT is not delivered; repeat for initial snapshot and event delivery.
--
-- Realtime is not published by this migration. Enable only the PoC membership
-- table during a separate controlled validation after reviewing the project's
-- publication state. Run runtime tests with fictional identities only, then
-- delete all fixtures and verify cleanup. Do not run destructive tests against
-- any production or staging project.
