# Changelog

## [v0.4.0](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.4.0) - 2026-09-19

## [0.4.0](https://github.com/planet22/Youtarr-turbo/compare/vv0.3.0...v0.4.0) (2026-09-19)


### Features

* Update Unraid documentation for Youtarr-Turbo installation and configuration ([922aaba](https://github.com/planet22/Youtarr-turbo/commit/922aaba31153b7f3ed0a6b54edce68d1c5335b11))


### Documentation

* update CHANGELOG for v0.3.0 [skip ci] ([c8f1734](https://github.com/planet22/Youtarr-turbo/commit/c8f17347ede4ed00bce048ae65be37ad544b3258))





## [v0.3.0](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.3.0) - 2026-09-19

## [0.3.0](https://github.com/planet22/Youtarr-turbo/compare/vv0.2.0...v0.3.0) (2026-09-19)


### Features

* enhance Ytstream dry run functionality with new settings and experimental modes ([42306cc](https://github.com/planet22/Youtarr-turbo/commit/42306cc3c7805a32ab0f5449ed5d5767437c2bb5))


### Documentation

* update CHANGELOG for v0.2.0 [skip ci] ([d6fd818](https://github.com/planet22/Youtarr-turbo/commit/d6fd8183246ccd0f22b4d68786320bc0776418dc))





## [v0.2.0](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.2.0) - 2026-09-19

## [0.2.0](https://github.com/planet22/Youtarr-turbo/compare/vv0.1.0...v0.2.0) (2026-09-19)


### Features

* **ytstream:** add youtubeHlsProxy and youtubeHlsStreamCheck modules ([c743bf1](https://github.com/planet22/Youtarr-turbo/commit/c743bf1a50685d1ea01e5b509c1f79237f15023f))


### Documentation

* update CHANGELOG for v0.1.0 [skip ci] ([36a65db](https://github.com/planet22/Youtarr-turbo/commit/36a65db02a3d6bbe50b2c594be37225592b98dde))





## [v0.1.0](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.1.0) - 2026-09-17

## [0.1.0](https://github.com/planet22/Youtarr-turbo/compare/vv0.0.1...v0.1.0) (2026-09-17)


### Features

* add bufferStartAfterSegments config option for hls-buffer mode ([39c0f26](https://github.com/planet22/Youtarr-turbo/commit/39c0f266df86d4de07aa57abc3f70cbe32ce25c6))


### Documentation

* update CHANGELOG for v0.0.1 [skip ci] ([93739fc](https://github.com/planet22/Youtarr-turbo/commit/93739fc5c546c4aaff1b82985de5b0cbbd182053))
* update repository links and enhance usage guide structure ([66c8dfa](https://github.com/planet22/Youtarr-turbo/commit/66c8dfa63fc889a25c0a097dc9ec72b7f92acae2))





## [v0.0.1](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.0.1) - 2026-09-16

### [0.0.1](https://github.com/planet22/Youtarr-turbo/compare/v0.0.0...v0.0.1) (2026-09-16)





All notable changes to Youtarr-Turbo are documented here.

## 1.2.0 (2026-09-03 – present)

### Added
- Network tuning benchmark tool for measuring streaming throughput
- NZB search trace viewer for inspecting Newznab/SABnzbd search results
- Comprehensive automated test coverage for ytstream routes

### Changed
- Renamed project references from "Youtarr" to "Youtarr-Turbo" across the codebase
- Refactored the streaming page into shared components with an improved grid view, mobile layout, and format display
- Reworked NZB, yt-dlp, and video caching, along with the theme engine
- Cleaned up and consolidated the HLS buffering pipeline, dropping the earlier HLS-tap approach in favor of a unified download/buffer path
- Investigated hardware-accelerated decode for streaming

## 1.1.1 (2026-09-01)

### Added
- HLS + buffered streaming support for ytstream (major rework of the streaming pipeline)
- Dry-run preview for ytstream and NZB routes
- Stream encoder tuning and benchmarking tools
- Support for additional stream probe formats and codecs

### Changed
- Streaming now uses MKV-based seeking with DASH stream support, improving seek reliability and format compatibility

### Fixed
- Channel image regeneration status handling
- Assorted streaming and NZB route issues

## 1.0.0 (2026-08-28)

- Initial release
