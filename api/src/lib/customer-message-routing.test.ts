import { describe, expect, it } from 'vitest'
import { isCustomerConversationCommand } from './customer-message-routing.js'

describe('customer message routing', () => {
  it.each([
    '4',
    '4 damaged plantain',
    'complaint: my delivery is late',
    'support',
    'problem - missing crate',
    'issue unsafe food',
    'link TRV-ABCD12',
    '3',
    'credits',
    'referral code',
    'basket',
    'survey products',
    'shop link',
    'What is my referral code?',
    'How do Trovara Credits work?',
    'Where is the shop?',
    'Can I build a basket?',
    'Which products are in the survey?',
    'How do I log in?',
  ])('routes support command %j to the order/support conversation', (message) => {
    expect(isCustomerConversationCommand(message)).toBe(true)
  })

  it.each(['Great service', 'The plantain was fresh'])(
    'leaves non-command feedback %j available to feedback handling',
    (message) => {
      expect(isCustomerConversationCommand(message)).toBe(false)
    },
  )
})
