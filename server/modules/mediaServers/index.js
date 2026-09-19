module.exports = {
  serverRegistry: require('./serverRegistry'),
  mediaServerSync: require('./mediaServerSync'),
  watchStatusSync: require('./watchStatusSync'),
  watchStatusQueries: require('./watchStatusQueries'),
  watchStatusScheduler: require('./watchStatusScheduler'),
  strmToolTurbo: require('./strmToolTurboModule'),
  adapters: {
    BaseAdapter: require('./adapters/baseAdapter'),
    PlexAdapter: require('./adapters/plexAdapter'),
    JellyfinAdapter: require('./adapters/jellyfinAdapter'),
    EmbyAdapter: require('./adapters/embyAdapter'),
  },
};
