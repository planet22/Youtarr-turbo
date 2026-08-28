const PlexAdapter = require('./adapters/plexAdapter');
const JellyfinAdapter = require('./adapters/jellyfinAdapter');
const EmbyAdapter = require('./adapters/embyAdapter');
const plexModule = require('../plexModule');
const logger = require('../../logger');

class ServerRegistry {
  getEnabledAdapters(config) {
    const adapters = [];
    // Plex is "enabled" when an API key is configured AND a base URL can be resolved.
    // The URL may come from plexUrl, PLEX_URL env var, or be built from plexIP/plexPort/plexViaHttps
    // — plexModule.getBaseUrl encapsulates that precedence. Pass the resolved URL into the adapter
    // via a cloned config so the adapter doesn't need to repeat the resolution.
    const plexUrl = plexModule.getBaseUrl(null, config);
    if (plexUrl && config.plexApiKey) {
      adapters.push(new PlexAdapter({ ...config, plexUrl }));
    }
    if (config.jellyfinEnabled && config.jellyfinUrl && config.jellyfinApiKey && config.jellyfinUserId) {
      adapters.push(new JellyfinAdapter(config));
    }
    if (config.embyEnabled && config.embyUrl && config.embyApiKey && config.embyUserId) {
      adapters.push(new EmbyAdapter(config));
    }
    return adapters;
  }

  /**
   * Notifies every enabled Jellyfin/Emby server to rescan after a download
   * completes, so newly-downloaded videos show up without waiting for their
   * own periodic scan. Plex is deliberately excluded here — it already gets
   * a more targeted per-section refresh via plexModule.refreshLibrariesForSubfolders
   * at the same call sites, and calling both would just double up on Plex.
   *
   * `subfolders` (resolved names, no __ prefix; null = root) is deduped and
   * each adapter's triggerLibraryScan(subfolder) is called once per distinct
   * value, so an adapter with a subfolder→library mapping (Jellyfin - see
   * jellyfinAdapter._getLibraryIdForSubfolder) only refreshes the libraries
   * actually touched instead of every library on the server. An adapter with
   * no mapping for a subfolder (or no mapping support at all, e.g. Emby)
   * falls back to its own blanket full-server scan - see each adapter's
   * triggerLibraryScan. Omitting subfolders (or passing []) preserves the
   * original always-blanket-scan behavior, called once per adapter.
   * adapter.triggerLibraryScan() already swallows its own errors (logs and
   * resolves), so this never throws; callers can call it fire-and-forget.
   */
  async triggerLibraryScansForNonPlexServers(config, subfolders = []) {
    const adapters = this.getEnabledAdapters(config).filter((a) => a.serverType !== 'plex');
    if (adapters.length === 0) return;
    const distinctSubfolders = [...new Set(subfolders)];
    const targets = distinctSubfolders.length > 0 ? distinctSubfolders : [undefined];
    await Promise.allSettled(
      adapters.flatMap((adapter) =>
        targets.map((subfolder) =>
          adapter.triggerLibraryScan(subfolder).catch((err) => {
            logger.warn({ err, serverType: adapter.serverType, subfolder }, 'media server library scan trigger failed');
          })
        )
      )
    );
  }
}

module.exports = new ServerRegistry();
