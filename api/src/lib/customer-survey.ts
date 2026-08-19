import { z } from 'zod'

export const CUSTOMER_SURVEY_KEY = 'food-shopping-v1'
export const CUSTOMER_SURVEY_SOURCE = 'marketing_public_survey'
export const DEFAULT_SURVEY_PRIVACY_NOTICE_URL = 'https://trovara.farm/privacy'

export const SURVEY_LOCATIONS = {
  lagos_island: 'Lagos Island',
  lagos_mainland: 'Lagos Mainland',
  abeokuta: 'Abeokuta',
  other_ogun: 'Other Ogun State',
  abuja: 'Abuja',
  other: 'Other',
} as const

export const SURVEY_HOUSEHOLDS = {
  '1': '1',
  '2': '2',
  '3_4': '3–4',
  '5_6': '5–6',
  '7_plus': '7+',
} as const

export const SURVEY_BUY_PLACES = {
  open_market: 'Open market',
  supermarket: 'Supermarket',
  neighbourhood_shop: 'Neighbourhood shops',
  farm_direct: 'Directly from farms/farmers',
  online_grocery: 'Online grocery service',
  social_vendors: 'WhatsApp/Instagram vendors',
  roadside: 'Roadside/mobile vendors',
  other: 'Other',
} as const

export const SURVEY_FREQUENCIES = {
  more_than_weekly: 'More than once a week',
  weekly: 'Weekly',
  fortnightly: 'Every 2 weeks',
  monthly: 'Monthly',
  irregularly: 'Irregularly',
} as const

export const SURVEY_FRUSTRATIONS = {
  prices_change: 'Prices change too frequently',
  inconsistent_quality: 'Inconsistent quality',
  not_fresh: "Food isn't fresh enough",
  spoils_quickly: 'Food spoils too quickly',
  takes_too_long: 'Shopping takes too much time',
  several_places: 'Having to shop in several places',
  markets_stressful: 'Markets are stressful/inconvenient',
  unknown_source: 'Difficult to know where food comes from/how it was handled',
  unreliable_sellers: 'Unreliable sellers',
  poor_delivery: 'Poor or unreliable delivery',
  unavailable: 'Products I want are frequently unavailable',
  poor_packaging: 'Poor packaging',
  other: 'Other',
} as const

export const SURVEY_PRIORITIES = {
  price: 'Price',
  freshness: 'Freshness',
  taste: 'Taste',
  consistent_quality: 'Consistent quality',
  convenience: 'Convenience',
  food_safety: 'Food safety',
  origin: 'Knowing where the food came from',
  availability: 'Reliable availability',
  home_delivery: 'Home delivery',
  one_place: 'Ability to buy most things in one place',
} as const

export const SURVEY_PRODUCTS = {
  eggs: 'Eggs',
  chicken: 'Chicken',
  plantain: 'Plantain',
  yam: 'Yam',
  sweet_potato: 'Sweet potato',
  tomatoes: 'Tomatoes',
  pepper: 'Pepper',
  onions: 'Onions',
  leafy_veg: 'Leafy vegetables',
  other_veg: 'Other vegetables such as Okro',
  palm_oil: 'Palm oil',
  fruits: 'Fruits',
  other: 'Other',
} as const

export const SURVEY_SOURCE_MATTERS = {
  definitely: 'Definitely',
  probably: 'Probably',
  not_sure: 'Not sure',
  probably_not: 'Probably not',
  definitely_not: 'Definitely not',
} as const

export const SURVEY_SHOP_PREFS = {
  individual: 'Select everything individually',
  prepared_basket: 'Choose a prepared food basket',
  customise_basket: 'Start with a recommended basket and customise it',
  repeat_order: 'Quickly repeat my previous order',
  no_preference: 'No particular preference',
} as const

export const SURVEY_PRICE_EXPECTATIONS = {
  cheaper: 'It should be cheaper',
  same: 'About the same as I pay now',
  up_to_5: 'I would pay up to 5% more',
  '5_to_10': 'I would pay 5–10% more',
  more_than_10: 'I would pay more than 10% if the difference is worthwhile',
} as const

export const SURVEY_HEARD_FROM = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  friend: 'Friend or family',
  website: 'trovara.farm',
  other: 'Other',
} as const

export const SURVEY_FOLLOW_UP = {
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
} as const

type OptionMap = Record<string, string>

function optionKeys<T extends OptionMap>(options: T) {
  return Object.keys(options) as [keyof T & string, ...(keyof T & string)[]]
}

function uniqueEnumArray<T extends OptionMap>(options: T, min: number, max: number) {
  return z
    .array(z.enum(optionKeys(options)))
    .min(min)
    .max(max)
    .refine((values) => new Set(values).size === values.length, 'Duplicate choices are not allowed')
}

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().trim().min(1).max(max).optional(),
  )

const optionalConsentVersion = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.string().trim().min(1).max(32).optional(),
)

export const customerSurveySchema = z
  .object({
    location: z.enum(optionKeys(SURVEY_LOCATIONS)),
    locationOther: optionalText(80),
    household: z.enum(optionKeys(SURVEY_HOUSEHOLDS)),
    buyPlaces: uniqueEnumArray(SURVEY_BUY_PLACES, 1, 3),
    buyPlacesOther: optionalText(80),
    frequency: z.enum(optionKeys(SURVEY_FREQUENCIES)),
    frustrations: uniqueEnumArray(SURVEY_FRUSTRATIONS, 1, 4),
    frustrationsOther: optionalText(80),
    topFrustration: z.enum(optionKeys(SURVEY_FRUSTRATIONS)).optional(),
    priorities: uniqueEnumArray(SURVEY_PRIORITIES, 3, 3),
    products: uniqueEnumArray(SURVEY_PRODUCTS, 1, 8),
    productsOther: optionalText(80),
    hardToGet: z.string().trim().min(1).max(500),
    sourceMatters: z.enum(optionKeys(SURVEY_SOURCE_MATTERS)),
    shopPreference: z.enum(optionKeys(SURVEY_SHOP_PREFS)),
    priceExpectation: z.enum(optionKeys(SURVEY_PRICE_EXPECTATIONS)),
    oneChange: z.string().trim().min(1).max(500),
    heardFrom: z.enum(optionKeys(SURVEY_HEARD_FROM)),
    heardFromOther: optionalText(80),
    followUp: z.enum(optionKeys(SURVEY_FOLLOW_UP)),
    name: optionalText(120),
    contact: optionalText(320),
    consent: z.literal(true),
    consentVersion: optionalConsentVersion,
    honey: z.string().max(500).optional(),
    utmSource: optionalText(200),
    utmMedium: optionalText(200),
    utmCampaign: optionalText(200),
    referrer: optionalText(500),
    referralCode: z.preprocess(
      (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
      z.string().trim().toUpperCase().regex(/^TRV[A-Z0-9]{6,24}$/).optional(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    requireOther(value.location === 'other', value.locationOther, 'locationOther', context)
    requireOther(value.buyPlaces.includes('other'), value.buyPlacesOther, 'buyPlacesOther', context)
    requireOther(value.frustrations.includes('other'), value.frustrationsOther, 'frustrationsOther', context)
    requireOther(value.products.includes('other'), value.productsOther, 'productsOther', context)
    requireOther(value.heardFrom === 'other', value.heardFromOther, 'heardFromOther', context)

    const top = value.topFrustration ?? (value.frustrations.length === 1 ? value.frustrations[0] : undefined)
    if (!top) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['topFrustration'],
        message: 'Choose the one problem that bothers you most',
      })
    } else if (!value.frustrations.includes(top)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['topFrustration'],
        message: 'The top problem must be one of the problems you selected',
      })
    }

    if (value.followUp !== 'no' && !parseSurveyContact(value.contact ?? '')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contact'],
        message: 'Enter a WhatsApp number or email so we can follow up',
      })
    }
  })

export type CustomerSurveyInput = z.infer<typeof customerSurveySchema>
export type SurveyFollowUp = keyof typeof SURVEY_FOLLOW_UP

export type SurveyAnswers = {
  location: keyof typeof SURVEY_LOCATIONS
  locationOther: string | null
  household: keyof typeof SURVEY_HOUSEHOLDS
  buyPlaces: Array<keyof typeof SURVEY_BUY_PLACES>
  buyPlacesOther: string | null
  frequency: keyof typeof SURVEY_FREQUENCIES
  frustrations: Array<keyof typeof SURVEY_FRUSTRATIONS>
  frustrationsOther: string | null
  topFrustration: keyof typeof SURVEY_FRUSTRATIONS
  priorities: Array<keyof typeof SURVEY_PRIORITIES>
  products: Array<keyof typeof SURVEY_PRODUCTS>
  productsOther: string | null
  hardToGet: string
  sourceMatters: keyof typeof SURVEY_SOURCE_MATTERS
  shopPreference: keyof typeof SURVEY_SHOP_PREFS
  priceExpectation: keyof typeof SURVEY_PRICE_EXPECTATIONS
  oneChange: string
  heardFrom: keyof typeof SURVEY_HEARD_FROM
  heardFromOther: string | null
}

export type ParsedCustomerSurvey = {
  answers: SurveyAnswers
  followUp: SurveyFollowUp
  name: string | null
  contact: { email: string | null; phone: string | null; normalized: string } | null
  attribution: {
    utmSource: string | null
    utmMedium: string | null
    utmCampaign: string | null
    referrer: string | null
    referralCode: string | null
  }
  consentVersion: string
}

function requireOther(
  needed: boolean,
  value: string | undefined,
  path: string,
  context: z.RefinementCtx,
) {
  if (needed && !value) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: 'Please specify',
    })
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function normalizePhone(value: string): string | null {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  if (digits.startsWith('00')) return `+${digits.slice(2)}`
  if (digits.startsWith('234') && digits.length === 13) return `+${digits}`
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`
  if (/^[789]\d{9}$/.test(digits)) return `+234${digits}`
  if (trimmed.startsWith('+')) return `+${digits}`
  return digits
}

export function parseSurveyContact(
  value: string,
): { email: string | null; phone: string | null; normalized: string } | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (z.string().email().safeParse(trimmed).success) {
    const email = normalizeEmail(trimmed)
    return { email, phone: null, normalized: `email:${email}` }
  }
  const normalizedPhone = normalizePhone(trimmed)
  return normalizedPhone
    ? { email: null, phone: trimmed, normalized: `phone:${normalizedPhone}` }
    : null
}

export function customerSurveyConsentVersion(fromBody?: string): string {
  return fromBody?.trim() || process.env.MARKETING_LEAD_CONSENT_VERSION?.trim() || '1.0'
}

export function parseCustomerSurvey(input: CustomerSurveyInput): ParsedCustomerSurvey {
  const topFrustration = input.topFrustration ?? input.frustrations[0]!
  const wantsFollowUp = input.followUp !== 'no'
  return {
    answers: {
      location: input.location,
      locationOther: input.location === 'other' ? input.locationOther ?? null : null,
      household: input.household,
      buyPlaces: input.buyPlaces,
      buyPlacesOther: input.buyPlaces.includes('other') ? input.buyPlacesOther ?? null : null,
      frequency: input.frequency,
      frustrations: input.frustrations,
      frustrationsOther: input.frustrations.includes('other') ? input.frustrationsOther ?? null : null,
      topFrustration,
      priorities: input.priorities,
      products: input.products,
      productsOther: input.products.includes('other') ? input.productsOther ?? null : null,
      hardToGet: input.hardToGet.trim(),
      sourceMatters: input.sourceMatters,
      shopPreference: input.shopPreference,
      priceExpectation: input.priceExpectation,
      oneChange: input.oneChange.trim(),
      heardFrom: input.heardFrom,
      heardFromOther: input.heardFrom === 'other' ? input.heardFromOther ?? null : null,
    },
    followUp: input.followUp,
    name: wantsFollowUp ? input.name ?? null : null,
    contact: wantsFollowUp ? parseSurveyContact(input.contact ?? '') : null,
    attribution: {
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      referrer: input.referrer ?? null,
      referralCode: input.referralCode ?? null,
    },
    consentVersion: customerSurveyConsentVersion(input.consentVersion),
  }
}

function labels(options: OptionMap, keys: string[], other?: string | null): string[] {
  return keys.map((key) => {
    const label = options[key] ?? key
    return key === 'other' && other ? `${label}: ${other}` : label
  })
}

export function presentSurveyAnswers(answers: SurveyAnswers): Array<{ key: string; label: string; value: string }> {
  return [
    {
      key: 'location',
      label: 'Where they live',
      value: labels(SURVEY_LOCATIONS, [answers.location], answers.locationOther).join(', '),
    },
    { key: 'household', label: 'Household size', value: SURVEY_HOUSEHOLDS[answers.household] },
    {
      key: 'buyPlaces',
      label: 'Where they buy fresh food',
      value: labels(SURVEY_BUY_PLACES, answers.buyPlaces, answers.buyPlacesOther).join(', '),
    },
    { key: 'frequency', label: 'How often they buy', value: SURVEY_FREQUENCIES[answers.frequency] },
    {
      key: 'frustrations',
      label: 'Frustrations',
      value: labels(SURVEY_FRUSTRATIONS, answers.frustrations, answers.frustrationsOther).join(', '),
    },
    {
      key: 'topFrustration',
      label: 'Biggest problem',
      value: labels(SURVEY_FRUSTRATIONS, [answers.topFrustration], answers.frustrationsOther).join(', '),
    },
    {
      key: 'priorities',
      label: 'What matters most',
      value: labels(SURVEY_PRIORITIES, answers.priorities).join(', '),
    },
    {
      key: 'products',
      label: 'Regular products',
      value: labels(SURVEY_PRODUCTS, answers.products, answers.productsOther).join(', '),
    },
    { key: 'hardToGet', label: 'Hardest to get at the quality they want', value: answers.hardToGet },
    {
      key: 'sourceMatters',
      label: 'Would knowing the farm/source change a purchase',
      value: SURVEY_SOURCE_MATTERS[answers.sourceMatters],
    },
    { key: 'shopPreference', label: 'How they would prefer to shop', value: SURVEY_SHOP_PREFS[answers.shopPreference] },
    {
      key: 'priceExpectation',
      label: 'Price expectation',
      value: SURVEY_PRICE_EXPECTATIONS[answers.priceExpectation],
    },
    { key: 'oneChange', label: 'One thing they would change', value: answers.oneChange },
    {
      key: 'heardFrom',
      label: 'How they heard about Trovara Farm',
      value: labels(SURVEY_HEARD_FROM, [answers.heardFrom], answers.heardFromOther).join(', '),
    },
  ]
}

export function surveyFollowUpMessage(answers: SurveyAnswers): string {
  const presented = presentSurveyAnswers(answers)
  const biggest = presented.find((row) => row.key === 'topFrustration')?.value
  return [
    biggest ? `Biggest problem: ${biggest}` : '',
    `One change: ${answers.oneChange}`,
  ]
    .filter(Boolean)
    .join('\n')
}
