import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../OpenAIUsageTracker.js", import.meta.url), "utf8");

const harness = () => {
    const storage = new Map();
    const window = { dispatchEvent() {} };
    vm.runInNewContext(source, {
        window,
        Spicetify: {
            LocalStorage: {
                get: key => storage.has(key) ? storage.get(key) : null,
                set: (key, value) => storage.set(key, value),
            },
        },
        localStorage: {
            getItem: key => storage.has(key) ? storage.get(key) : null,
            setItem: (key, value) => storage.set(key, value),
        },
        TextEncoder,
        Date,
        Map,
        Set,
        Object,
        String,
        Number,
        Math,
        JSON,
        RegExp,
        Intl,
        CustomEvent: class {
            constructor(type, init) { this.type = type; this.detail = init?.detail; }
        },
        console,
    });
    return { tracker: window.OpenAIUsageTracker, storage };
};

test("complimentary model groups and tier quotas match the configured offer", () => {
    const { tracker } = harness();
    assert.equal(tracker.classifyComplimentaryGroup("gpt-6-sol"), "standard");
    assert.equal(tracker.classifyComplimentaryGroup("gpt-5.6-sol"), "standard");
    assert.equal(tracker.classifyComplimentaryGroup("gpt-5.6-terra"), "highVolume");
    assert.equal(tracker.classifyComplimentaryGroup("gpt-5.6-luna"), "highVolume");
    assert.equal(tracker.classifyComplimentaryGroup("custom-model"), "other");

    let snapshot = tracker.getSnapshot();
    assert.equal(snapshot.complimentaryTier, "1-2");
    assert.deepEqual(
        JSON.parse(JSON.stringify(snapshot.complimentaryQuotas)),
        { standard: 250000, highVolume: 2500000 }
    );

    tracker.setComplimentaryTier("3-5");
    snapshot = tracker.getSnapshot();
    assert.deepEqual(
        JSON.parse(JSON.stringify(snapshot.complimentaryQuotas)),
        { standard: 1000000, highVolume: 10000000 }
    );
});

test("usage accounting normalizes Chat Completions and Responses fields", () => {
    const { tracker } = harness();
    tracker.recordUsage({
        model: "gpt-6-sol",
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    });
    tracker.recordUsage({
        model: "gpt-5.6-terra",
        usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250 },
    });

    const snapshot = tracker.getSnapshot();
    assert.equal(snapshot.input, 320);
    assert.equal(snapshot.output, 80);
    assert.equal(snapshot.total, 400);
    assert.equal(snapshot.byGroup.standard, 150);
    assert.equal(snapshot.byGroup.highVolume, 250);
    assert.equal(snapshot.complimentaryRemaining.standard, 249850);
    assert.equal(snapshot.complimentaryRemaining.highVolume, 2499750);
});

test("daily budget guard reserves concurrent requests and clamps output", () => {
    const { tracker } = harness();
    tracker.setDailyLimit(3500);

    const first = tracker.beginRequest({
        model: "gpt-6-sol",
        apiMode: "chat",
        body: {
            messages: [{ role: "user", content: "hello" }],
            max_completion_tokens: 4000,
        },
    });
    assert.ok(first.reservationId);
    assert.ok(first.body.max_completion_tokens > 0);
    assert.ok(first.body.max_completion_tokens < 4000);

    assert.throws(() => tracker.beginRequest({
        model: "gpt-6-sol",
        apiMode: "chat",
        body: {
            messages: [{ role: "user", content: "second" }],
            max_completion_tokens: 4000,
        },
    }), /token budget/i);

    tracker.completeRequest(first.reservationId, {
        model: "gpt-6-sol",
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    });
    assert.equal(tracker.getSnapshot().total, 300);
});

test("optional complimentary guard uses the locally tracked group quota", () => {
    const { tracker } = harness();
    tracker.setStopAtComplimentary(true);
    tracker.recordUsage({
        model: "gpt-6-sol",
        usage: { prompt_tokens: 249900, completion_tokens: 0, total_tokens: 249900 },
    });

    assert.throws(() => tracker.beginRequest({
        model: "gpt-6-sol",
        apiMode: "responses",
        body: {
            input: "a request that cannot fit in the final one hundred local tokens",
            max_output_tokens: 50,
        },
    }), /token budget/i);
});
