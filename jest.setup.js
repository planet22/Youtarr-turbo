// Global test setup
jest.setTimeout(10000);

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
  // Keep log, info, debug for debugging
  log: console.log,
  info: console.info,
  debug: console.debug,
};

// The video/events log is fire-and-forget instrumentation sprinkled through
// many modules; stub it globally so their tests never open a DB connection.
// server/modules/jobEventLog's own tests load the real one via requireActual.
jest.mock('./server/modules/jobEventLog', () => {
  const { EVENT_TYPES, LEVELS } = jest.requireActual('./server/modules/jobEventLog/eventCatalog');
  return {
    record: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
    list: jest.fn(() => Promise.resolve({ events: [], nextCursor: null })),
    prune: jest.fn(() => Promise.resolve(0)),
    getRetentionDays: jest.fn(() => 180),
    EVENT_TYPES,
    LEVELS,
  };
});
