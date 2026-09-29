/**
 * OpenAI usage accounting and local daily budget guard for ivLyrics.
 * Tracks only successful OpenAI requests made by this client.
 */
(() => {
    "use strict";

    const PREFIX = "ivLyrics:openai-usage:";
    const DAY_STATE_KEY = PREFIX + "daily-state";
    const DAILY_LIMIT_KEY = PREFIX + "daily-limit";
    const COMPLIMENTARY_ENABLED_KEY = PREFIX + "complimentary-enabled";
    const COMPLIMENTARY_TIER_KEY = PREFIX + "complimentary-tier";
    const STOP_AT_COMPLIMENTARY_KEY = PREFIX + "stop-at-complimentary";
    const reservations = new Map();
    let reservationSequence = 0;

    const getStorage = (key) => {
        try {
            if (window.ivLyricsStoragePersistence?.getItem) {
                const value = window.ivLyricsStoragePersistence.getItem(key);
                if (value !== null && value !== undefined) return value;
            }
        } catch {}
        try {
            return Spicetify.LocalStorage.get(key);
        } catch {
            try { return localStorage.getItem(key); } catch { return null; }
        }
    };

    const setStorage = (key, value) => {
        const normalized = String(value);
        try {
            if (window.ivLyricsStoragePersistence?.setItem) {
                window.ivLyricsStoragePersistence.setItem(key, normalized);
                return;
            }
        } catch {}
        try {
            Spicetify.LocalStorage.set(key, normalized);
            return;
        } catch {}
        try { localStorage.setItem(key, normalized); } catch {}
    };

    const utcDay = () => new Date().toISOString().slice(0, 10);
    const toNonNegativeInt = (value, fallback = 0) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
    };

    const readBoolean = (key, fallback) => {
        const value = getStorage(key);
        if (value === null || value === undefined || value === "") return fallback;
        return value === true || value === "true" || value === "1";
    };

    const makeState = () => ({
        day: utcDay(),
        input: 0,
        output: 0,
        total: 0,
        byGroup: { standard: 0, highVolume: 0, other: 0 },
        byModel: {}
    });

    const normalizeState = (value) => {
        if (!value || typeof value !== "object" || value.day !== utcDay()) return makeState();
        const byModel = value.byModel && typeof value.byModel === "object" && !Array.isArray(value.byModel)
            ? Object.fromEntries(Object.entries(value.byModel).map(([key, amount]) => [key, toNonNegativeInt(amount)]))
            : {};
        return {
            day: value.day,
            input: toNonNegativeInt(value.input),
            output: toNonNegativeInt(value.output),
            total: toNonNegativeInt(value.total),
            byGroup: {
                standard: toNonNegativeInt(value.byGroup?.standard),
                highVolume: toNonNegativeInt(value.byGroup?.highVolume),
                other: toNonNegativeInt(value.byGroup?.other)
            },
            byModel
        };
    };

    const loadState = () => {
        try {
            return normalizeState(JSON.parse(getStorage(DAY_STATE_KEY) || "null"));
        } catch {
            return makeState();
        }
    };

    const saveState = (state) => {
        setStorage(DAY_STATE_KEY, JSON.stringify(normalizeState(state)));
    };

    const emit = (detail) => {
        try {
            window.dispatchEvent(new CustomEvent("ivLyrics:openai-usage-updated", { detail }));
        } catch {}
    };

    const classifyComplimentaryGroup = (model) => {
        const id = String(model || "").trim().toLowerCase();
        if (!id) return "other";

        if (
            /^gpt-5\.6-(?:terra|luna)(?:-|$)/.test(id) ||
            /^gpt-5\.4-(?:mini|nano)(?:-|$)/.test(id) ||
            /^gpt-5\.1-codex-mini(?:-|$)/.test(id) ||
            /^gpt-5-(?:mini|nano)(?:-|$)/.test(id) ||
            /^gpt-4\.1-(?:mini|nano)(?:-|$)/.test(id) ||
            /^gpt-4o-mini(?:-|$)/.test(id) ||
            /^o4-mini(?:-|$)/.test(id) ||
            /^o1-mini(?:-|$)/.test(id) ||
            /^codex-mini-latest$/.test(id)
        ) {
            return "highVolume";
        }

        if (
            /^gpt-6-(?:astra|sol|luna)(?:-|$)/.test(id) ||
            /^gpt-5\.6-sol(?:-|$)/.test(id) ||
            /^gpt-5\.5(?:-|$)/.test(id) ||
            /^gpt-5\.4(?:-|$)/.test(id) ||
            /^gpt-5\.2(?:-|$)/.test(id) ||
            /^gpt-5\.1(?:-|$)/.test(id) ||
            /^gpt-5-codex(?:-|$)/.test(id) ||
            /^gpt-5(?:-|$)/.test(id) ||
            /^gpt-4\.1(?:-|$)/.test(id) ||
            /^gpt-4o(?:-|$)/.test(id) ||
            /^o3(?:-|$)/.test(id) ||
            /^o1(?:-|$)/.test(id)
        ) {
            return "standard";
        }

        return "other";
    };

    const getTier = () => getStorage(COMPLIMENTARY_TIER_KEY) === "3-5" ? "3-5" : "1-2";
    const getComplimentaryQuotas = () => getTier() === "3-5"
        ? { standard: 1000000, highVolume: 10000000 }
        : { standard: 250000, highVolume: 2500000 };

    const normalizeUsage = (usage) => {
        if (!usage || typeof usage !== "object") return null;
        const input = toNonNegativeInt(usage.input_tokens ?? usage.prompt_tokens);
        const output = toNonNegativeInt(usage.output_tokens ?? usage.completion_tokens);
        const total = toNonNegativeInt(usage.total_tokens, input + output);
        if (total <= 0 && input <= 0 && output <= 0) return null;
        return { input, output, total: total || input + output };
    };

    const getReserved = (group = null) => {
        let total = 0;
        for (const reservation of reservations.values()) {
            if (!group || reservation.group === group) total += reservation.amount;
        }
        return total;
    };

    const estimateInputUpperBound = (body) => {
        let serialized = "";
        try {
            serialized = JSON.stringify({
                messages: body?.messages,
                instructions: body?.instructions,
                input: body?.input,
                tools: body?.tools
            });
        } catch {
            serialized = String(body || "");
        }
        try {
            return new TextEncoder().encode(serialized).length + 256;
        } catch {
            return serialized.length * 4 + 256;
        }
    };

    const getMaxOutputField = (body, apiMode) => {
        if (apiMode === "responses") {
            return ["max_output_tokens", toNonNegativeInt(body?.max_output_tokens, 16000)];
        }
        if (body?.max_completion_tokens !== undefined) {
            return ["max_completion_tokens", toNonNegativeInt(body.max_completion_tokens, 16000)];
        }
        return ["max_tokens", toNonNegativeInt(body?.max_tokens, 16000)];
    };

    const getDailyLimit = () => toNonNegativeInt(getStorage(DAILY_LIMIT_KEY));
    const isComplimentaryEnabled = () => readBoolean(COMPLIMENTARY_ENABLED_KEY, true);
    const shouldStopAtComplimentary = () => readBoolean(STOP_AT_COMPLIMENTARY_KEY, false);

    const getSnapshot = () => {
        const state = loadState();
        const quotas = getComplimentaryQuotas();
        return {
            ...state,
            dailyLimit: getDailyLimit(),
            complimentaryEnabled: isComplimentaryEnabled(),
            complimentaryTier: getTier(),
            complimentaryQuotas: quotas,
            complimentaryRemaining: {
                standard: Math.max(0, quotas.standard - state.byGroup.standard),
                highVolume: Math.max(0, quotas.highVolume - state.byGroup.highVolume)
            },
            reserved: getReserved(),
            resetAtUtc: state.day + "T24:00:00Z"
        };
    };

    const setDailyLimit = (value) => {
        setStorage(DAILY_LIMIT_KEY, String(toNonNegativeInt(value)));
        emit(getSnapshot());
    };

    const setComplimentaryEnabled = (enabled) => {
        setStorage(COMPLIMENTARY_ENABLED_KEY, enabled ? "true" : "false");
        emit(getSnapshot());
    };

    const setComplimentaryTier = (tier) => {
        setStorage(COMPLIMENTARY_TIER_KEY, tier === "3-5" ? "3-5" : "1-2");
        emit(getSnapshot());
    };

    const setStopAtComplimentary = (enabled) => {
        setStorage(STOP_AT_COMPLIMENTARY_KEY, enabled ? "true" : "false");
        emit(getSnapshot());
    };

    const recordUsage = ({ model, usage } = {}) => {
        const normalized = normalizeUsage(usage);
        if (!normalized) return getSnapshot();

        const state = loadState();
        const group = classifyComplimentaryGroup(model);
        state.input += normalized.input;
        state.output += normalized.output;
        state.total += normalized.total;
        state.byGroup[group] = toNonNegativeInt(state.byGroup[group]) + normalized.total;
        const modelId = String(model || "unknown");
        state.byModel[modelId] = toNonNegativeInt(state.byModel[modelId]) + normalized.total;
        saveState(state);
        const snapshot = getSnapshot();
        emit(snapshot);
        return snapshot;
    };

    const beginRequest = ({ model, body, apiMode = "chat" } = {}) => {
        const nextBody = { ...(body || {}) };
        const state = loadState();
        const group = classifyComplimentaryGroup(model);
        const dailyLimit = getDailyLimit();
        const quota = getComplimentaryQuotas()[group] || 0;

        let available = Number.POSITIVE_INFINITY;
        if (dailyLimit > 0) {
            available = Math.min(available, dailyLimit - state.total - getReserved());
        }
        if (isComplimentaryEnabled() && shouldStopAtComplimentary() && quota > 0) {
            available = Math.min(
                available,
                quota - toNonNegativeInt(state.byGroup[group]) - getReserved(group)
            );
        }

        if (!Number.isFinite(available)) {
            return { body: nextBody, reservationId: null };
        }
        if (available <= 0) {
            const error = new Error("[ChatGPT] Daily token budget reached. OpenAI requests are paused until 00:00 UTC or the limit is changed.");
            error.code = "IVLYRICS_DAILY_TOKEN_LIMIT";
            throw error;
        }

        const estimatedInput = estimateInputUpperBound(nextBody);
        const [outputField, requestedOutput] = getMaxOutputField(nextBody, apiMode);
        const availableOutput = Math.floor(available - estimatedInput);
        if (availableOutput < 1) {
            const error = new Error("[ChatGPT] Not enough daily token budget remains for another request.");
            error.code = "IVLYRICS_DAILY_TOKEN_LIMIT";
            throw error;
        }

        const outputLimit = Math.max(1, Math.min(requestedOutput || 16000, availableOutput));
        nextBody[outputField] = outputLimit;
        const amount = estimatedInput + outputLimit;
        const reservationId = "openai-" + Date.now() + "-" + (++reservationSequence);
        reservations.set(reservationId, { amount, group });
        emit(getSnapshot());
        return { body: nextBody, reservationId };
    };

    const cancelRequest = (reservationId) => {
        if (reservationId) reservations.delete(reservationId);
        emit(getSnapshot());
    };

    const completeRequest = (reservationId, { model, usage } = {}) => {
        if (reservationId) reservations.delete(reservationId);
        return recordUsage({ model, usage });
    };

    const resetToday = () => {
        saveState(makeState());
        reservations.clear();
        const snapshot = getSnapshot();
        emit(snapshot);
        return snapshot;
    };

    window.OpenAIUsageTracker = Object.freeze({
        classifyComplimentaryGroup,
        getSnapshot,
        getDailyLimit,
        setDailyLimit,
        isComplimentaryEnabled,
        setComplimentaryEnabled,
        getComplimentaryTier: getTier,
        setComplimentaryTier,
        shouldStopAtComplimentary,
        setStopAtComplimentary,
        normalizeUsage,
        recordUsage,
        beginRequest,
        cancelRequest,
        completeRequest,
        resetToday
    });
})();
