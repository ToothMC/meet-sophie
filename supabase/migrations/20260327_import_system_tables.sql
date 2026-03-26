-- Migration 2: Import System tables (source connections, items, permissions, deletion log)

-- source_connections (per imported source)
CREATE TABLE IF NOT EXISTS source_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  source_type TEXT NOT NULL,       -- 'chatgpt' | 'claude' | 'gemini' | 'file'
  source_name TEXT NOT NULL,
  import_method TEXT NOT NULL,     -- 'chat_paste' | 'file_upload'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'decoupled' | 'deleted'
  item_count INTEGER DEFAULT 0,
  cluster_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_import_at TIMESTAMPTZ
);

-- source_items (individual imported units)
CREATE TABLE IF NOT EXISTS source_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES source_connections(id) ON DELETE CASCADE NOT NULL,
  zone TEXT NOT NULL DEFAULT 'A',   -- 'A' (raw) | 'B' (working) | 'C' (memory)
  content_type TEXT NOT NULL,       -- 'chat_summary' | 'preference' | 'project' | 'pattern' | 'raw_import'
  sensitivity_class TEXT NOT NULL DEFAULT 'standard', -- 'standard' | 'confidential' | 'very_confidential'
  raw_content TEXT,
  summary TEXT,
  extracted_insights JSONB DEFAULT '{}',
  user_approved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- source_permissions
CREATE TABLE IF NOT EXISTS source_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES source_connections(id) ON DELETE CASCADE NOT NULL,
  scope TEXT NOT NULL,              -- 'full' | 'summary_only' | 'session_only'
  retention_rule TEXT NOT NULL,     -- 'permanent' | 'session' | '30_days'
  allow_memory BOOLEAN DEFAULT false,
  sensitivity_class TEXT NOT NULL DEFAULT 'standard'
);

-- source_deletion_log (audit trail)
CREATE TABLE IF NOT EXISTS source_deletion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  deletion_type TEXT NOT NULL,      -- 'decouple' | 'raw_data' | 'all'
  zones_cleared TEXT[] NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS for all import tables
ALTER TABLE source_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_deletion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own sources" ON source_connections
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own items" ON source_items
  FOR ALL USING (
    source_id IN (SELECT id FROM source_connections WHERE user_id = auth.uid())
  );

CREATE POLICY "Users own permissions" ON source_permissions
  FOR ALL USING (
    source_id IN (SELECT id FROM source_connections WHERE user_id = auth.uid())
  );

CREATE POLICY "Users own deletion logs" ON source_deletion_log
  FOR ALL USING (auth.uid() = user_id);
