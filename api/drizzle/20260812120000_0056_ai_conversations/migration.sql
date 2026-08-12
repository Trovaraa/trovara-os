CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_conversations_user_updated_idx
  ON ai_conversations(farm_id, user_id, updated_at);

CREATE TABLE IF NOT EXISTS ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  attachment_url text,
  model text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_messages_role_check CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX IF NOT EXISTS ai_messages_conversation_created_idx
  ON ai_messages(conversation_id, created_at);

-- Existing system roles need the new grant as well as farms created after this
-- migration. Custom roles remain opt-in through the role-permission editor.
INSERT INTO farm_role_permissions(role_id, permission_key)
SELECT id, 'ai.use'
FROM farm_roles
WHERE is_system = true
ON CONFLICT DO NOTHING;

INSERT INTO farm_role_permissions(role_id, permission_key)
SELECT role.id, permission.key
FROM farm_roles role
CROSS JOIN (VALUES ('assets.count'), ('census.create'), ('livestock.log'), ('field_reports.create')) AS permission(key)
WHERE role.is_system = true
  AND role.cloned_from IN ('supervisor', 'field_worker')
ON CONFLICT DO NOTHING;
