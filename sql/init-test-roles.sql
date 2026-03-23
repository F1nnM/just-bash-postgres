-- Non-superuser role for RLS enforcement testing
-- This runs automatically on first docker compose up
CREATE ROLE fs_app LOGIN;
GRANT USAGE ON SCHEMA public TO fs_app;
