CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE IF NOT EXISTS fs_nodes (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    session_id      bigint NOT NULL,
    parent_id       bigint REFERENCES fs_nodes(id) ON DELETE CASCADE,
    name            text NOT NULL CHECK (length(name) <= 255),
    node_type       text NOT NULL CHECK (node_type IN ('file', 'directory', 'symlink')),
    path            ltree NOT NULL,
    content         text,
    binary_data     bytea,
    symlink_target  text CHECK (symlink_target IS NULL OR length(symlink_target) <= 4096),
    mode            int NOT NULL DEFAULT 644 CHECK (mode >= 0 AND mode <= 7777),
    size_bytes      bigint NOT NULL DEFAULT 0,
    mtime           timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    search_vector   tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('english', left(coalesce(content, ''), 100000)), 'C')
    ) STORED,

    CONSTRAINT unique_session_path UNIQUE (session_id, path)
);

CREATE INDEX IF NOT EXISTS idx_fs_path_gist ON fs_nodes USING GIST (path gist_ltree_ops(siglen=124));
CREATE INDEX IF NOT EXISTS idx_fs_parent ON fs_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_fs_session ON fs_nodes (session_id);
CREATE INDEX IF NOT EXISTS idx_fs_session_parent ON fs_nodes (session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_fs_search ON fs_nodes USING GIN (search_vector);

-- RLS: per-session isolation
ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fs_nodes FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'fs_nodes' AND policyname = 'session_isolation'
    ) THEN
        CREATE POLICY session_isolation ON fs_nodes FOR ALL
            USING (session_id = current_setting('app.session_id', true)::bigint)
            WITH CHECK (session_id = current_setting('app.session_id', true)::bigint);
    END IF;
END $$;

-- Grant table permissions to app role if it exists (for RLS enforcement)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fs_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON fs_nodes TO fs_app';
        EXECUTE 'GRANT USAGE ON SCHEMA public TO fs_app';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fs_app';
    END IF;
END $$;
