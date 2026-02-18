import en from './en';
import es from './es';

const translations: any = { en, es };

export const getLocale = () => {
    if (typeof localStorage !== 'undefined') {
        return localStorage.getItem('agentic_lang') || 'es';
    }
    return 'es';
};

export const setLocale = (lang: string) => {
    localStorage.setItem('agentic_lang', lang);
    window.location.reload(); // Simple reload for now
};

export const t = (key: string) => {
    const lang = getLocale();
    return translations[lang][key] || key;
};

// Alpine Magic Helper
export const i18nPlugin = (Alpine: any) => {
    Alpine.magic('t', () => (key: string) => t(key));
    Alpine.store('i18n', {
        locale: getLocale(),
        setLocale(lang: string) {
            setLocale(lang);
        }
    });
};
