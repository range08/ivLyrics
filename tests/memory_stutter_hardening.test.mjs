import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../LyricsService.js", import.meta.url), "utf8");
const playbarSource = readFileSync(new URL("../PlaybarButton.js", import.meta.url), "utf8");

const section = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, "missing source section: " + start);
  return source.slice(from, to);
};

test("raw lyric memory cache retains only the 16 most recently used tracks", () => {
  const source = section(indexSource, "let CACHE = {};", "const emptyState =");
  const context = vm.createContext({ Map, Object });
  vm.runInContext(source + `
    globalThis.cacheHarness = {
      CACHE, rememberLyricsMemoryCache, touchLyricsMemoryCache,
      MAX_LYRICS_MEMORY_CACHE_ENTRIES
    };`, context);
  const h = context.cacheHarness;
  for (let i = 0; i < 20; i++) h.rememberLyricsMemoryCache("track-" + i, { i });
  assert.equal(Object.keys(h.CACHE).length, 16);
  assert.equal(h.MAX_LYRICS_MEMORY_CACHE_ENTRIES, 16);
  for (let i = 0; i < 4; i++) assert.equal(h.CACHE["track-" + i], undefined);

  assert.equal(h.touchLyricsMemoryCache("track-4").i, 4);
  h.rememberLyricsMemoryCache("track-20", { i: 20 });
  assert.equal(h.CACHE["track-4"].i, 4, "recently touched lyrics must survive eviction");
  assert.equal(h.CACHE["track-5"], undefined);
});

test("pseudo-karaoke audio analysis keeps a bounded LRU working set", () => {
  const source = section(
    serviceSource,
    "        const _analysisCache = new Map();",
    "        const PSEUDO_SOURCES ="
  );
  const context = vm.createContext({ Map, WeakMap });
  vm.runInContext(source + `
    globalThis.analysisHarness = {
      cache: _analysisCache, cacheAudioAnalysis, getCachedAudioAnalysis,
      max: MAX_ANALYSIS_CACHE_ENTRIES
    };`, context);
  const h = context.analysisHarness;
  for (let i = 0; i < 12; i++) h.cacheAudioAnalysis("track-" + i, { i });
  assert.equal(h.cache.size, 8);
  assert.equal(h.max, 8);
  assert.equal(h.getCachedAudioAnalysis("track-4").i, 4);
  h.cacheAudioAnalysis("track-12", { i: 12 });
  assert.equal(h.cache.has("track-4"), true);
  assert.equal(h.cache.has("track-5"), false);
});

test("sync-data runtime caches and metadata markers are bounded", () => {
  const source = section(
    serviceSource,
    "        const MAX_SYNC_DATA_CACHE_ENTRIES = 72;",
    "        const OPENDB_BASE_URL ="
  );
  const prefix = `
    const _syncDataCache = new Map();
    const _isrcLookupCache = new Map();
    const _syncTrackMetadataReported = new Set();
  `;
  const context = vm.createContext({ Map, Set });
  vm.runInContext(prefix + source + `
    globalThis.syncHarness = {
      sync: _syncDataCache, isrc: _isrcLookupCache, reported: _syncTrackMetadataReported,
      setSyncDataCache, getSyncDataCache, setIsrcLookupCache, rememberSyncMetadataReport
    };`, context);
  const h = context.syncHarness;
  for (let i = 0; i < 90; i++) h.setSyncDataCache("sync-" + i, { i });
  assert.equal(h.sync.size, 72);
  h.getSyncDataCache("sync-18");
  h.setSyncDataCache("sync-90", { i: 90 });
  assert.equal(h.sync.has("sync-18"), true);
  assert.equal(h.sync.has("sync-19"), false);

  for (let i = 0; i < 150; i++) h.setIsrcLookupCache("track-" + i, { isrc: "I" + i });
  assert.equal(h.isrc.size, 128);

  for (let i = 0; i < 150; i++) h.rememberSyncMetadataReport("isrc-" + i);
  assert.equal(h.reported.size, 128);
});

test("prefetch cache has a hard entry limit", () => {
  assert.match(indexSource, /_maxCacheEntries:\s*48/);
  assert.match(indexSource, /_setPrefetchCache\(key, value\)/);
  const directWrites = indexSource.match(/this\._prefetchCache\.set\(/g) || [];
  assert.equal(directWrites.length, 1, "all prefetch writes must pass through the bounded helper");
});

test("playbar reload lifecycle removes listeners, timers, history subscription and buttons", () => {
  assert.match(playbarSource, /window\.__ivLyricsPlaybarCleanup\?\.\(\)/);
  assert.match(playbarSource, /window\.removeEventListener\("ivLyrics", handlePlaybarConfig\)/);
  assert.match(playbarSource, /window\.removeEventListener\("ivLyrics", handleFullscreenConfig\)/);
  assert.match(playbarSource, /typeof unlistenHistory === "function"/);
  assert.match(playbarSource, /for \(const timerId of timers\) clearTimeout\(timerId\)/);
  assert.match(playbarSource, /removePlaybarButton\(\);[\s\S]*removeFullscreenButton\(\);/);
});
