import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const panelSource = readFileSync(new URL("../NowPlayingPanelLyrics.js", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../style.css", import.meta.url), "utf8");
const shareSource = readFileSync(new URL("../LyricsShareImage.js", import.meta.url), "utf8");

const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, "missing section: " + startMarker);
    return source.slice(start, end);
};

test("Now Playing gradient blobs animate on compositor transforms instead of layout properties", () => {
    const blobCss = slice(panelSource, ".ivlyrics-panel-bg-blob {", ".ivlyrics-panel-header,");
    assert.doesNotMatch(
        slice(blobCss, "@keyframes ivlyrics-panel-blob-1", ".ivlyrics-panel-lyrics-section.playback-paused"),
        /(?:^|[;{]\s*)(?:top|left)\s*:/m
    );
    assert.match(blobCss, /will-change:\s*transform;/);
    assert.doesNotMatch(
        slice(blobCss, ".ivlyrics-panel-bg-blob {", ".ivlyrics-panel-bg-blob.blob-1"),
        /will-change:\s*[^;]*filter/
    );
    assert.match(blobCss, /playback-paused[\s\S]*animation-play-state:\s*paused/);
    assert.match(blobCss, /prefers-reduced-motion[\s\S]*animation-play-state:\s*paused/);
});

test("fullscreen artwork reserves will-change only during crossfade", () => {
    const fallbackCss = slice(
        styleSource,
        ".ivlyrics-video-background-fallback {",
        "@keyframes ivlyricsBackgroundFallbackIn"
    );
    const base = slice(
        fallbackCss,
        ".ivlyrics-video-background-fallback {",
        ".ivlyrics-video-background-fallback-incoming"
    );
    assert.doesNotMatch(base, /will-change\s*:/);
    assert.match(fallbackCss, /fallback-incoming[\s\S]*will-change:\s*opacity, transform/);
    assert.match(fallbackCss, /fallback-outgoing[\s\S]*will-change:\s*opacity/);
});

test("share-image color extraction reuses one decoded album image", async () => {
    let imageCount = 0;
    const contextOptions = [];
    const pixels = new Uint8ClampedArray(50 * 50 * 4);
    for (let index = 0; index < pixels.length; index += 4) {
        pixels[index] = 100;
        pixels[index + 1] = 140;
        pixels[index + 2] = 180;
        pixels[index + 3] = 255;
    }

    class FakeImage {
        constructor() {
            imageCount += 1;
            this.width = 640;
            this.height = 640;
        }
        set src(value) {
            this._src = value;
            queueMicrotask(() => this.onload?.());
        }
        get src() {
            return this._src;
        }
    }

    const document = {
        createElement(type) {
            assert.equal(type, "canvas");
            return {
                width: 0,
                height: 0,
                getContext(_kind, options) {
                    contextOptions.push(options || null);
                    return {
                        drawImage() {},
                        getImageData() { return { data: pixels }; },
                    };
                },
            };
        },
    };
    const window = {};
    vm.runInNewContext(shareSource, {
        window,
        document,
        Image: FakeImage,
        navigator: {},
        console,
        queueMicrotask,
        Uint8ClampedArray,
        Object,
        Map,
        Promise,
        Math,
    });

    const url = "https://i.scdn.co/image/test";
    const [first, second] = await Promise.all([
        window.LyricsShareImage.extractColors(url),
        window.LyricsShareImage.extractColors(url),
    ]);

    assert.equal(imageCount, 1, "the same cover must be decoded once and reused");
    assert.equal(first.primary, "rgb(100, 140, 180)");
    assert.equal(second.primary, first.primary);
    assert.equal(contextOptions[0]?.willReadFrequently, true);
});

test("share-image blur no longer allocates a second full-size canvas", () => {
    assert.doesNotMatch(shareSource, /function\s+createBlurredImage\b/);
    assert.doesNotMatch(shareSource, /tempCanvas/);
    assert.match(shareSource, /function\s+drawBlurredCover\b/);
    assert.match(shareSource, /ctx\.filter\s*=\s*.blur\(/);
});
