# Changelog

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
