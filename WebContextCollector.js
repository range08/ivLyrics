/**
 * Free web context collector for ivLyrics lyric translation/pronunciation.
 *
 * Uses ordinary public search-result/page HTTP requests through Spicetify's
 * configured CORS proxy. It never calls OpenAI's paid web_search tool.
 */
(() => {
    'use strict';

    const CACHE_STORAGE_KEY = 'ivLyrics:web-context-cache';
    const ENABLED_STORAGE_KEY = 'ivLyrics:web-context:enabled';
    const DEFAULT_CORS_PROXY_TEMPLATE = 'https://cors-proxy.spicetify.app/{url}';
    const PROXY_TEMPLATE_STORAGE_KEY = 'spicetify:corsProxyTemplate';
    const CACHE_VERSION = 1;
    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_CACHE_ENTRIES = 32;
    const MAX_SEARCH_RESULTS = 12;
    const TARGET_PAGE_COUNT = 5;
    const MAX_PAGE_TEXT_CHARS = 12000;
    const MAX_TOTAL_TEXT_CHARS = 50000;
    const MIN_PAGE_TEXT_CHARS = 80;
    const SEARCH_TIMEOUT_MS = 12000;
    const PAGE_TIMEOUT_MS = 15000;
    const MAX_FETCH_CONCURRENCY = 2;
    const inflight = new Map();

    const getStorage = (key) => {
        try {
            const value = Spicetify.LocalStorage.get(key);
            if (value !== null && value !== undefined) return value;
        } catch {}
        try { return localStorage.getItem(key); } catch { return null; }
    };

    const setStorage = (key, value) => {
        const normalized = String(value);
        try {
            Spicetify.LocalStorage.set(key, normalized);
            return;
        } catch {}
        try { localStorage.setItem(key, normalized); } catch {}
    };

    const readBoolean = (key, fallback = true) => {
        const value = getStorage(key);
        if (value === null || value === undefined || value === '') return fallback;
        return value === true || value === 'true' || value === '1';
    };

    const normalizeSpace = (value) =>
        String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

    const stripTagsFallback = (html) => normalizeSpace(
        String(html || '')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/blockquote)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
    );

    const simpleHash = (value) => {
        const text = String(value || '');
        let hash = 2166136261;
        for (let index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    };

    const makeTrackKey = ({ trackId = '', title = '', artist = '', album = '' } = {}) => {
        const stable = [
            String(trackId || '').trim(),
            String(title || '').trim().toLocaleLowerCase(),
            String(artist || '').trim().toLocaleLowerCase(),
            String(album || '').trim().toLocaleLowerCase()
        ].join('\u0000');
        return 'webctx-' + simpleHash(stable);
    };

    const loadCache = () => {
        try {
            const parsed = JSON.parse(getStorage(CACHE_STORAGE_KEY) || '{}');
            if (!parsed || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
                return { version: CACHE_VERSION, entries: [] };
            }
            return {
                version: CACHE_VERSION,
                entries: parsed.entries.filter(entry => entry && typeof entry === 'object')
            };
        } catch {
            return { version: CACHE_VERSION, entries: [] };
        }
    };

    const saveCache = (cache) => {
        const now = Date.now();
        const entries = (Array.isArray(cache?.entries) ? cache.entries : [])
            .filter(entry => Number(entry?.createdAt) + CACHE_TTL_MS > now)
            .sort((left, right) => Number(right?.lastAccessed || right?.createdAt || 0) - Number(left?.lastAccessed || left?.createdAt || 0))
            .slice(0, MAX_CACHE_ENTRIES);
        setStorage(CACHE_STORAGE_KEY, JSON.stringify({ version: CACHE_VERSION, entries }));
    };

    const getCached = (params) => {
        const key = makeTrackKey(params);
        const cache = loadCache();
        const now = Date.now();
        const index = cache.entries.findIndex(entry =>
            entry.key === key &&
            Number(entry.createdAt) + CACHE_TTL_MS > now
        );
        if (index < 0) return null;
        const entry = cache.entries[index];
        entry.lastAccessed = now;
        saveCache(cache);
        return entry.context || null;
    };

    const peekCached = (params) => {
        const key = makeTrackKey(params);
        const cache = loadCache();
        const now = Date.now();
        const entry = cache.entries.find(item =>
            item.key === key &&
            Number(item.createdAt) + CACHE_TTL_MS > now
        );
        return entry?.context || null;
    };

    const setCached = (params, context) => {
        const key = makeTrackKey(params);
        const cache = loadCache();
        const now = Date.now();
        cache.entries = cache.entries.filter(entry => entry.key !== key);
        cache.entries.unshift({ key, createdAt: now, lastAccessed: now, context });
        saveCache(cache);
    };

    const getProxyTemplate = () => {
        let template = DEFAULT_CORS_PROXY_TEMPLATE;
        try {
            template = window.localStorage?.getItem(PROXY_TEMPLATE_STORAGE_KEY) || template;
        } catch {}
        if (!template.includes('{url}')) return DEFAULT_CORS_PROXY_TEMPLATE;
        return template;
    };

    const getProxiedUrl = (target) => getProxyTemplate().replace('{url}', target);

    const fetchText = async (target, timeoutMs) => {
        const response = await window.ivLyricsFetch(getProxiedUrl(target), {
            method: 'GET',
            credentials: 'omit',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1'
            }
        }, timeoutMs);
        if (!response.ok) {
            const error = new Error('Web context HTTP ' + response.status);
            error.status = response.status;
            throw error;
        }
        const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
        if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml') && !type.includes('text/plain')) {
            throw new Error('Web context skipped non-text response');
        }
        return await response.text();
    };

    const decodeRedirectUrl = (href) => {
        let value = String(href || '').trim();
        if (!value) return '';

        if (value.startsWith('//')) value = 'https:' + value;

        try {
            if (value.startsWith('/url?')) {
                const query = new URL('https://www.google.com' + value).searchParams;
                value = query.get('q') || query.get('url') || '';
            } else {
                const parsed = new URL(value);
                if (/duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/l/')) {
                    value = parsed.searchParams.get('uddg') || '';
                }
            }
        } catch {}

        try {
            const parsed = new URL(value);
            if (!/^https?:$/.test(parsed.protocol)) return '';
            const host = parsed.hostname.toLocaleLowerCase();
            if (
                host === 'google.com' || host.endsWith('.google.com') ||
                host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com') ||
                host === 'accounts.google.com'
            ) return '';
            parsed.hash = '';
            return parsed.toString();
        } catch {
            return '';
        }
    };

    const parseSearchLinksWithDom = (html, engine) => {
        if (typeof DOMParser !== 'function') return [];
        const document = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const anchors = engine === 'google'
            ? Array.from(document.querySelectorAll('a')).filter(anchor =>
                anchor.querySelector('h3') || String(anchor.getAttribute('href') || '').startsWith('/url?')
            )
            : Array.from(document.querySelectorAll('a.result__a'));
        return anchors.map(anchor => decodeRedirectUrl(anchor.getAttribute('href'))).filter(Boolean);
    };

    const parseSearchLinksFallback = (html, engine) => {
        const source = String(html || '');
        const matches = [];
        const patterns = engine === 'google'
            ? [
                /<a\b[^>]*href=["'](\/url\?[^"']+)["'][^>]*>/gi,
                /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>[\s\S]{0,500}?<h3\b/gi
            ]
            : [
                /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["']/gi,
                /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result__a[^"']*["']/gi
            ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(source)) !== null) {
                matches.push(decodeRedirectUrl(match[1]));
            }
        }
        return matches.filter(Boolean);
    };

    const uniqueUrls = (values) => {
        const output = [];
        const seen = new Set();
        for (const value of values) {
            const normalized = decodeRedirectUrl(value);
            if (!normalized) continue;
            const key = normalized.replace(/\/$/, '');
            if (seen.has(key)) continue;
            seen.add(key);
            output.push(normalized);
            if (output.length >= MAX_SEARCH_RESULTS) break;
        }
        return output;
    };

    const searchGoogle = async (query) => {
        const target = 'https://www.google.com/search?num=10&hl=en&filter=0&q=' + encodeURIComponent(query);
        const html = await fetchText(target, SEARCH_TIMEOUT_MS);
        return uniqueUrls([
            ...parseSearchLinksWithDom(html, 'google'),
            ...parseSearchLinksFallback(html, 'google')
        ]);
    };

    const searchDuckDuckGo = async (query) => {
        const target = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
        const html = await fetchText(target, SEARCH_TIMEOUT_MS);
        return uniqueUrls([
            ...parseSearchLinksWithDom(html, 'duckduckgo'),
            ...parseSearchLinksFallback(html, 'duckduckgo')
        ]);
    };

    const search = async (query) => {
        try {
            const google = await searchGoogle(query);
            if (google.length >= TARGET_PAGE_COUNT) {
                return { engine: 'google', urls: google };
            }
        } catch (error) {
            window.__ivLyricsDebugLog?.('[WebContext] Google search unavailable:', error?.message);
        }

        try {
            const duck = await searchDuckDuckGo(query);
            return { engine: 'duckduckgo', urls: duck };
        } catch (error) {
            window.__ivLyricsDebugLog?.('[WebContext] DuckDuckGo search unavailable:', error?.message);
            return { engine: 'none', urls: [] };
        }
    };

    const extractTitleWithDom = (document, fallbackUrl) =>
        normalizeSpace(
            document?.querySelector?.('meta[property="og:title"]')?.getAttribute?.('content') ||
            document?.querySelector?.('title')?.textContent ||
            fallbackUrl
        ).slice(0, 300);

    const extractPageBody = (html, url) => {
        const source = String(html || '');
        if (!source.trim()) return null;

        if (typeof DOMParser === 'function') {
            const document = new DOMParser().parseFromString(source, 'text/html');
            for (const selector of ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'form', 'nav', 'header', 'footer', 'aside']) {
                document.querySelectorAll(selector).forEach(node => node.remove());
            }

            const candidates = [
                ...document.querySelectorAll('article'),
                ...document.querySelectorAll('main'),
                ...document.querySelectorAll('[role="main"]')
            ];
            let root = document.body;
            if (candidates.length) {
                root = candidates.reduce((best, node) =>
                    normalizeSpace(node.textContent).length > normalizeSpace(best?.textContent).length ? node : best,
                candidates[0]);
            }

            const parts = Array.from(root?.querySelectorAll?.('h1,h2,h3,p,li,blockquote,dt,dd') || [])
                .map(node => normalizeSpace(node.textContent))
                .filter(text => text.length >= 20);
            let body = parts.join('\n');
            if (body.length < MIN_PAGE_TEXT_CHARS) {
                body = normalizeSpace(root?.textContent || '');
            }
            body = body.slice(0, MAX_PAGE_TEXT_CHARS).trim();
            if (body.length < MIN_PAGE_TEXT_CHARS) return null;
            return {
                url,
                title: extractTitleWithDom(document, url),
                body
            };
        }

        const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const body = stripTagsFallback(source).slice(0, MAX_PAGE_TEXT_CHARS).trim();
        if (body.length < MIN_PAGE_TEXT_CHARS) return null;
        return {
            url,
            title: stripTagsFallback(titleMatch?.[1] || url).slice(0, 300),
            body
        };
    };

    const fetchTopPages = async (urls) => {
        const results = [];
        let cursor = 0;

        const worker = async () => {
            while (results.length < TARGET_PAGE_COUNT) {
                const index = cursor++;
                if (index >= urls.length) return;
                const url = urls[index];
                try {
                    const html = await fetchText(url, PAGE_TIMEOUT_MS);
                    const page = extractPageBody(html, url);
                    if (page) results.push({ index, ...page });
                } catch (error) {
                    window.__ivLyricsDebugLog?.('[WebContext] Page fetch failed:', url, error?.message);
                }
            }
        };

        await Promise.all(Array.from(
            { length: Math.min(MAX_FETCH_CONCURRENCY, Math.max(1, urls.length)) },
            () => worker()
        ));

        let total = 0;
        return results
            .sort((left, right) => left.index - right.index)
            .slice(0, TARGET_PAGE_COUNT)
            .map(page => {
                const remaining = Math.max(0, MAX_TOTAL_TEXT_CHARS - total);
                const body = page.body.slice(0, remaining);
                total += body.length;
                return { url: page.url, title: page.title, body };
            })
            .filter(page => page.body.length >= MIN_PAGE_TEXT_CHARS);
    };

    const buildQuery = ({ title = '', artist = '', album = '' } = {}) =>
        [String(title || '').trim(), String(artist || '').trim(), String(album || '').trim()]
            .filter(Boolean)
            .map(value => '"' + value.replace(/"/g, '') + '"')
            .join(' ');

    const buildContextHash = (context) => simpleHash(JSON.stringify({
        engine: context?.engine || '',
        sources: (context?.sources || []).map(source => ({
            url: source.url,
            title: source.title,
            body: source.body
        }))
    }));

    const collect = async (params = {}) => {
        const query = buildQuery(params);
        if (!query) return { engine: 'none', query: '', sources: [], hash: 'empty' };

        const searched = await search(query);
        const sources = await fetchTopPages(searched.urls);
        const context = {
            engine: searched.engine,
            query,
            sources,
            fetchedAt: Date.now()
        };
        context.hash = buildContextHash(context);
        return context;
    };

    const getContext = async (params = {}) => {
        if (!readBoolean(ENABLED_STORAGE_KEY, true)) return null;

        const cached = getCached(params);
        if (cached) return cached;

        const key = makeTrackKey(params);
        if (inflight.has(key)) return inflight.get(key);

        const promise = collect(params)
            .then(context => {
                if (context?.sources?.length) setCached(params, context);
                return context;
            })
            .catch(error => {
                window.__ivLyricsDebugLog?.('[WebContext] Collection failed:', error?.message);
                return null;
            })
            .finally(() => inflight.delete(key));

        inflight.set(key, promise);
        return promise;
    };

    const clearCache = () => {
        setStorage(CACHE_STORAGE_KEY, JSON.stringify({ version: CACHE_VERSION, entries: [] }));
        try {
            window.dispatchEvent(new CustomEvent('ivLyrics:web-context-cache-cleared'));
        } catch {}
    };

    const getStats = () => {
        const cache = loadCache();
        const now = Date.now();
        const entries = cache.entries.filter(entry => Number(entry?.createdAt) + CACHE_TTL_MS > now);
        return {
            entries: entries.length,
            pages: entries.reduce((sum, entry) => sum + (entry?.context?.sources?.length || 0), 0)
        };
    };

    const setEnabled = (enabled) => {
        setStorage(ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
    };

    window.ivLyricsWebContext = Object.freeze({
        getContext,
        peekContext: peekCached,
        peekHash(params = {}) {
            return peekCached(params)?.hash || '';
        },
        clearCache,
        getStats,
        isEnabled: () => readBoolean(ENABLED_STORAGE_KEY, true),
        setEnabled,
        constants: Object.freeze({
            targetPageCount: TARGET_PAGE_COUNT,
            cacheTtlMs: CACHE_TTL_MS,
            maxPageTextChars: MAX_PAGE_TEXT_CHARS,
            maxTotalTextChars: MAX_TOTAL_TEXT_CHARS
        }),
        _test: Object.freeze({
            decodeRedirectUrl,
            parseSearchLinksFallback,
            extractPageBody,
            buildQuery,
            simpleHash
        })
    });
})();
