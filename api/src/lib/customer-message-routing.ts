/**
 * Commands that belong to the customer ordering/support conversation must not
 * be intercepted by the post-delivery feedback handler.
 */
export function isCustomerConversationCommand(text: string): boolean {
  const normalized = text.trim()

  const startsWithCommand =
    /^(?:hi|hello|hey|menu|start|\/start|order|track|help|link|1|2|3|4|ask|question|complaint|support|problem|issue)\b/i.test(
      normalized,
    )

  const asksAboutCustomerProgramme =
    /\b(?:trovara credits?|credits?|credit balance|referral(?: code| link)?|refer(?:ral|red|ring)?|basket|cart|survey|questionnaire|shop|customer account|sign[ -]?up|register|log[ -]?in|login|products?|catalog(?:ue)?)\b/i.test(
      normalized,
    )

  return startsWithCommand || asksAboutCustomerProgramme
}
