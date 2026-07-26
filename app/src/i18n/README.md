# App i18n

UI copy uses [vue-i18n](https://vue-i18n.intlify.dev/). Prefer `t('namespace.key')` in views.

## Layout

- `index.ts` — locale persistence + `createI18n`
- `locales/en.ts`, `yo.ts`, `pcm.ts`, `fr.ts` — message catalogs (one file per language)

When adding strings: update **all four** locale files under the same namespace (e.g. `users.delete`).
