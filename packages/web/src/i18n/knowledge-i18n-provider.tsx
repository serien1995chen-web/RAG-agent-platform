'use client';

import i18next from 'i18next';
import { useCallback, useEffect, type ReactNode } from 'react';
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next';
import { ENUM_MESSAGE_KEYS, messages } from './messages';

export type KnowledgeLocale = 'zh-CN' | 'en';

const LOCALE_STORAGE_KEY = 'kb.locale';

const knowledgeI18n = i18next.createInstance();
void knowledgeI18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: messages['zh-CN'] },
    en: { translation: messages.en },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  supportedLngs: ['zh-CN', 'en'],
  initImmediate: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function normalizeLocale(value: string | undefined): KnowledgeLocale {
  return value === 'en' ? 'en' : 'zh-CN';
}

export function KnowledgeI18nProvider(props: { children: ReactNode }) {
  useEffect(() => {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') {
      void knowledgeI18n.changeLanguage(stored);
    }
    const syncDocumentLocale = () => {
      document.documentElement.lang = normalizeLocale(knowledgeI18n.resolvedLanguage);
    };
    syncDocumentLocale();
    knowledgeI18n.on('languageChanged', syncDocumentLocale);
    return () => {
      knowledgeI18n.off('languageChanged', syncDocumentLocale);
    };
  }, []);

  return <I18nextProvider i18n={knowledgeI18n}>{props.children}</I18nextProvider>;
}

export function useKnowledgeI18n() {
  const { t, i18n } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const setLocale = useCallback(
    (nextLocale: KnowledgeLocale) => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
      document.documentElement.lang = nextLocale;
      void i18n.changeLanguage(nextLocale);
    },
    [i18n],
  );
  return { locale, setLocale, t };
}

export function useKnowledgeEnumLabel() {
  const { t } = useKnowledgeI18n();
  return useCallback(
    (value: string) => {
      const key = ENUM_MESSAGE_KEYS[value];
      return key ? t(key) : value;
    },
    [t],
  );
}
