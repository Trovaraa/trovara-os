import { describe, expect, it } from 'vitest'
import {
  checkLlmBudget,
  consumeLlmBudget,
  llmDailyBudgetPerFarm,
  resetLlmBudget,
} from './llm-budget.js'

describe('llm-budget', () => {
  it('defaults to 500 calls per farm per day', () => {
    delete process.env.LLM_DAILY_BUDGET_PER_FARM
    expect(llmDailyBudgetPerFarm()).toBe(500)
  })

  it('tracks consumption per farm', () => {
    resetLlmBudget()
    const farmId = 'farm-budget-test'
    expect(checkLlmBudget(farmId).allowed).toBe(true)
    consumeLlmBudget(farmId)
    expect(checkLlmBudget(farmId).used).toBe(1)
  })
})
