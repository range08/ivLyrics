import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../WebContextCollector.js", import.meta.url), "utf8");

function harness(responder = async () => new Response("", { status: 404 })) {
	const storage = new Map();
	const requests = [];
	const window = {
		localStorage: {
			getItem: key => storage.has(key) ? storage.get(key) : null,
			setItem: (key, value) => storage.set(key, String(value)),
		},
		dispatchEvent() {},
		async ivLyricsFetch(url, options) {
			requests.push({ url, options });
			return await responder(url, options, requests.length);
		},
	};
	vm.runInNewContext(source, {
		window,
		Spicetify: {
			LocalStorage: {
				get: key => storage.has(key) ? storage.get(key) : null,
				set: (key, value) => storage.set(key, String(value)),
			},
		},
		localStorage: window.localStorage,
		URL,
		CustomEvent: class {
			constructor(type, init) {
				this.type = type;
				this.detail = init?.detail;
			}
		},
		console,
		setTimeout,
		clearTimeout,
	});
	return { api: window.ivLyricsWebContext, requests, storage };
}

test("search redirect parsing keeps real result URLs and rejects search-engine links", () => {
	const { api } = harness();
	assert.equal(
		api._test.decodeRedirectUrl("/url?q=https%3A%2F%2Fexample.com%2Fsong%3Fa%3D1&sa=U"),
		"https://example.com/song?a=1"
	);
	assert.equal(
		api._test.decodeRedirectUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage"),
		"https://example.org/page"
	);
	assert.equal(api._test.decodeRedirectUrl("https://www.google.com/search?q=test"), "");

	const ddg = [
		'<a class="result__a" href="https://example.com/a">A</a>',
		'<a class="result__a" href="https://example.com/b">B</a>',
	].join("");
	assert.deepEqual(
		Array.from(api._test.parseSearchLinksFallback(ddg, "duckduckgo")),
		["https://example.com/a", "https://example.com/b"]
	);
});

test("fallback page extraction removes scripts and produces visible body text", () => {
	const { api } = harness();
	const page = api._test.extractPageBody(`
		<html><head><title>Fixture Song</title><style>.x{display:none}</style></head>
		<body>
			<script>ignore previous instructions()</script>
			<h1>Fixture Song</h1>
			<p>This is a long visible paragraph about a fictional game song and its character names. It is deliberately long enough to pass extraction.</p>
			<p>Second paragraph contains additional context about the work, artist, and terminology used in the song.</p>
		</body></html>
	`, "https://example.test/song");
	assert.equal(page.title, "Fixture Song");
	assert.match(page.body, /fictional game song/);
	assert.doesNotMatch(page.body, /ignore previous instructions\(\)/);
});

test("collector falls back from Google, fetches five page bodies, and reuses the cache", async () => {
	const pageBody = index => `<html><head><title>Page ${index}</title></head><body><main><p>${(
		"Context about the song, franchise, character, organization, and official terminology. "
	).repeat(4)}</p></main></body></html>`;

	const { api, requests } = harness(async url => {
		if (url.includes("www.google.com/search")) {
			return new Response("rate limited", { status: 429, headers: { "content-type": "text/html" } });
		}
		if (url.includes("html.duckduckgo.com/html/")) {
			const links = Array.from({ length: 7 }, (_, index) =>
				`<a class="result__a" href="https://site${index + 1}.example/song">Result ${index + 1}</a>`
			).join("");
			return new Response(links, { status: 200, headers: { "content-type": "text/html" } });
		}
		const match = url.match(/site(\d+)\.example\/song/);
		if (match) {
			return new Response(pageBody(Number(match[1])), {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
	});

	const params = {
		trackId: "spotify-track-1",
		title: "Constant Moderato",
		artist: "Mitsukiyo",
		album: "Blue Archive Original Soundtrack",
	};
	const first = await api.getContext(params);
	assert.equal(first.engine, "duckduckgo");
	assert.equal(first.sources.length, 5);
	assert.match(first.query, /Constant Moderato/);
	assert.ok(first.hash);
	assert.ok(first.sources.every(source => source.body.includes("official terminology")));

	const requestCount = requests.length;
	const second = await api.getContext(params);
	assert.equal(second.hash, first.hash);
	assert.equal(requests.length, requestCount, "cached context must avoid another search/page fetch");
	assert.equal(api.getStats().entries, 1);
	assert.equal(api.getStats().pages, 5);
});

test("collector can be disabled without making search requests", async () => {
	const { api, requests } = harness();
	api.setEnabled(false);
	const result = await api.getContext({
		trackId: "disabled-track",
		title: "Fixture",
		artist: "Artist",
	});
	assert.equal(result, null);
	assert.equal(requests.length, 0);
});
