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
