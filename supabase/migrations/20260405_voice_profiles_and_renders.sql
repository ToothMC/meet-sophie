-- ============================================
-- Migration: voice_profiles + pitch_audio_files + pitch_renders
-- ElevenLabs Pitch Voice Render (Track A)
-- ============================================

-- 1. Voice Profiles — one per user
CREATE TABLE voice_profiles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Provider
  provider                text NOT NULL DEFAULT 'elevenlabs',
  provider_voice_version  text,
  elevenlabs_voice_id     text,
  clone_type              text DEFAULT 'instant',
  clone_status            text NOT NULL DEFAULT 'pending'
                          CHECK (clone_status IN ('pending','ready','failed','deleted')),
  last_clone_error        text,

  -- Source Audio
  source_audio_path       text,
  source_audio_duration   numeric(6,2),

  -- Consent
  user_consent            boolean NOT NULL DEFAULT false,
  consent_at              timestamptz,
  consent_text_version    text,

  -- Lifecycle
  is_active               boolean NOT NULL DEFAULT true,
  deleted_at              timestamptz,

  -- Usage
  total_chars_generated   integer NOT NULL DEFAULT 0,
  total_generations       integer NOT NULL DEFAULT 0,
  last_used_at            timestamptz,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE(user_id)
);

ALTER TABLE voice_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_voice" ON voice_profiles
  FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_vp_user ON voice_profiles(user_id);
CREATE INDEX idx_vp_active ON voice_profiles(clone_status) WHERE is_active;


-- 2. Pitch Audio Files — voice sample tracking
CREATE TABLE pitch_audio_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id          uuid,

  storage_path        text NOT NULL,
  mime_type           text NOT NULL DEFAULT 'audio/webm',
  file_size_bytes     integer,
  duration_seconds    numeric(6,2),

  used_for_clone      boolean NOT NULL DEFAULT false,
  retention_until     timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pitch_audio_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_audio" ON pitch_audio_files
  FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_paf_user ON pitch_audio_files(user_id);


-- 3. Pitch Renders — audit + idempotency
CREATE TABLE pitch_renders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id          uuid NOT NULL,
  voice_profile_id    uuid REFERENCES voice_profiles(id),

  -- Status
  render_status       text NOT NULL DEFAULT 'pending'
                      CHECK (render_status IN ('pending','completed','failed')),
  error_message       text,

  -- Content
  optimized_text      text,
  storage_path        text,
  file_size_bytes     integer,

  -- Billing Audit
  estimated_chars     integer,
  actual_chars        integer,
  tokens_charged      integer,
  billing_type        text DEFAULT 'elevenlabs_tts',
  billing_metadata    jsonb,

  -- Timestamps
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pitch_renders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_renders" ON pitch_renders
  FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_pr_session ON pitch_renders(session_id, user_id);
CREATE INDEX idx_pr_status ON pitch_renders(render_status) WHERE render_status = 'completed';


-- 4. Voice Usage Increment Function
CREATE OR REPLACE FUNCTION increment_voice_usage(
  p_user_id uuid,
  p_chars integer
) RETURNS void AS $$
BEGIN
  UPDATE voice_profiles
  SET
    total_chars_generated = total_chars_generated + p_chars,
    total_generations = total_generations + 1,
    last_used_at = now(),
    updated_at = now()
  WHERE user_id = p_user_id AND is_active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 5. Storage Buckets
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('pitch-audio', 'pitch-audio', false, 10485760, ARRAY['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg']),
  ('pitch-renders', 'pitch-renders', false, 20971520, ARRAY['audio/mpeg'])
ON CONFLICT (id) DO NOTHING;

-- Storage policies: pitch-audio (user upload)
CREATE POLICY "users_upload_pitch_audio" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'pitch-audio'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "users_read_pitch_audio" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'pitch-audio'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Storage policies: pitch-renders (server upload via service role, user read)
CREATE POLICY "users_read_pitch_renders" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'pitch-renders'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
