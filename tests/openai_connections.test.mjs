import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../Addon_AI_ChatGPT.js', import.meta.url), 'utf8');
const backup = (id, enabled = true) => ({ id, name: id, baseUrl: `https://${id}.test/v1`, apiKeys: `${id}-key`, model: `${id}-model`, enabled });
const json = (status, value) => new Response(JSON.stringify(value), { status });
const success = text => json(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });

test('connection credentials stay outside cloud settings', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const helpers = index.slice(index.indexOf('const CLOUD_SYNC_EXCLUDED_STORAGE_KEYS ='), index.indexOf('try {\n  const savedStorageKeys'));
    const context = { APP_NAME: 'ivLyrics', TRACK_SYNC_OFFSETS_STORAGE_KEY: 'ivLyrics:track-sync-offsets',
        CURRENT_STORAGE_PREFIX: 'ivLyrics:', PRIVATE_OR_TRANSIENT_STORAGE_KEYS: new Set() };
    vm.runInNewContext(`${helpers}\nglobalThis.allowed = isCloudSyncSettingKey;`, context);
    assert.equal(context.allowed('ivLyrics:ai:addon:chatgpt:fallback-providers'), false);
    assert.equal(context.allowed('ivLyrics:ai:addon:chatgpt:api-keys'), false);
    assert.equal(context.allowed('ivLyrics:ai:addon:chatgpt:model'), true);
});

function harness(connections, responder, extra = {}) {
    let addon;
    const requests = [];
    const settings = new Map(Object.entries({ 'api-keys': 'primary-key', 'base-url': 'https://primary.test/v1', model: 'primary-model', 'fallback-providers': connections, ...extra }));
    const window = {
        AIAddonManager: {
            register(value) { addon = value; },
            getAddonSetting: (_id, key, fallback) => settings.get(key) ?? fallback,
            setAddonSetting: (_id, key, value) => settings.set(key, value),
            getProviderRequestAttempts: () => 1,
        },
        async ivLyricsFetch(url, options) {
            const request = { url, headers: options.headers, body: JSON.parse(options.body) };
            requests.push(request);
            return responder(request, requests.length);
        },
    };
    vm.runInNewContext(source.replace('    registerAddon();',
        '    window.hooks = { getProviderConnections, callChatGPTAPIRaw, callChatGPTAPIStream, callResponsesAPIStream };\n    registerAddon();'),
    { window, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout, console });
    return { addon, requests, settings, hooks: window.hooks };
}

test('primary connection accepts the advertised key formats', () => {
    for (const keys of ['first\nsecond', ' ["first", "second"] ', ['first', 'second']]) {
        const h = harness([], () => success('OK'), { 'api-keys': keys });
        assert.deepEqual(Array.from(h.hooks.getProviderConnections()[0].apiKeys), ['first', 'second']);
    }
});

test('legacy primary remains first; disabled connections are skipped and success stops the chain', async () => {
    const h = harness([backup('disabled', false), backup('second'), backup('third')], request =>
        request.url.includes('primary') ? json(401, { error: { message: 'Invalid API key' } }) : success('OK'));
    await h.addon.testConnection();
    assert.deepEqual(h.requests.map(r => r.url), ['https://primary.test/v1/chat/completions', 'https://second.test/v1/chat/completions']);
    assert.deepEqual(h.requests.map(r => [r.headers.Authorization, r.body.model]), [['Bearer primary-key', 'primary-model'], ['Bearer second-key', 'second-model']]);
    assert.equal(h.settings.get('base-url'), 'https://primary.test/v1');
});

test('empty primary configuration still reaches a configured additional connection', async () => {
    const h = harness([backup('second')], () => success('OK'), { 'api-keys': '', model: '' });
    await h.addon.testConnection();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.model, 'second-model');
});

for (const failure of ['timeout', 'quota', 'server', 'empty', 'invalid-json']) {
    test(`${failure} falls through in the saved order`, async () => {
        const h = harness([backup('second'), backup('third')], request => {
            if (!request.url.includes('primary')) return success('{"ok":true}');
            if (failure === 'timeout') throw new DOMException('Request timed out', 'AbortError');
            if (failure === 'quota') return json(429, {});
            if (failure === 'server') return json(503, {});
            if (failure === 'empty') return success('');
            return success('not json');
        });
        assert.deepEqual(await h.hooks.callChatGPTAPIRaw('fixture', 1, JSON.parse), { ok: true });
        assert.equal(h.requests.length, 2);
    });
}

test('exhausted connections propagate an error rather than reporting success', async () => {
    const h = harness([backup('second')], () => json(503, { error: { message: 'server unavailable' } }));
    await assert.rejects(h.addon.testConnection(), /server unavailable/);
    assert.equal(h.requests.length, 2);
});

test('stream fallback resets failed provisional output before the next connection', async () => {
    const trace = [];
    const h = harness([backup('second')], request => {
        const primary = request.url.includes('primary');
        const event = { choices: [{ delta: { content: primary ? 'wrong\n' : 'correct\n' }, finish_reason: primary ? null : 'stop' }] };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const result = await h.hooks.callChatGPTAPIStream('fixture', (i, value) => trace.push(value), () => trace.push('RESET'), 1);
    assert.equal(result, 'correct\n');
    assert.ok(trace.indexOf('RESET') > trace.indexOf('wrong'));
    assert.ok(trace.indexOf('correct') > trace.indexOf('RESET'));
    assert.equal(h.requests[1].body.model, 'second-model');
});

test('research Responses API uses each connection model and URL', async () => {
    const h = harness([backup('second')], request => {
        if (request.url.includes('primary')) return json(404, { error: { message: 'unsupported' } });
        const events = [
            { type: 'response.output_text.delta', delta: '{"ok":true}' },
            { type: 'response.completed', response: { status: 'completed' } },
        ];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const result = await h.hooks.callResponsesAPIStream('fixture', null, null, 1, JSON.parse);
    assert.deepEqual(result, { ok: true });
    assert.equal(h.requests[1].url, 'https://second.test/v1/responses');
    assert.equal(h.requests[1].body.model, 'second-model');
});

test('concurrent requests keep their own credentials and ordered connection snapshots', async () => {
    const h = harness([backup('second')], async request => {
        await new Promise(resolve => setImmediate(resolve));
        if (request.url.includes('primary') && request.body.messages[0].content === 'first') return json(500, {});
        return success(request.headers.Authorization + ':' + request.body.model);
    });
    const [first, second] = await Promise.all([h.hooks.callChatGPTAPIRaw('first'), h.hooks.callChatGPTAPIRaw('second')]);
    assert.equal(first, 'Bearer second-key:second-model');
    assert.equal(second, 'Bearer primary-key:primary-model');
});


test('per-task reasoning controls map to Chat Completions and Responses request fields', async () => {
    {
        const h = harness([], () => success('translated'), {
            model: 'gpt-6-sol',
            'adv-reasoning-translation': 'low',
        });
        const result = await h.addon.translateLyrics({
            text: 'source',
            translationPrompt: { systemPrompt: 'translate', userPrompt: 'source' },
            wantSmartPhonetic: false,
        });
        assert.deepEqual(Array.from(result.translation), ['translated']);
        assert.equal(h.requests[0].body.reasoning_effort, 'low');
    }

    {
        const h = harness([], () => success('pronounced'), {
            model: 'gpt-6-sol',
            'adv-reasoning-pronunciation': 'high',
        });
        const result = await h.addon.translateLyrics({
            text: 'source',
            phoneticPrompt: { systemPrompt: 'pronounce', userPrompt: 'source' },
            wantSmartPhonetic: true,
        });
        assert.deepEqual(Array.from(result.phonetic), ['pronounced']);
        assert.equal(h.requests[0].body.reasoning_effort, 'high');
    }

    {
        const h = harness([], () => json(200, {
            output: [{ content: [{ type: 'output_text', text: '{"summary":"researched"}' }] }],
        }), {
            model: 'gpt-6-sol',
            'adv-reasoning-research': 'medium',
        });
        const result = await h.addon.generateTMI({
            title: 'Fixture title',
            artist: 'Fixture artist',
            tmiPrompt: 'research fixture',
            webSearch: true,
        });
        assert.equal(result.summary, 'researched');
        assert.equal(h.requests[0].body.reasoning.effort, 'medium');
        assert.equal(h.requests[0].body.reasoning_effort, undefined);
    }
});

test('Default preserves provider defaults, while None explicitly disables reasoning', async () => {
    const providerDefault = harness([], () => success('translated'), {
        model: 'gpt-6-sol',
        'adv-reasoning-translation': 'default',
    });
    await providerDefault.addon.translateLyrics({
        text: 'source',
        translationPrompt: { systemPrompt: 'translate', userPrompt: 'source' },
        wantSmartPhonetic: false,
    });
    assert.equal(providerDefault.requests[0].body.reasoning_effort, undefined);

    const explicitNone = harness([], () => success('translated'), {
        model: 'gpt-6-sol',
        'adv-reasoning-translation': 'none',
    });
    await explicitNone.addon.translateLyrics({
        text: 'source',
        translationPrompt: { systemPrompt: 'translate', userPrompt: 'source' },
        wantSmartPhonetic: false,
    });
    assert.equal(explicitNone.requests[0].body.reasoning_effort, 'none');

    const legacyModel = harness([], () => success('translated'), {
        model: 'gpt-4o',
        'adv-reasoning-translation': 'high',
    });
    await legacyModel.addon.translateLyrics({
        text: 'source',
        translationPrompt: { systemPrompt: 'translate', userPrompt: 'source' },
        wantSmartPhonetic: false,
    });
    assert.equal(legacyModel.requests[0].body.reasoning_effort, undefined);
});

test('Advanced Body Merge JSON has final precedence over per-task reasoning controls', async () => {
    const h = harness([], () => success('translated'), {
        model: 'gpt-6-sol',
        'adv-reasoning-translation': 'low',
        'adv-requestBodyMergeJson': JSON.stringify({
            reasoning_effort: 'high',
            max_completion_tokens: 1234,
        }),
    });
    await h.addon.translateLyrics({
        text: 'source',
        translationPrompt: { systemPrompt: 'translate', userPrompt: 'source' },
        wantSmartPhonetic: false,
    });
    assert.equal(h.requests[0].body.reasoning_effort, 'high');
    assert.equal(h.requests[0].body.max_completion_tokens, 1234);
});


test('official OpenAI requests expose streaming usage and report successful token counts', async () => {
    let addon;
    const calls = [];
    const completed = [];
    const cancelled = [];
    const settings = new Map(Object.entries({
        'api-keys': 'official-key',
        'base-url': 'https://api.openai.com/v1',
        model: 'gpt-6-sol',
        'fallback-providers': [],
    }));
    const tracker = {
        beginRequest({ body }) {
            calls.push({ type: 'begin', body: JSON.parse(JSON.stringify(body)) });
            return { body, reservationId: 'reservation-1' };
        },
        completeRequest(id, detail) {
            completed.push({ id, detail: JSON.parse(JSON.stringify(detail)) });
        },
        cancelRequest(id) {
            cancelled.push(id);
        },
    };
    const window = {
        OpenAIUsageTracker: tracker,
        AIAddonManager: {
            register(value) { addon = value; },
            getAddonSetting: (_id, key, fallback) => settings.get(key) ?? fallback,
            setAddonSetting: (_id, key, value) => settings.set(key, value),
            getProviderRequestAttempts: () => 1,
        },
        async ivLyricsFetch(_url, options) {
            const body = JSON.parse(options.body);
            assert.equal(body.stream, true);
            assert.equal(body.stream_options.include_usage, true);
            const events = [
                { choices: [{ delta: { content: 'translated' }, finish_reason: 'stop' }] },
                { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
            ];
            return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
                headers: { 'Content-Type': 'text/event-stream' },
            });
        },
    };
    vm.runInNewContext(source.replace(
        '    registerAddon();',
        '    window.hooks = { callChatGPTAPIStream };\n    registerAddon();'
    ), { window, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout, console });

    const result = await window.hooks.callChatGPTAPIStream('fixture', null, null, 1);
    assert.equal(result, 'translated');
    assert.equal(calls.length, 1);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].id, 'reservation-1');
    assert.deepEqual(completed[0].detail, {
        model: 'gpt-6-sol',
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    assert.deepEqual(cancelled, []);
    assert.ok(addon);
});
