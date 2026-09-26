# Changelog

## [v0.7.0](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.7.0) - 2026-09-26

## [0.7.0](https://github.com/planet22/Youtarr-turbo/compare/vv0.6.0...v0.7.0) (2026-09-26)


### Features

* add a Settings UI to regenerate the ytstream stream key ([912cfa4](https://github.com/planet22/Youtarr-turbo/commit/912cfa404ee2c5c1e3dadfa9ff09be405787a972))


### Bug Fixes

* gate /api/ytstream behind a session or per-install key, and fix youtube-hls PiP preview CORS ([6bfc740](https://github.com/planet22/Youtarr-turbo/commit/6bfc740737bc8065a1c66cbf935fde9a63ca09fb))


### Documentation

* fix inaccurate claims about STRM mode, AMF support, and progressive quality ([f04f2ce](https://github.com/planet22/Youtarr-turbo/commit/f04f2cef326ce5484a1acbcbeb694026ba2fd78e))
* update CHANGELOG for v0.6.0 [skip ci] ([f19f65d](https://github.com/planet22/Youtarr-turbo/commit/f19f65da0e64605e428478dc382f6f1015ea1c01))





## [v0.6.0](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.6.0) - 2026-09-26

## [0.6.0](https://github.com/planet22/Youtarr-turbo/compare/v0.5.0...v0.6.0) (2026-09-26)


### Features

* add append-only video/events log foundation (job_events) ([91ee663](https://github.com/planet22/Youtarr-turbo/commit/91ee6631c7157ddd09d41e95dfa01e4f3fb3f3d3))
* add GET /api/job-events to read the video/events log ([95172d7](https://github.com/planet22/Youtarr-turbo/commit/95172d76d4475b36227476040248bae800a63b60))
* add the video/events log page at /downloads/log ([ff50549](https://github.com/planet22/Youtarr-turbo/commit/ff505499534a375f626714e9049b2232efc03757))
* call the event log's Actor column "Component" and show plain names ([56c59c1](https://github.com/planet22/Youtarr-turbo/commit/56c59c128b333be37521863f8da433889c5c9a5c))
* document the Event Log and complete the job-events Swagger ([fd42a20](https://github.com/planet22/Youtarr-turbo/commit/fd42a202217be2d11fe08d81f675aa7b66c1341b))
* enable the job queue manager table by default ([81cf38f](https://github.com/planet22/Youtarr-turbo/commit/81cf38f232c4439fd0e241e37b8e942b4ec424cc))
* Event Log column tightening, job-scoped views, and job link icon ([1aefbd9](https://github.com/planet22/Youtarr-turbo/commit/1aefbd9e65294bb0eda9885d2436300e64642bfa))
* fall back to the YouTube CDN thumbnail on the Videos page ([55dceeb](https://github.com/planet22/Youtarr-turbo/commit/55dceeb096a5a74b9b41e5fdc8b8fd5f5b95e231))
* log file/STRM/cache steps, fix false grab failures, add Clear Event Log ([035f7fe](https://github.com/planet22/Youtarr-turbo/commit/035f7fed842b91ee436b08fff7d4875f3a0c1def))
* log playlist ignore, rating, folder-move and media-server playlist changes ([1b4d442](https://github.com/planet22/Youtarr-turbo/commit/1b4d442e071b94c85732637d789ec855440d43b5))
* log protect/ignore/unavailable-on-YouTube at their source; drop inferred grab-failed ([0c2f394](https://github.com/planet22/Youtarr-turbo/commit/0c2f3946dd3eb03cc721ab34c2c5d69dd95eb432))
* log video rows recreated, interrupted downloads, and playback cache/remux files ([8b18836](https://github.com/planet22/Youtarr-turbo/commit/8b18836bee76157bc9a0be4c94ef2b5ceeff700d))
* media mode override in download popup, STRM/MP3 gating, event log accuracy ([2d67ee0](https://github.com/planet22/Youtarr-turbo/commit/2d67ee01b8607ec6c974b8da6af88f0040111b70))
* one thumbnail path for every video, kept on first fetch, with nightly cleanup ([05d1c70](https://github.com/planet22/Youtarr-turbo/commit/05d1c70b86f55898faa4e0ace4118562bbd82152))
* quick-play Picture-in-Picture icon for Video Library rows ([90eb91f](https://github.com/planet22/Youtarr-turbo/commit/90eb91fc9980ad1df30b332b264f564487d45795))
* record job and download lifecycle steps in the video/events log ([752bfd0](https://github.com/planet22/Youtarr-turbo/commit/752bfd0dce95bde628d6ea03747fa9ff89707400))
* record NZB, STRM, stream-cache and deletion steps in the video/events log ([08d1843](https://github.com/planet22/Youtarr-turbo/commit/08d184326e9aa9ef75456bcc762f011a4361ee4a))
* record tracked state per event, keep long errors out of the main line, fix titles and Source ([7589531](https://github.com/planet22/Youtarr-turbo/commit/7589531a98cffdebd9efa0399c18d4244b98f59e))
* reuse the shared LIKE escaping and cover the purge transaction in event-log tests ([316f9c3](https://github.com/planet22/Youtarr-turbo/commit/316f9c38f69ac2d5fa54c22d85aec095fe362cf3))
* rework the event log page - columns, filters, expansion row, ordering, sync capture ([f814022](https://github.com/planet22/Youtarr-turbo/commit/f814022812d98ac621691df2b5dd34d5e87a8ee7))
* store each event's source label instead of working it out on read ([ff8df1b](https://github.com/planet22/Youtarr-turbo/commit/ff8df1b697c7cba77eb4479a43c9b9122cf14de8))
* tighten the event log table and cut long messages with a "more…" link ([52a2e68](https://github.com/planet22/Youtarr-turbo/commit/52a2e689728f3214413dcaa5be41e803439fcba9))


### Bug Fixes

* **docker:** skip Intel-only VAAPI/QSV packages on arm64 build ([2a2007f](https://github.com/planet22/Youtarr-turbo/commit/2a2007f74866d5f8a8ea58be239410c0b76374c6))
* answer 500 instead of hanging when GET /getchannelinfo fails ([faffd99](https://github.com/planet22/Youtarr-turbo/commit/faffd990a6a98f4a702f1b948d596e8ef3b50ed8))
* answer cookie upload rejections with 400/413 instead of 500 ([c86674a](https://github.com/planet22/Youtarr-turbo/commit/c86674a17eb0f7e410704231cec2d56ad1d8c37a))
* cap bulk video ids and isolate per-item failures in strm/revert ([f0b342d](https://github.com/planet22/Youtarr-turbo/commit/f0b342dc85619b66cc0e156478738d90d6ab239f))
* correct notification test timers after a removal and non-JSON errors ([94926aa](https://github.com/planet22/Youtarr-turbo/commit/94926aabd959374fc5c327bf16fb013d0fa045b1))
* count first-time downloads as active for their channel ([ee056ad](https://github.com/planet22/Youtarr-turbo/commit/ee056ad936f50552dc436fa95ac657f9480de57f))
* dedupe NZB failed-grab records across restarts, not just in-memory ([ae08a2f](https://github.com/planet22/Youtarr-turbo/commit/ae08a2f36f5103d0e7d01e9c5489a542d7392eed))
* do not cache an empty video codec probe result ([f5c7283](https://github.com/planet22/Youtarr-turbo/commit/f5c7283b8a33d5d949b7e400a1f5aec09c6fb1c9))
* escape LIKE wildcards in the Streaming History search ([d54b2c3](https://github.com/planet22/Youtarr-turbo/commit/d54b2c3972a734086f9612fcad471974155db956))
* expandable messages collapse via "less…", delta header reads "Δ time" ([402d9f9](https://github.com/planet22/Youtarr-turbo/commit/402d9f94ebb1fd1f0f267ac971a3d3ee5482275d))
* fall back to embedded YouTube player when local video playback fails ([fd9f04c](https://github.com/planet22/Youtarr-turbo/commit/fd9f04c7ec6683d2c4e830c601000a2341d4d144))
* give health routes their own router and cache the release lookup ([d682e55](https://github.com/planet22/Youtarr-turbo/commit/d682e557095a83a61dad222e7f368b4f6e89d74b))
* give the python regex checks more time and report timeouts clearly ([8b9e950](https://github.com/planet22/Youtarr-turbo/commit/8b9e9507d2d958538decf1e2d8e1c72e4ce83649))
* include tracked channels in the video filter's channel list ([1b70a94](https://github.com/planet22/Youtarr-turbo/commit/1b70a947d34f84755497c96fddde6bb7f17e45ed))
* install Intel QSV drivers regardless of Docker builder ([4226830](https://github.com/planet22/Youtarr-turbo/commit/4226830343a27efafb69ef12f53ebb240c60933a))
* keep #HttpOnly_ cookies in the ffmpeg cookie header ([0840a30](https://github.com/planet22/Youtarr-turbo/commit/0840a30369d1675976f1cf218316f9e6558106bc))
* keep a completed job's videos when the database recount finds none ([b50cb32](https://github.com/planet22/Youtarr-turbo/commit/b50cb32a360fcdfd523a100d6a589dafef172fda))
* keep empty-valued cookies when building the ffmpeg cookie header ([5ca416b](https://github.com/planet22/Youtarr-turbo/commit/5ca416b364125dbd895c5962afbad41d1598ed08))
* keep the original video until the transcoded file is moved into place ([18ca422](https://github.com/planet22/Youtarr-turbo/commit/18ca422b06a11301221eeb83c9a262ccf3eb21dd))
* let ytstream numeric settings be cleared and retyped ([ed2e2e4](https://github.com/planet22/Youtarr-turbo/commit/ed2e2e44058ba09e039a0adb89573559a19f297d))
* log server errors through the Pino logger instead of console.error ([8be237e](https://github.com/planet22/Youtarr-turbo/commit/8be237e483fb05a4ce619ecaf5828f47d245e3da))
* match Videos-page search text literally instead of as LIKE wildcards ([0d7d131](https://github.com/planet22/Youtarr-turbo/commit/0d7d131aee96684e385e077ea7518205f2e2a76f))
* mock statSync in configModule cookies status test ([faa92d6](https://github.com/planet22/Youtarr-turbo/commit/faa92d63050182f446e727836b6a5f01929a2030))
* page maintenance jobs through videos in id order ([2b9691c](https://github.com/planet22/Youtarr-turbo/commit/2b9691c8d342970173997c0092f250be18cb9676))
* PiP preview actually plays mode=youtube-hls via real segment byte-proxying ([5f2be2f](https://github.com/planet22/Youtarr-turbo/commit/5f2be2f6de57f234564875b5f2345c563ea393a5))
* purge a video's rows in one transaction ([35d9c22](https://github.com/planet22/Youtarr-turbo/commit/35d9c22397b64e160966740f58ccc1796aa0774b))
* replace a stale resolution tag in an NFO instead of adding a second ([7a09803](https://github.com/planet22/Youtarr-turbo/commit/7a09803769d047631517d6e230a19680876e27ca))
* report cache-clear failures and correct counts on the Videos page ([76d607d](https://github.com/planet22/Youtarr-turbo/commit/76d607d0f116fa02cbb36f82228e1818d71393af))
* report channel settings input errors as 400/404/409 instead of 500 ([a89af1b](https://github.com/planet22/Youtarr-turbo/commit/a89af1b316ae30df56d8a1c1a21bef87e6f8dead))
* report partial failures when testing all notification services ([0ad5d3e](https://github.com/planet22/Youtarr-turbo/commit/0ad5d3ed12277c576793cabc4b8e8fc416bcb768))
* restore the STRM backup before deleting the cached media file ([8727cd9](https://github.com/planet22/Youtarr-turbo/commit/8727cd9cab1bad0b0e774a54017c1e0639e7b388))
* retry failed thumbnails on refetch and stop rendering stray 0s on Videos page ([fe30377](https://github.com/planet22/Youtarr-turbo/commit/fe303774c368171588be9ead5c750c8c6d291e41))
* send stream read errors as JSON instead of labelled video/mp4 ([ce90088](https://github.com/planet22/Youtarr-turbo/commit/ce900882a045622d84422abcc273ed10a7fddda2))
* show a message when cancelling an NZB job fails ([0e1b765](https://github.com/planet22/Youtarr-turbo/commit/0e1b765a63772b69a624df036e6555660051df13))
* show event log paths relative to the library root, refine when "more…" appears ([be23a41](https://github.com/planet22/Youtarr-turbo/commit/be23a4164b2b53ae48112e5c7108cb6cd737922f))
* skip cached videos with no STRM backup in the expiry sweep ([636f4a5](https://github.com/planet22/Youtarr-turbo/commit/636f4a516791689885b71a324e40f7573ec9ca40))
* support suffix ranges and clamp an overlong end in video streaming ([6430fd8](https://github.com/planet22/Youtarr-turbo/commit/6430fd806e45bfb0b73b3c8ed2a461913e9f89cd))
* treat an invalid t seek parameter as no seek instead of NaN ([1eb60c4](https://github.com/planet22/Youtarr-turbo/commit/1eb60c448935095bfcd5ce75875f4252d65744c0))
* validate the download request before saving its subfolder ([076b3a7](https://github.com/planet22/Youtarr-turbo/commit/076b3a7415577d612960085ba1b8544e38738fa6))
* validate video count and auto-removal dry-run overrides strictly ([6596e89](https://github.com/planet22/Youtarr-turbo/commit/6596e8993d78b52e269d6e6adc2f2da0a03224f0))
* XML-escape the episode NFO thumb filename ([0992ea6](https://github.com/planet22/Youtarr-turbo/commit/0992ea699a488aa00d9bd3dd3a66dd3b6da72b0c))
* XML-escape the video id in movie and episode NFOs ([ad9eecf](https://github.com/planet22/Youtarr-turbo/commit/ad9eecf4633243a36b427e955a0eb01470708f5c))


### Styles

* match the event log's Untracked thumbnail badge to the Videos library ([a8ae767](https://github.com/planet22/Youtarr-turbo/commit/a8ae7673bad364f53b4fff0abd47aeef0ae0e499))


### Tests

* add backend coverage for ytstream, STRM, NZB, notifications and encoders ([445f853](https://github.com/planet22/Youtarr-turbo/commit/445f8533c40350f75d62735f95d5afefa67a7cd4))
* add frontend coverage for settings, NZB, streaming and cache hooks ([2d36a3d](https://github.com/planet22/Youtarr-turbo/commit/2d36a3d112547ac0ccd158bb400a9dc43694e037))
* cover channel artwork sidecars and NZB release tags in post-process script ([8fe3b79](https://github.com/planet22/Youtarr-turbo/commit/8fe3b7978cc02b3b06ff02a88b2846ca6ccdc21e))
* cover channel folder-name migration and the python title matcher ([c62bcc1](https://github.com/planet22/Youtarr-turbo/commit/c62bcc1c274c67d8b23dbf60e87e4d4fcb0eaacf))
* cover channel route error mapping, settings, previews, video listing and bulk-ignore validation ([6c45658](https://github.com/planet22/Youtarr-turbo/commit/6c4565861ecde80247bd0bf175b27f185ee5d417))
* cover channelSettingsModule validators, decode wrapper, combined preview and active-download check ([ef95cf9](https://github.com/planet22/Youtarr-turbo/commit/ef95cf939ab4a835ae9866e9b2809071bc2a5390))
* cover ChannelVideos bulk selection, ignore, delete, STRM switch and protection actions ([73fb5b8](https://github.com/planet22/Youtarr-turbo/commit/73fb5b886404f3a702720db391ce014d27afdc60))
* cover DateRangeFilter value conversion and layouts ([c3f4759](https://github.com/planet22/Youtarr-turbo/commit/c3f47599d59827b7ac54707147b3ed50ef14223b))
* cover filter chips, playlist mutations, import page and dry-run section ([010cd9a](https://github.com/planet22/Youtarr-turbo/commit/010cd9a6df9bbfd028954859b3ae515fc8b42e6e))
* cover health, release version and yt-dlp update routes ([1615b34](https://github.com/planet22/Youtarr-turbo/commit/1615b34cc2d2182521f886a7cc5d2fab7199a186))
* cover JellyfinSubfolderMappings library loading, table and add flow ([cb9a111](https://github.com/planet22/Youtarr-turbo/commit/cb9a1119dd0e0de718fe8d27f7498b93f7fa5b33))
* cover jobModule save retries, fresh-video backfills and updateJob completion ([85612c8](https://github.com/planet22/Youtarr-turbo/commit/85612c8b61f4b5aeaa44a2268808d7e34df563cc))
* cover network tuning benchmark hook and stream row stop/elapsed hook ([3efe7b3](https://github.com/planet22/Youtarr-turbo/commit/3efe7b3865f630c5d6b34598d75d53668103a473))
* cover notification routing per service, skip rules and failure reporting ([b3da39f](https://github.com/planet22/Youtarr-turbo/commit/b3da39fdc0aac0cadf92efbb8e43f7021af9db01))
* cover notification service editing, removal and test-send states ([fc46960](https://github.com/planet22/Youtarr-turbo/commit/fc46960cc4f63d4ed0d26d24ee6a0855f4475e11))
* cover NzbJobsSection queue and history in table and mobile layouts ([081df46](https://github.com/planet22/Youtarr-turbo/commit/081df46fb2d4a9129eb9c48e8d987686a335ba00))
* cover oEmbed enricher response, size-cap, timeout and deadline handling ([625f266](https://github.com/planet22/Youtarr-turbo/commit/625f2668f968926a2e5176d8c8a883b4858166a3))
* cover PlexAuthDialog polling, timeout, error and unmount cleanup ([c338833](https://github.com/planet22/Youtarr-turbo/commit/c3388331da749ecda0e91241d07f6db3e4864cf6))
* cover post-download transcode in videoDownloadPostProcessFiles ([17c8ade](https://github.com/planet22/Youtarr-turbo/commit/17c8ade59fb3245fb0821f35ba0061ad83f60860))
* cover post-process channel resolution, series episode numbering and cleanup ([7d0dc5a](https://github.com/planet22/Youtarr-turbo/commit/7d0dc5a1073b8f04516e740d30649072ce6037e1))
* cover remaining config and videos route endpoints ([b09e31e](https://github.com/planet22/Youtarr-turbo/commit/b09e31e28252ad6959930ad0f5d40c5f76d71804))
* cover StreamingPage header, views, search, refresh timer and dialogs ([974efde](https://github.com/planet22/Youtarr-turbo/commit/974efde5d39f5bd19828a940ebf847e646172177))
* cover STRM revert, cache expiry sweep and purge in videoDeletionModule ([bfc1ccd](https://github.com/planet22/Youtarr-turbo/commit/bfc1ccd263ffe708d374e8921b0692a5d2f5414c))
* cover thumbnail enricher byte limit, redirects, failures and deadline ([4dd1ba3](https://github.com/planet22/Youtarr-turbo/commit/4dd1ba34fc49938a781f2c571bb9cce95cf3326c))
* cover untracked/metadata cache hooks and channel filter preview tooltip ([bf87a62](https://github.com/planet22/Youtarr-turbo/commit/bf87a62f4ed9cb9f01d66ecc1cb542d64d909d3e))
* cover video detail metadata refresh, STRM redirect and range streaming ([a31180f](https://github.com/planet22/Youtarr-turbo/commit/a31180f326916ba492891099067512f55ddfddab))
* cover video stream info resolution (STRM, untracked cache, ts remux) ([45159c4](https://github.com/planet22/Youtarr-turbo/commit/45159c4256af2dd262d177ebab7f54e8e18a30ce))
* cover videosModule file scanning, bulk rating updates and backfill flushing ([3915ca8](https://github.com/planet22/Youtarr-turbo/commit/3915ca84f56db9ba0633fc917842d01ebde5c302))
* cover videosModule resolution-tag backfill, image and metadata regeneration jobs ([fa5306d](https://github.com/planet22/Youtarr-turbo/commit/fa5306de28303e0b2b9b483295c1dfde2b360d8d))
* cover videosModule untracked-video bucket queries and row hydration ([aea7c3e](https://github.com/planet22/Youtarr-turbo/commit/aea7c3e18aded30059af20c5e8aac524dc02785b))
* cover VideosPage bulk delete, purge, obliterate, rating, download, STRM and cache actions ([64dac63](https://github.com/planet22/Youtarr-turbo/commit/64dac63a55db70c79dbafa2025013799369bb080))
* cover ytstream direct/cache modules, cron tasks, maintenance routes ([ad2cf14](https://github.com/planet22/Youtarr-turbo/commit/ad2cf14408701f5f9f68a1d0c2ad2e8654ea232a))
* cover ytstream master playlist builder and yt-dlp base args / cookie header ([45efd81](https://github.com/planet22/Youtarr-turbo/commit/45efd811456bf09cdaceaf5cdd6b071c30dfb56a))
* cover ytstream playbackPlan and nfoGenerator file output ([08bb2c9](https://github.com/planet22/Youtarr-turbo/commit/08bb2c9670bc1f4735a6e70dd316143feefaafce))
* cover Ytstream settings dropdowns, switches, numeric fields and cache clearing ([3d4bebf](https://github.com/planet22/Youtarr-turbo/commit/3d4bebfdf53f6c356312391c689f9e14d1d886fa))
* make backend suites pass on Windows checkouts ([7828f9b](https://github.com/planet22/Youtarr-turbo/commit/7828f9b6aeb1ccaee69ac7a7afdb62496ff23896))
* make channelSettingsModule moveChannelFolder path expectations separator-independent ([78aac80](https://github.com/planet22/Youtarr-turbo/commit/78aac80651eadd9ec8db8d07377fc1f03f1ae0c8))
* make videosModule path expectations independent of the path separator ([1ecee33](https://github.com/planet22/Youtarr-turbo/commit/1ecee33b2194138dac4ba47739285d97001e37bf))
* run videoDownloadPostProcessFiles suite against POSIX path semantics ([5bc6127](https://github.com/planet22/Youtarr-turbo/commit/5bc61275647e9515fea60d90b7bcf27239db6e35))


### Documentation

* trim README/CONTRIBUTORS content and clear the alternatives comparison ([4e3925b](https://github.com/planet22/Youtarr-turbo/commit/4e3925b1fc85d7854a64781ad454bc3ae678b613))
* update CHANGELOG for v0.5.0 [skip ci] ([dfa8a73](https://github.com/planet22/Youtarr-turbo/commit/dfa8a73d0bc6b236736ac4ece74256f12c30f87e))





## [v0.5.0](https://github.com/planet22/Youtarr-turbo/releases/tag/v0.5.0) - 2026-09-19

## [0.5.0](https://github.com/planet22/Youtarr-turbo/compare/vv0.4.0...v0.5.0) (2026-09-19)


### Features

* add scheduled tasks management and UI components ([7138884](https://github.com/planet22/Youtarr-turbo/commit/71388841ace1789b1c4bc4ef81157cf294d98f56))


### Documentation

* update CHANGELOG for v0.4.0 [skip ci] ([1f353f9](https://github.com/planet22/Youtarr-turbo/commit/1f353f927bb9f8df3152fa7c222bd11fd6dc4f7e))





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
