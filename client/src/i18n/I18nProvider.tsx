/**
 * English-only i18n for the dashboard: one dictionary, bundled eagerly.
 * Kept as a provider so components use the same `t()` lookup API.
 */
import { useEffect, useMemo, type ReactNode } from 'react'

import en from './locales/en.json'
import { I18nContext, type I18nContextValue } from './context'
import { DEFAULT_LOCALE, type Locale } from './locale-config'

type Dictionary = Record<string, unknown>

function lookup(dictionary: Dictionary, key: string): unknown {
  const segments = key.split('.')
  let current: unknown = dictionary
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in (current as Dictionary)) {
      current = (current as Dictionary)[segment]
    } else {
      return undefined
    }
  }
  return current
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars[name]
    return value === undefined || value === null ? `{${name}}` : String(value)
  })
}

export interface I18nProviderProps {
  children: ReactNode
  initialLocale?: Locale
}

export function I18nProvider({ children }: I18nProviderProps) {
  useEffect(() => {
    document.documentElement.lang = 'en'
    document.documentElement.dir = 'ltr'
  }, [])

  const value = useMemo<I18nContextValue>(() => ({
    locale: DEFAULT_LOCALE,
    setLocale: () => {},
    t: (key, vars) => {
      const raw = lookup(en as Dictionary, key)
      if (typeof raw === 'string') return interpolate(raw, vars)
      return key
    },
  }), [])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
