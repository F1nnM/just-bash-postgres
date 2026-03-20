CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE IF NOT EXISTS fs_nodes (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    owner_id        bigint NOT NULL,
    parent_id       bigint REFERENCES fs_nodes(id) ON DELETE CASCADE,
    name            text NOT NULL,
    node_type       text NOT NULL CHECK (node_type IN ('file', 'directory', 'symlink')),
    path            ltree NOT NULL,
    content         text,
    binary_data     bytea,
    symlink_target  text,
    mode            int NOT NULL DEFAULT 644,
    size_bytes      bigint NOT NULL DEFAULT 0,
    mtime           timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    search_vector   tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
    ) STORED,

    CONSTRAINT unique_owner_path UNIQUE (owner_id, path)
);

CREATE INDEX IF NOT EXISTS idx_fs_path_gist ON fs_nodes USING GIST (path gist_ltree_ops(siglen=124));
CREATE INDEX IF NOT EXISTS idx_fs_parent ON fs_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_fs_owner ON fs_nodes (owner_id);
CREATE INDEX IF NOT EXISTS idx_fs_owner_parent ON fs_nodes (owner_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_fs_search ON fs_nodes USING GIN (search_vector);

-- RLS: per-user isolation
ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fs_nodes FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'fs_nodes' AND policyname = 'user_isolation'
    ) THEN
        CREATE POLICY user_isolation ON fs_nodes FOR ALL
            USING (owner_id = current_setting('app.user_id', true)::bigint)
            WITH CHECK (owner_id = current_setting('app.user_id', true)::bigint);
    END IF;
END $$;
