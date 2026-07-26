/**
 * Tier 1 fallback prose for advisory tips and weather actions.
 *
 * Normal advisory text is generated per farm in English and translated on read.
 * Both halves of that need the LLM, so when it is off, over budget, or returns
 * something invalid, translation is unavailable at exactly the moment the
 * fallback fires — and a French worker would be shown English. These tables are
 * the answer: fixed sentences, translated ahead of time, needing no model.
 *
 * They are deliberately generic. Advisory rules are keyed by `reasonCode`
 * (`crop_stage_fertilize`, `poultry_vaccination`) rather than by rule
 * (`plantain.vegetative.fertilize`), so the text names no crop, breed, or plot.
 * That is partly honesty — degraded output should not pretend to specifics it
 * cannot know without the model — and partly durability: reason codes survive
 * the poultry rename and the move of agronomy into per-farm data, where
 * rule-level keys would not, because text generated per farm at runtime cannot
 * be translated ahead of time at all.
 */
import type { ReplyLocale } from './reply-locale.js'

export type FallbackText = {
  happeningNow: string
  whatNext: string
}

/** Reason codes carried by every advisory rule in `advisory-playbooks.ts`. */
export type AdvisoryReasonCode =
  | 'crop_stage_planted'
  | 'crop_stage_mulch'
  | 'crop_stage_fertilize'
  | 'crop_stage_weeding'
  | 'crop_stage_irrigation'
  | 'crop_stage_flowering'
  | 'crop_stage_fruiting'
  | 'crop_stage_harvest_prep'
  | 'poultry_brooding'
  | 'poultry_vaccination'
  | 'poultry_litter_feed'
  | 'poultry_closeout'
  | 'weather_rain'
  | 'weather_heat'
  | 'weather_wind'

/** Seed ids from `THEME_BY_ALERT` in `weather-actions.ts`. */
export type WeatherThemeId =
  | 'rain-delay-irrigation'
  | 'rain-protect-young'
  | 'rain-postpone-spray'
  | 'heat-shade-livestock'
  | 'heat-irrigate-cool-hours'
  | 'heat-electrolytes'
  | 'wind-secure-covers'
  | 'wind-delay-foliar'
  | 'cold-protect-tender'

export type WeatherThemeText = {
  title: string
  detail: string
}

const ADVISORY_EN: Record<AdvisoryReasonCode, FallbackText> = {
  crop_stage_planted: {
    happeningNow: 'A new planting is settling in.',
    whatNext: 'Check spacing and placement, and water lightly today.',
  },
  crop_stage_mulch: {
    happeningNow: 'The crop is at the stage where mulch holds moisture best.',
    whatNext: 'Mulch around the base and pull back anything touching the stem.',
  },
  crop_stage_fertilize: {
    happeningNow: 'This crop is due for feeding.',
    whatNext: 'Apply the scheduled fertiliser and record what you used.',
  },
  crop_stage_weeding: {
    happeningNow: 'Weeds compete hardest with the crop at this stage.',
    whatNext: 'Clear weeds around the base and along the row.',
  },
  crop_stage_irrigation: {
    happeningNow: 'The crop needs water at this point in its cycle.',
    whatNext: 'Water at dawn or dusk, and note how much was used.',
  },
  crop_stage_flowering: {
    happeningNow: 'The crop is flowering.',
    whatNext: 'Inspect the flowers and report anything damaged or abnormal.',
  },
  crop_stage_fruiting: {
    happeningNow: 'Fruit is forming and putting on weight.',
    whatNext: 'Check supports and protect the developing fruit.',
  },
  crop_stage_harvest_prep: {
    happeningNow: 'This crop is close to harvest.',
    whatNext: 'Line up crates, labour, and a buyer before cutting starts.',
  },
  poultry_brooding: {
    happeningNow: 'The flock is in its brooding window.',
    whatNext: 'Hold the brooder temperature and keep feed and water within reach.',
  },
  poultry_vaccination: {
    happeningNow: 'A vaccination is scheduled for this flock.',
    whatNext: 'Give the scheduled dose today and record the vaccine and its batch number.',
  },
  poultry_litter_feed: {
    happeningNow: 'The flock is at the stage where litter and feed need attention.',
    whatNext: 'Change wet litter and move the birds onto the next feed ration.',
  },
  poultry_closeout: {
    happeningNow: 'This flock is approaching close-out.',
    whatNext: 'Weigh a sample, confirm the buyer, and plan the catch.',
  },
  weather_rain: {
    happeningNow: 'Rain is expected.',
    whatNext: 'Reschedule field work and move inputs and harvest under cover.',
  },
  weather_heat: {
    happeningNow: 'High heat is expected.',
    whatNext: 'Give livestock shade and cool water, and work the cooler hours.',
  },
  weather_wind: {
    happeningNow: 'Strong wind is expected.',
    whatNext: 'Secure covers and support young or heavy-bearing plants.',
  },
}

const WEATHER_EN: Record<WeatherThemeId, WeatherThemeText> = {
  'rain-delay-irrigation': {
    title: 'Delay irrigation',
    detail: 'Skip or cut back watering while rain is expected.',
  },
  'rain-protect-young': {
    title: 'Protect young plants',
    detail: 'Check young plants and nursery bags for waterlogging, and clear the drains.',
  },
  'rain-postpone-spray': {
    title: 'Postpone spraying',
    detail: 'Hold sprays and fertiliser until leaves dry, otherwise the rain washes the product off.',
  },
  'heat-shade-livestock': {
    title: 'Shade and water livestock',
    detail: 'Give pens shade, airflow, and cool drinking water through the hottest hours.',
  },
  'heat-irrigate-cool-hours': {
    title: 'Irrigate early or late',
    detail: 'Water at dawn or dusk to cut heat stress and evaporation loss.',
  },
  'heat-electrolytes': {
    title: 'Add electrolytes',
    detail: 'Put electrolytes in the drinking water while the heat holds.',
  },
  'wind-secure-covers': {
    title: 'Secure covers',
    detail: 'Tie down netting, roofing, and anything loose around the pens and stores.',
  },
  'wind-delay-foliar': {
    title: 'Delay foliar spraying',
    detail: 'Wind blows spray off target and wastes input — wait for the wind to drop.',
  },
  'cold-protect-tender': {
    title: 'Protect tender plants',
    detail: 'Cover seedlings and young plants overnight, and keep young stock warm.',
  },
}

// Partial on purpose: a missing translation falls back to English, which is
// degraded but correct. A hard requirement would turn a gap into a crash on the
// exact path that exists to survive things being broken. Completeness is
// enforced by test instead.
const ADVISORY_FR: Record<AdvisoryReasonCode, FallbackText> = {
  crop_stage_planted: {
    happeningNow: "Une nouvelle plantation s'installe.",
    whatNext: "Vérifiez l'écartement et la mise en place, et arrosez légèrement aujourd'hui.",
  },
  crop_stage_mulch: {
    happeningNow: "La culture est au stade où le paillage retient le mieux l'humidité.",
    whatNext: 'Paillez autour du pied et écartez tout ce qui touche la tige.',
  },
  crop_stage_fertilize: {
    happeningNow: 'Cette culture doit être fertilisée.',
    whatNext: "Appliquez l'engrais prévu et notez ce qui a été utilisé.",
  },
  crop_stage_weeding: {
    happeningNow: "C'est le stade où les mauvaises herbes concurrencent le plus la culture.",
    whatNext: 'Désherbez autour du pied et le long de la ligne.',
  },
  crop_stage_irrigation: {
    happeningNow: "À ce stade du cycle, la culture a besoin d'eau.",
    whatNext: "Arrosez à l'aube ou au crépuscule, et notez la quantité utilisée.",
  },
  crop_stage_flowering: {
    happeningNow: 'La culture est en floraison.',
    whatNext: 'Inspectez les fleurs et signalez tout dégât ou anomalie.',
  },
  crop_stage_fruiting: {
    happeningNow: 'Les fruits se forment et prennent du poids.',
    whatNext: 'Vérifiez les tuteurs et protégez les fruits en formation.',
  },
  crop_stage_harvest_prep: {
    happeningNow: 'Cette culture approche de la récolte.',
    whatNext:
      "Préparez les caisses, la main-d'œuvre et un acheteur avant de commencer la coupe.",
  },
  poultry_brooding: {
    happeningNow: 'Le lot est en phase de démarrage.',
    whatNext: "Maintenez la température de l'éleveuse et gardez l'aliment et l'eau à portée.",
  },
  poultry_vaccination: {
    happeningNow: 'Une vaccination est prévue pour ce lot.',
    whatNext: "Administrez la dose prévue aujourd'hui et notez le vaccin et son numéro de lot.",
  },
  poultry_litter_feed: {
    happeningNow: "Le lot est au stade où la litière et l'aliment demandent de l'attention.",
    whatNext: 'Remplacez la litière humide et passez les volailles à la ration suivante.',
  },
  poultry_closeout: {
    happeningNow: 'Ce lot approche de la fin de bande.',
    whatNext: "Pesez un échantillon, confirmez l'acheteur, et planifiez le ramassage.",
  },
  weather_rain: {
    happeningNow: 'De la pluie est attendue.',
    whatNext: "Reportez les travaux aux champs et mettez les intrants et la récolte à l'abri.",
  },
  weather_heat: {
    happeningNow: 'Une forte chaleur est attendue.',
    whatNext:
      "Donnez de l'ombre et de l'eau fraîche au bétail, et travaillez aux heures les plus fraîches.",
  },
  weather_wind: {
    happeningNow: 'Un vent fort est attendu.',
    whatNext: 'Arrimez les bâches et tuteurez les plants jeunes ou lourdement chargés.',
  },
}

const ADVISORY_YO: Record<AdvisoryReasonCode, FallbackText> = {
  crop_stage_planted: {
    happeningNow: 'Ìgbìn tuntun ń fẹsẹ̀ múlẹ̀.',
    whatNext: 'Yẹ àlàfo àti ibi tí a gbìn wọn wò, kí o sì fún wọn ní omi díẹ̀ lónìí.',
  },
  crop_stage_mulch: {
    happeningNow: 'Ọ̀gbìn náà ti dé ìpele tí mulch ti lè da omi dúró jùlọ.',
    whatNext: 'Fi mulch yí ìdí rẹ̀ ká, kí o sì fa ohunkóhun tó bá kan igi rẹ̀ kúrò.',
  },
  crop_stage_fertilize: {
    happeningNow: 'Àkókò ti tó láti fi àjílẹ̀ fún ọ̀gbìn yìí.',
    whatNext: 'Fi àjílẹ̀ tí a ṣètò sí i, kí o sì kọ ohun tí o lò sílẹ̀.',
  },
  crop_stage_weeding: {
    happeningNow: 'Ní ìpele yìí ni èpò ń bá ọ̀gbìn jà jùlọ.',
    whatNext: 'Yọ èpò kúrò ní ìdí ọ̀gbìn àti lẹ́gbẹ̀ẹ́ ìlà.',
  },
  crop_stage_irrigation: {
    happeningNow: 'Ọ̀gbìn náà nílò omi ní ìpele yìí nínú àyíká rẹ̀.',
    whatNext: 'Bomirin ní àfẹ̀mọ́júmọ́ tàbí ní ìrọ̀lẹ́, kí o sì kọ iye tí o lò sílẹ̀.',
  },
  crop_stage_flowering: {
    happeningNow: 'Ọ̀gbìn náà ń tanná.',
    whatNext: 'Yẹ àwọn ìtànná wò, kí o sì ròyìn ohunkóhun tó bàjẹ́ tàbí tí kò yẹ.',
  },
  crop_stage_fruiting: {
    happeningNow: 'Èso ń so, ó sì ń wúwo sí i.',
    whatNext: 'Yẹ àwọn igi àtìlẹ́yìn wò, kí o sì dáàbò bo àwọn èso tó ń dàgbà.',
  },
  crop_stage_harvest_prep: {
    happeningNow: 'Ọ̀gbìn yìí ti sún mọ́ ìkórè.',
    whatNext: 'Pèsè àwọn àpótí, àwọn òṣìṣẹ́, àti olùrà kí ìkórè tó bẹ̀rẹ̀.',
  },
  poultry_brooding: {
    happeningNow: 'Agbo náà wà ní àkókò ìtọ́jú ọmọ ẹyẹ.',
    whatNext: 'Jẹ́ kí ooru brooder dúró bákan náà, kí oúnjẹ àti omi sì wà nítòsí wọn.',
  },
  poultry_vaccination: {
    happeningNow: 'A ti ṣètò àjẹsára fún agbo yìí.',
    whatNext: 'Fún wọn ní ìwọ̀n tí a ṣètò lónìí, kí o sì kọ àjẹsára àti nọ́mbà ìdìpọ̀ rẹ̀ sílẹ̀.',
  },
  poultry_litter_feed: {
    happeningNow: 'Agbo náà wà ní ìpele tí litter àti oúnjẹ nílò àkíyèsí.',
    whatNext: 'Pààrọ̀ litter tútù, kí o sì yí àwọn ẹyẹ padà sí ìwọ̀n oúnjẹ tó tẹ̀lé.',
  },
  poultry_closeout: {
    happeningNow: 'Agbo yìí ti sún mọ́ ìparí àkókò rẹ̀.',
    whatNext: 'Wọ̀n díẹ̀ nínú wọn, jẹ́rìí olùrà, kí o sì ṣètò bí a ó ṣe mú wọn.',
  },
  weather_rain: {
    happeningNow: 'A ń retí òjò.',
    whatNext: 'Yí àkókò iṣẹ́ oko padà, kí o sì kó àwọn ohun èlò àti ìkórè sí ibi ààbò.',
  },
  weather_heat: {
    happeningNow: 'A ń retí ooru gbígbóná.',
    whatNext: 'Fún àwọn ẹranko ní ibòji àti omi tútù, kí o sì ṣiṣẹ́ ní àkókò tó tutù.',
  },
  weather_wind: {
    happeningNow: 'A ń retí afẹ́fẹ́ líle.',
    whatNext:
      'So àwọn ìbòrí mọ́lẹ̀, kí o sì gbé àtìlẹ́yìn fún àwọn ọ̀gbìn kékeré tàbí èyí tó ru èso wúwo.',
  },
}

const ADVISORY_PCM: Record<AdvisoryReasonCode, FallbackText> = {
  crop_stage_planted: {
    happeningNow: 'New planting dey settle down.',
    whatNext: 'Check di spacing and how dem plant am, den water am small today.',
  },
  crop_stage_mulch: {
    happeningNow: 'Di crop don reach di stage wey mulch go hold water pass.',
    whatNext: 'Put mulch round di base, den pull anything wey touch di stem comot.',
  },
  crop_stage_fertilize: {
    happeningNow: 'Dis crop don ready for feeding.',
    whatNext: 'Put di fertiliser wey dem schedule, den record wetin you use.',
  },
  crop_stage_weeding: {
    happeningNow: 'Na dis stage weed dey fight di crop pass.',
    whatNext: 'Clear weed round di base and follow di row.',
  },
  crop_stage_irrigation: {
    happeningNow: 'Di crop need water for dis part of im cycle.',
    whatNext: 'Water am for early morning or evening, den write how much you use.',
  },
  crop_stage_flowering: {
    happeningNow: 'Di crop don dey flower.',
    whatNext: 'Check di flowers, den report anything wey spoil or no normal.',
  },
  crop_stage_fruiting: {
    happeningNow: 'Fruit don dey form and dey add weight.',
    whatNext: 'Check di supports, den protect di fruit wey dey grow.',
  },
  crop_stage_harvest_prep: {
    happeningNow: 'Dis crop don near harvest.',
    whatNext: 'Arrange crate, workers, and buyer before you start to cut.',
  },
  poultry_brooding: {
    happeningNow: 'Di flock dey inside im brooding time.',
    whatNext: 'Keep di brooder heat steady, make feed and water dey near dem.',
  },
  poultry_vaccination: {
    happeningNow: 'Vaccination dey scheduled for dis flock.',
    whatNext: 'Give di dose wey dem schedule today, den record di vaccine and im batch number.',
  },
  poultry_litter_feed: {
    happeningNow: 'Di flock don reach di stage wey litter and feed need attention.',
    whatNext: 'Change di litter wey wet, den move di birds go di next feed ration.',
  },
  poultry_closeout: {
    happeningNow: 'Dis flock don near close-out.',
    whatNext: 'Weigh sample, confirm di buyer, den plan how una go catch dem.',
  },
  weather_rain: {
    happeningNow: 'Rain dey come.',
    whatNext: 'Shift di field work, den carry inputs and harvest go under shelter.',
  },
  weather_heat: {
    happeningNow: 'Serious heat dey come.',
    whatNext: 'Give di animals shade and cold water, den work for di cool hours.',
  },
  weather_wind: {
    happeningNow: 'Strong wind dey come.',
    whatNext: 'Tie di covers well, den support di young plants and di ones wey carry heavy load.',
  },
}

const ADVISORY_TABLES: Record<ReplyLocale, Partial<Record<AdvisoryReasonCode, FallbackText>>> = {
  en: ADVISORY_EN,
  fr: ADVISORY_FR,
  yo: ADVISORY_YO,
  pcm: ADVISORY_PCM,
}

const WEATHER_FR: Record<WeatherThemeId, WeatherThemeText> = {
  'rain-delay-irrigation': {
    title: "Reporter l'irrigation",
    detail: "Sautez ou réduisez l'arrosage tant que la pluie est attendue.",
  },
  'rain-protect-young': {
    title: 'Protéger les jeunes plants',
    detail:
      "Vérifiez l'engorgement des jeunes plants et des sachets de pépinière, et dégagez les drains.",
  },
  'rain-postpone-spray': {
    title: 'Reporter les pulvérisations',
    detail:
      'Attendez que les feuilles soient sèches pour pulvériser ou fertiliser, sinon la pluie lessive le produit.',
  },
  'heat-shade-livestock': {
    title: 'Ombre et eau pour le bétail',
    detail:
      "Assurez de l'ombre, de la ventilation et de l'eau fraîche dans les enclos aux heures les plus chaudes.",
  },
  'heat-irrigate-cool-hours': {
    title: 'Irriguer tôt ou tard',
    detail: "Arrosez à l'aube ou au crépuscule pour réduire le stress thermique et l'évaporation.",
  },
  'heat-electrolytes': {
    title: 'Ajouter des électrolytes',
    detail: "Mettez des électrolytes dans l'eau de boisson tant que la chaleur dure.",
  },
  'wind-secure-covers': {
    title: 'Arrimer les bâches',
    detail:
      'Attachez les filets, la toiture et tout ce qui est mal fixé autour des enclos et des magasins.',
  },
  'wind-delay-foliar': {
    title: 'Reporter la pulvérisation foliaire',
    detail:
      "Le vent emporte la pulvérisation hors cible et gaspille l'intrant — attendez qu'il tombe.",
  },
  'cold-protect-tender': {
    title: 'Protéger les plants fragiles',
    detail:
      'Couvrez les semis et les jeunes plants pendant la nuit, et gardez les jeunes animaux au chaud.',
  },
}

const WEATHER_YO: Record<WeatherThemeId, WeatherThemeText> = {
  'rain-delay-irrigation': {
    title: 'Sún ìbomirin síwájú',
    detail: 'Fo ìbomirin tàbí dín in kù níwọ̀n ìgbà tí a ti ń retí òjò.',
  },
  'rain-protect-young': {
    title: 'Dáàbò bo àwọn ọ̀gbìn kékeré',
    detail:
      'Yẹ àwọn ọ̀gbìn kékeré àti àpò nursery wò bóyá omi dúró sí wọn, kí o sì ṣí àwọn ọ̀nà ìṣàn omi.',
  },
  'rain-postpone-spray': {
    title: 'Sún spray síwájú',
    detail: 'Dúró fún spray àti àjílẹ̀ títí àwọn ewé yóò fi gbẹ, bí bẹ́ẹ̀ kọ́ òjò yóò fọ oògùn náà kúrò.',
  },
  'heat-shade-livestock': {
    title: 'Ibòji àti omi fún ẹranko',
    detail: 'Pèsè ibòji, afẹ́fẹ́, àti omi tútù nínú àgọ́ ní àkókò ooru jùlọ.',
  },
  'heat-irrigate-cool-hours': {
    title: 'Bomirin ní kùtùkùtù tàbí ní ìrọ̀lẹ́',
    detail: 'Bomirin ní àfẹ̀mọ́júmọ́ tàbí ní ìrọ̀lẹ́ kí ooru má bà wọ́n jẹ́, kí omi má sì gbẹ lọ.',
  },
  'heat-electrolytes': {
    title: 'Fi electrolyte kún omi',
    detail: 'Fi electrolyte sínú omi mímu níwọ̀n ìgbà tí ooru bá ń bá a lọ.',
  },
  'wind-secure-covers': {
    title: 'So àwọn ìbòrí mọ́lẹ̀',
    detail: 'So àwọ̀n, òrùlé, àti ohunkóhun tí kò dúró ṣinṣin mọ́lẹ̀ ní àyíká àgọ́ àti ilé ìpamọ́.',
  },
  'wind-delay-foliar': {
    title: 'Sún spray ewé síwájú',
    detail: 'Afẹ́fẹ́ máa ń gbé oògùn lọ kúrò níbi tí a fẹ́, ó sì ń fi ohun èlò ṣòfò — dúró kí ó rọlẹ̀.',
  },
  'cold-protect-tender': {
    title: 'Dáàbò bo àwọn ọ̀gbìn ẹlẹgẹ́',
    detail: 'Bo àwọn irúgbìn àti ọ̀gbìn kékeré ní òru, kí o sì jẹ́ kí àwọn ọmọ ẹranko wà nínú ooru.',
  },
}

const WEATHER_PCM: Record<WeatherThemeId, WeatherThemeText> = {
  'rain-delay-irrigation': {
    title: 'No irrigate now',
    detail: 'Skip di watering or reduce am while rain dey come.',
  },
  'rain-protect-young': {
    title: 'Protect di small plants',
    detail: 'Check small plants and nursery bags make water no stand, den clear di drains.',
  },
  'rain-postpone-spray': {
    title: 'Hold di spray',
    detail: 'Hold spray and fertiliser until leaf dry, if not rain go wash di product comot.',
  },
  'heat-shade-livestock': {
    title: 'Give animals shade and water',
    detail: 'Give di pens shade, air, and cold drinking water through di hottest hours.',
  },
  'heat-irrigate-cool-hours': {
    title: 'Water early or late',
    detail: 'Water for early morning or evening make heat no stress dem and water no dry comot.',
  },
  'heat-electrolytes': {
    title: 'Add electrolyte for water',
    detail: 'Put electrolyte inside di drinking water while di heat still dey.',
  },
  'wind-secure-covers': {
    title: 'Tie di covers well',
    detail: 'Tie down net, roofing, and anything wey loose around di pens and store.',
  },
  'wind-delay-foliar': {
    title: 'Hold di foliar spray',
    detail: 'Wind go blow di spray comot from where you want am and waste input — wait make e reduce.',
  },
  'cold-protect-tender': {
    title: 'Protect di soft plants',
    detail: 'Cover seedlings and small plants for night, den keep di young animals warm.',
  },
}

const WEATHER_TABLES: Record<ReplyLocale, Partial<Record<WeatherThemeId, WeatherThemeText>>> = {
  en: WEATHER_EN,
  fr: WEATHER_FR,
  yo: WEATHER_YO,
  pcm: WEATHER_PCM,
}

/** Last resort when a rule carries a reason code with no entry. */
const UNKNOWN_REASON: Record<ReplyLocale, FallbackText> = {
  en: {
    happeningNow: 'This crop or flock is due for attention today.',
    whatNext: 'Check it and record what you find.',
  },
  fr: {
    happeningNow: "Cette culture ou ce lot demande de l'attention aujourd'hui.",
    whatNext: 'Allez vérifier et notez ce que vous trouvez.',
  },
  yo: {
    happeningNow: 'Ohun ọ̀gbìn tàbí agbo yìí nílò àkíyèsí lónìí.',
    whatNext: 'Lọ yẹ̀ ẹ́ wò, kí o sì kọ ohun tí o rí sílẹ̀.',
  },
  pcm: {
    happeningNow: 'Dis crop or flock need attention today.',
    whatNext: 'Go check am, den write wetin you see.',
  },
}

// hasOwn, not `in`: reason codes arrive as free strings off a rule row, and
// `in` walks the prototype, so 'toString' would pass the guard and then render
// as undefined on the path that exists to never fail.
export function isAdvisoryReasonCode(value: string): value is AdvisoryReasonCode {
  return Object.hasOwn(ADVISORY_EN, value)
}

/**
 * Fallback advisory prose in the viewer's language. Unknown reason codes get the
 * generic line rather than nothing, so a rule added without a table entry still
 * says something true.
 */
export function renderAdvisoryFallback(reasonCode: string, locale: ReplyLocale): FallbackText {
  if (!isAdvisoryReasonCode(reasonCode)) return UNKNOWN_REASON[locale] ?? UNKNOWN_REASON.en
  return ADVISORY_TABLES[locale]?.[reasonCode] ?? ADVISORY_EN[reasonCode]
}

export function isWeatherThemeId(value: string): value is WeatherThemeId {
  return Object.hasOwn(WEATHER_EN, value)
}

/** Fallback weather action text, or null when the id is not a known theme. */
export function renderWeatherTheme(id: string, locale: ReplyLocale): WeatherThemeText | null {
  if (!isWeatherThemeId(id)) return null
  return WEATHER_TABLES[locale]?.[id] ?? WEATHER_EN[id]
}

export const ADVISORY_REASON_CODES = Object.keys(ADVISORY_EN) as AdvisoryReasonCode[]
export const WEATHER_THEME_IDS = Object.keys(WEATHER_EN) as WeatherThemeId[]
export const FALLBACK_LOCALES: ReplyLocale[] = ['en', 'fr', 'yo', 'pcm']
export { ADVISORY_TABLES, WEATHER_TABLES }
