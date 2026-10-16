-- Isolated Transit Tag Game PoC foundation.
-- This migration is not the production schema and is not used by the Firebase app.
-- It intentionally creates no seed users, game data, or location data.

CREATE SCHEMA poc_private;

REVOKE ALL PRIVILEGES ON SCHEMA poc_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA poc_private TO authenticated;

CREATE TABLE public.poc_schema_versions (
  version integer PRIMARY KEY CHECK (version > 0),
  migration_name text NOT NULL UNIQUE CHECK (char_length(migration_name) BETWEEN 1 AND 160),
  applied_at timestamp with time zone NOT NULL DEFAULT pg_catalog.transaction_timestamp()
);

CREATE TABLE public.poc_sessions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  creation_request_id uuid NOT NULL,
  join_code text NOT NULL UNIQUE
    CHECK (join_code ~ '^[0-9a-f]{32}$'),
  session_name text NOT NULL
    CHECK (
      char_length(pg_catalog.btrim(session_name, E' \t\n\r')) BETWEEN 1 AND 80
      AND session_name = pg_catalog.btrim(session_name, E' \t\n\r')
    ),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamp with time zone NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  updated_at timestamp with time zone NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  UNIQUE (created_by, creation_request_id)
);

CREATE TABLE public.poc_session_memberships (
  session_id uuid NOT NULL REFERENCES public.poc_sessions (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text NOT NULL
    CHECK (
      char_length(pg_catalog.btrim(display_name, E' \t\n\r')) BETWEEN 1 AND 80
      AND display_name = pg_catalog.btrim(display_name, E' \t\n\r')
    ),
  membership_role text NOT NULL
    CHECK (membership_role IN ('admin', 'participant')),
  created_at timestamp with time zone NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  PRIMARY KEY (session_id, user_id)
);

ALTER TABLE public.poc_schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poc_schema_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.poc_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poc_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.poc_session_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poc_session_memberships FORCE ROW LEVEL SECURITY;

-- This helper reads membership under its owner, avoiding recursive RLS policy
-- evaluation. It can answer only whether the current Auth identity is a member.
CREATE OR REPLACE FUNCTION poc_private.is_session_member(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.poc_session_memberships AS membership
    WHERE membership.session_id = p_session_id
      AND membership.user_id = (SELECT auth.uid())
  );
$function$;

DROP POLICY IF EXISTS poc_sessions_member_select ON public.poc_sessions;
CREATE POLICY poc_sessions_member_select
  ON public.poc_sessions
  FOR SELECT
  TO authenticated
  USING (poc_private.is_session_member(id));

DROP POLICY IF EXISTS poc_memberships_member_select ON public.poc_session_memberships;
CREATE POLICY poc_memberships_member_select
  ON public.poc_session_memberships
  FOR SELECT
  TO authenticated
  USING (poc_private.is_session_member(session_id));

-- No policies are defined for schema-version writes or table mutations.
-- Column grants omit both the creator identity and bearer join code. UUID keys
-- use no sequences, so this migration grants no sequence privileges.
REVOKE ALL PRIVILEGES ON TABLE public.poc_schema_versions
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.poc_sessions
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.poc_session_memberships
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT (id, session_name, status, created_at, updated_at)
  ON TABLE public.poc_sessions TO authenticated;
GRANT SELECT (session_id, user_id, display_name, membership_role, created_at)
  ON TABLE public.poc_session_memberships TO authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION poc_private.is_session_member(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION poc_private.is_session_member(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.poc_create_session(
  p_request_id uuid,
  p_session_name text,
  p_display_name text
)
RETURNS TABLE (
  session_id uuid,
  session_name text,
  join_code text,
  duplicate boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_session_id uuid;
  v_session_name text := pg_catalog.btrim(p_session_name, E' \t\n\r');
  v_display_name text := pg_catalog.btrim(p_display_name, E' \t\n\r');
  v_join_code text;
  v_existing_session_name text;
  v_existing_display_name text;
  v_existing_role text;
  v_attempt integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '28000';
  END IF;

  IF p_request_id IS NULL
    OR p_session_name IS NULL
    OR char_length(v_session_name) NOT BETWEEN 1 AND 80
    OR p_display_name IS NULL
    OR char_length(v_display_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Invalid PoC Session request.' USING ERRCODE = '22023';
  END IF;

  -- A repeated request by the same creator returns its original result. Reusing
  -- the request ID with a different payload fails closed.
  SELECT session_row.id, session_row.session_name, session_row.join_code
    INTO v_session_id, v_existing_session_name, v_join_code
  FROM public.poc_sessions AS session_row
  WHERE session_row.created_by = v_user_id
    AND session_row.creation_request_id = p_request_id
  FOR UPDATE;

  IF FOUND THEN
    SELECT membership.display_name, membership.membership_role
      INTO v_existing_display_name, v_existing_role
    FROM public.poc_session_memberships AS membership
    WHERE membership.session_id = v_session_id
      AND membership.user_id = v_user_id;

    IF NOT FOUND OR v_existing_role <> 'admin' THEN
      RAISE EXCEPTION 'Existing PoC Session state is incomplete.' USING ERRCODE = '55000';
    END IF;
    IF v_existing_session_name <> v_session_name
      OR v_existing_display_name <> v_display_name THEN
      RAISE EXCEPTION 'PoC request ID was reused with a different payload.' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT v_session_id, v_existing_session_name, v_join_code, true;
    RETURN;
  END IF;

  -- A UUID-derived 122-bit capability is generated on the trusted side. It is
  -- stored only in the non-readable join_code column and returned to the creator.
  FOR v_attempt IN 1..5 LOOP
    v_join_code := pg_catalog.lower(
      pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    );
    v_session_id := NULL;

    INSERT INTO public.poc_sessions (
      created_by, creation_request_id, join_code, session_name, status
    ) VALUES (
      v_user_id, p_request_id, v_join_code, v_session_name, 'active'
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_session_id;

    IF v_session_id IS NOT NULL THEN
      INSERT INTO public.poc_session_memberships (
        session_id, user_id, display_name, membership_role
      ) VALUES (
        v_session_id, v_user_id, v_display_name, 'admin'
      );

      RETURN QUERY SELECT v_session_id, v_session_name, v_join_code, false;
      RETURN;
    END IF;

    -- ON CONFLICT also covers an in-flight replay of this request. Re-read it
    -- after the conflicting transaction commits, then validate the payload.
    SELECT session_row.id, session_row.session_name, session_row.join_code
      INTO v_session_id, v_existing_session_name, v_join_code
    FROM public.poc_sessions AS session_row
    WHERE session_row.created_by = v_user_id
      AND session_row.creation_request_id = p_request_id
    FOR UPDATE;

    IF FOUND THEN
      SELECT membership.display_name, membership.membership_role
        INTO v_existing_display_name, v_existing_role
      FROM public.poc_session_memberships AS membership
      WHERE membership.session_id = v_session_id
        AND membership.user_id = v_user_id;

      IF NOT FOUND OR v_existing_role <> 'admin' THEN
        RAISE EXCEPTION 'Existing PoC Session state is incomplete.' USING ERRCODE = '55000';
      END IF;
      IF v_existing_session_name <> v_session_name
        OR v_existing_display_name <> v_display_name THEN
        RAISE EXCEPTION 'PoC request ID was reused with a different payload.' USING ERRCODE = '22023';
      END IF;

      RETURN QUERY SELECT v_session_id, v_existing_session_name, v_join_code, true;
      RETURN;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a PoC join code.' USING ERRCODE = '40001';
END;
$function$;

CREATE OR REPLACE FUNCTION public.poc_join_session(
  p_join_code text,
  p_display_name text
)
RETURNS TABLE (
  session_id uuid,
  session_name text,
  membership_role text,
  already_member boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_join_code text;
  v_session_id uuid;
  v_session_name text;
  v_session_status text;
  v_display_name text := btrim(p_display_name);
  v_membership_role text;
  v_rows_inserted integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '28000';
  END IF;

  IF p_join_code IS NULL
    OR p_display_name IS NULL
    OR char_length(v_display_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Invalid PoC join request.' USING ERRCODE = '22023';
  END IF;

  v_join_code := pg_catalog.lower(btrim(p_join_code));
  IF v_join_code !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'PoC Session is unavailable.' USING ERRCODE = 'P0002';
  END IF;

  SELECT session_row.id, session_row.session_name, session_row.status
    INTO v_session_id, v_session_name, v_session_status
  FROM public.poc_sessions AS session_row
  WHERE session_row.join_code = v_join_code
  FOR SHARE OF session_row;

  IF NOT FOUND OR v_session_status <> 'active' THEN
    RAISE EXCEPTION 'PoC Session is unavailable.' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.poc_session_memberships (
    session_id, user_id, display_name, membership_role
  ) VALUES (
    v_session_id, v_user_id, v_display_name, 'participant'
  )
  ON CONFLICT ON CONSTRAINT poc_session_memberships_pkey DO NOTHING;
  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  SELECT membership.membership_role
    INTO v_membership_role
  FROM public.poc_session_memberships AS membership
  WHERE membership.session_id = v_session_id
    AND membership.user_id = v_user_id;

  IF NOT FOUND OR v_membership_role NOT IN ('admin', 'participant') THEN
    RAISE EXCEPTION 'PoC membership state is unavailable.' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY SELECT
    v_session_id,
    v_session_name,
    v_membership_role,
    (v_rows_inserted = 0);
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.poc_create_session(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON FUNCTION public.poc_join_session(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.poc_create_session(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.poc_join_session(text, text) TO authenticated;

INSERT INTO public.poc_schema_versions (version, migration_name)
VALUES (1, '20261016131045_create_poc_foundation.sql')
ON CONFLICT (version) DO NOTHING;

DO $version_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.poc_schema_versions AS version_row
    WHERE version_row.version = 1
      AND version_row.migration_name = '20261016131045_create_poc_foundation.sql'
  ) THEN
    RAISE EXCEPTION 'PoC schema version 1 conflicts with an existing record.';
  END IF;
END;
$version_check$;

COMMENT ON SCHEMA poc_private IS
  'Internal PoC helpers; do not expose this schema through the Supabase client API.';
COMMENT ON TABLE public.poc_schema_versions IS
  'PoC migration marker. Client roles have no direct privileges or RLS policies.';
COMMENT ON COLUMN public.poc_sessions.join_code IS
  'High-entropy PoC bearer code. Never expose through table reads, logs, or support material.';
COMMENT ON FUNCTION public.poc_create_session(uuid, text, text) IS
  'Authenticated PoC RPC. Derives identity from auth.uid(), creates Session and creator Admin atomically, and replays by request ID.';
COMMENT ON FUNCTION public.poc_join_session(text, text) IS
  'Authenticated PoC RPC. Derives identity from auth.uid() and can create participant membership only.';

-- Realtime is intentionally not added to a publication by this migration.
-- Enable public.poc_session_memberships only during a separate Hosted validation
-- step, then prove RLS isolation for initial snapshots and change events.
