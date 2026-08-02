/**
 * Commands that belong to the customer ordering/support conversation must not
 * be intercepted by the post-delivery feedback handler.
 */
export function isCustomerConversationCommand(text: string): boolean {
  return /^(?:hi|hello|hey|menu|start|\/start|order|track|help|link|1|2|4|complaint|support|problem|issue)\b/i.test(
    text.trim(),
  )
}
