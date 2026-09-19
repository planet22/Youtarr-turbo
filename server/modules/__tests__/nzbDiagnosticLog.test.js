jest.mock('../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

describe('nzbDiagnosticLog', () => {
  let nzbDiagnosticLog;
  let NzbDiagnosticLog;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('../../models', () => ({
      NzbDiagnosticLog: {
        create: jest.fn().mockResolvedValue(undefined),
        count: jest.fn().mockResolvedValue(0),
        findAll: jest.fn().mockResolvedValue([]),
        destroy: jest.fn().mockResolvedValue(0),
      },
    }));
    nzbDiagnosticLog = require('../nzbDiagnosticLog');
    ({ NzbDiagnosticLog } = require('../../models'));
  });

  describe('resolveLogLimit', () => {
    test('falls back to the default when the config value is missing', () => {
      expect(nzbDiagnosticLog.resolveLogLimit({}, 'recentQueries')).toBe(50);
      expect(nzbDiagnosticLog.resolveLogLimit({}, 'searchTraces')).toBe(20);
      expect(nzbDiagnosticLog.resolveLogLimit({}, 'failedGrabs')).toBe(20);
    });

    test('clamps a configured value to the 1-100 range', () => {
      const cfg = { nzb: { diagnosticLogLimits: { recentQueries: 0, searchTraces: 500 } } };
      expect(nzbDiagnosticLog.resolveLogLimit(cfg, 'recentQueries')).toBe(1);
      expect(nzbDiagnosticLog.resolveLogLimit(cfg, 'searchTraces')).toBe(100);
    });

    test('uses an explicit in-range configured value as-is', () => {
      const cfg = { nzb: { diagnosticLogLimits: { failedGrabs: 33 } } };
      expect(nzbDiagnosticLog.resolveLogLimit(cfg, 'failedGrabs')).toBe(33);
    });
  });

  describe('countAllDiagnosticEvents', () => {
    test('counts rows across all three log kinds together', async () => {
      NzbDiagnosticLog.count.mockResolvedValueOnce(7);
      await expect(nzbDiagnosticLog.countAllDiagnosticEvents()).resolves.toBe(7);
      expect(NzbDiagnosticLog.count).toHaveBeenCalledWith({ where: { kind: ['query', 'trace', 'failedGrab'] } });
    });
  });

  describe('clearDiagnosticEvents', () => {
    test('deletes only rows of the given kind', async () => {
      NzbDiagnosticLog.destroy.mockResolvedValueOnce(3);
      await expect(nzbDiagnosticLog.clearDiagnosticEvents('failedGrab')).resolves.toBe(3);
      expect(NzbDiagnosticLog.destroy).toHaveBeenCalledWith({ where: { kind: 'failedGrab' } });
    });

    test('rejects an unknown kind without touching the table', async () => {
      await expect(nzbDiagnosticLog.clearDiagnosticEvents('bogus')).rejects.toThrow('Unknown diagnostic log kind');
      expect(NzbDiagnosticLog.destroy).not.toHaveBeenCalled();
    });
  });

  describe('clearAllDiagnosticEvents', () => {
    test('deletes rows across all three log kinds together', async () => {
      NzbDiagnosticLog.destroy.mockResolvedValueOnce(7);
      await expect(nzbDiagnosticLog.clearAllDiagnosticEvents()).resolves.toBe(7);
      expect(NzbDiagnosticLog.destroy).toHaveBeenCalledWith({ where: { kind: ['query', 'trace', 'failedGrab'] } });
    });
  });
});
