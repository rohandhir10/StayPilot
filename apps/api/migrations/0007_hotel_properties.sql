-- Workspace-scoped hotel property directory.
-- Historical inquiry rows are preserved; they reference a property by its
-- display name until a later normalized foreign-key migration is planned.
CREATE TABLE IF NOT EXISTS hotel_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  city TEXT NOT NULL DEFAULT '' CHECK (length(city) <= 120),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hotel_properties_workspace_name_unique
  ON hotel_properties(workspace_id, lower(name));
CREATE INDEX IF NOT EXISTS hotel_properties_workspace_active_idx
  ON hotel_properties(workspace_id, is_active, lower(name));

-- Backfill every distinct property already referenced by historical leads.
INSERT INTO hotel_properties (workspace_id, name)
SELECT workspace_id, min(trim(property_name))
FROM leads
WHERE trim(property_name) <> ''
GROUP BY workspace_id, lower(trim(property_name))
ON CONFLICT DO NOTHING;

-- Every existing workspace, including an empty one, gets at least one property.
INSERT INTO hotel_properties (workspace_id, name)
SELECT w.id, left(trim(w.name), 120)
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM hotel_properties p WHERE p.workspace_id=w.id)
ON CONFLICT DO NOTHING;
