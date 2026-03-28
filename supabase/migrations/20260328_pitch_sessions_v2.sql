-- Sales Pitch v2: Add new scoring dimensions and pitch classification
-- Adds pitch_type, goal_type, split scores (content/delivery)

ALTER TABLE sophie_pitch_memory
  ADD COLUMN IF NOT EXISTS pitch_type      text,    -- sales|investor|keynote|internal|self|other
  ADD COLUMN IF NOT EXISTS goal_type       text,    -- buy|invest|approve|trust|understand|remember|decide
  ADD COLUMN IF NOT EXISTS scores_content  jsonb,   -- {clarity, problem_sharpness, value_prop, structure, differentiation, credibility, audience_fit}
  ADD COLUMN IF NOT EXISTS scores_delivery jsonb;   -- {opening, closing, voice_rhythm, rhetoric_language, authenticity, persuasiveness}

-- Add check constraints for valid types
ALTER TABLE sophie_pitch_memory
  ADD CONSTRAINT chk_pitch_type CHECK (pitch_type IS NULL OR pitch_type IN ('sales', 'investor', 'keynote', 'internal', 'self', 'other'));

ALTER TABLE sophie_pitch_memory
  ADD CONSTRAINT chk_goal_type CHECK (goal_type IS NULL OR goal_type IN ('buy', 'invest', 'approve', 'trust', 'understand', 'remember', 'decide'));

-- Migrate existing score data: old single score (0-100) → scores_content with normalized values
UPDATE sophie_pitch_memory
SET scores_content = jsonb_build_object(
  'clarity', round(score / 20.0, 1),
  'problem_sharpness', null,
  'value_prop', null,
  'structure', null,
  'differentiation', null,
  'credibility', null,
  'audience_fit', null
)
WHERE score IS NOT NULL AND scores_content IS NULL;

COMMENT ON COLUMN sophie_pitch_memory.pitch_type IS 'Auto-detected from setup answers: sales|investor|keynote|internal|self|other';
COMMENT ON COLUMN sophie_pitch_memory.goal_type IS 'Auto-detected pitch goal: buy|invest|approve|trust|understand|remember|decide';
COMMENT ON COLUMN sophie_pitch_memory.scores_content IS 'Content scores (7 criteria): clarity, problem_sharpness, value_prop, structure, differentiation, credibility, audience_fit';
COMMENT ON COLUMN sophie_pitch_memory.scores_delivery IS 'Delivery scores (6 criteria): opening, closing, voice_rhythm, rhetoric_language, authenticity, persuasiveness';
