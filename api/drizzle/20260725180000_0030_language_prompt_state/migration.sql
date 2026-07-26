-- Tracks whether a worker ever answered the Butler language prompt, and when we
-- last asked. `preferred_locale` alone cannot tell "chose English" from "never
-- answered", and a worker who never answered has their writes stored under a
-- guessed source language rather than a stated one.
--
-- set_at is deliberately NOT used to trust an 'en' preference as a source-language
-- hint (see authorLocaleHint): the prompt asks which language Butler should reply
-- in, not which language the worker writes in.
--
-- Both left null for existing rows on purpose: we do not know whether they ever
-- answered, so they are re-prompted on their next message, which is the intent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_locale_set_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_locale_prompted_at timestamptz;
