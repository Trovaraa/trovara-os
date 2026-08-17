import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('survey follow-up enum migration', () => {
  it('does not resolve the new enum label inside the same migration transaction', async () => {
    const addValue = await readFile(
      new URL('../../drizzle/20260815150000_0062_survey_followup_lead_type/migration.sql', import.meta.url),
      'utf8',
    )
    const dependentSchema = await readFile(
      new URL('../../drizzle/20260815151000_0063_customer_surveys/migration.sql', import.meta.url),
      'utf8',
    )

    expect(addValue).toContain("ADD VALUE IF NOT EXISTS 'survey_followup'")
    expect(addValue).not.toContain('marketing_leads_survey_followup_shape')
    expect(dependentSchema).toContain("lead_type::text <> 'survey_followup'")
    expect(dependentSchema).not.toContain("lead_type <> 'survey_followup'")
  })
})

describe('newsletter campaign history migration', () => {
  it('allows a sent Journal campaign to outlive a deleted source post', async () => {
    const migration = await readFile(
      new URL(
        '../../drizzle/20260817183000_0077_newsletter_delivery_tracking/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )

    expect(migration).toContain("CHECK (campaign_type = 'journal' OR journal_post_id IS NULL)")
    expect(migration).not.toContain("(campaign_type = 'journal') = (journal_post_id IS NOT NULL)")
  })
})

describe('Operations Library owner migration', () => {
  it('backfills ownership and preserves it in approved versions', async () => {
    const migration = await readFile(
      new URL(
        '../../drizzle/20260817190000_0078_operation_guideline_owner/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL')
    expect(migration).toContain('SET owner_id = created_by_id')
    expect(migration).toContain('ALTER TABLE operation_guideline_versions')
  })
})
