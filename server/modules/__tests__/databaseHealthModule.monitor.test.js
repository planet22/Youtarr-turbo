/* eslint-env jest */

jest.mock('../../logger');

describe('databaseHealthModule health monitor', () => {
  let health;
  let logger;
  let sequelize;
  let reinitializeDatabase;

  // Module state (interval, failure counter) is module-level, so reload each time
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    logger = require('../../logger');
    logger.info = jest.fn();
    logger.warn = jest.fn();
    logger.error = jest.fn();
    logger.debug = jest.fn();
    health = require('../databaseHealthModule');
    sequelize = { authenticate: jest.fn().mockResolvedValue(undefined) };
    reinitializeDatabase = jest.fn().mockResolvedValue({ connected: true, schemaValid: true });
  });

  afterEach(() => {
    health.stopHealthMonitor();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // The monitor's immediate check plus any timer ticks are all async
  const settle = () => jest.advanceTimersByTimeAsync(0);

  it('starts with the database reported unhealthy', () => {
    expect(health.isDatabaseHealthy()).toBe(false);
  });

  it('has no startup timestamp before anything is recorded', () => {
    expect(health.getStartupHealth().timestamp).toBeNull();
  });

  describe('startHealthMonitor', () => {
    it('logs that it started', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(logger.info).toHaveBeenCalledWith('Starting database health monitor');
    });

    it('warns and does nothing when started twice', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();
      health.startHealthMonitor(reinitializeDatabase, sequelize);

      expect(logger.warn).toHaveBeenCalledWith('Health monitor already running');
    });

    it('checks straight away without waiting for the first interval', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(reinitializeDatabase).toHaveBeenCalledTimes(1);
    });

    it('checks again every 15 seconds', async () => {
      health.setStartupHealth(true, true);
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      await jest.advanceTimersByTimeAsync(30000);

      expect(sequelize.authenticate).toHaveBeenCalledTimes(3);
    });
  });

  describe('when the cached status is healthy', () => {
    beforeEach(() => {
      health.setStartupHealth(true, true);
    });

    it('actively probes the database', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(sequelize.authenticate).toHaveBeenCalledTimes(1);
    });

    it('does not try to reconnect while the probe passes', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(reinitializeDatabase).not.toHaveBeenCalled();
    });

    it('marks the database unhealthy when the probe fails', async () => {
      sequelize.authenticate.mockRejectedValue(new Error('ECONNRESET'));
      reinitializeDatabase.mockResolvedValue({ connected: false, schemaValid: false });

      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(health.isDatabaseHealthy()).toBe(false);
      expect(health.getStartupHealth().database.errors).toEqual(['Database connection lost: ECONNRESET']);
    });

    it('attempts a reconnect after a failed probe', async () => {
      sequelize.authenticate.mockRejectedValue(new Error('ECONNRESET'));

      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(reinitializeDatabase).toHaveBeenCalledTimes(1);
    });

    it('trusts the cached status when no sequelize instance was given', async () => {
      health.startHealthMonitor(reinitializeDatabase, undefined);
      await settle();

      expect(reinitializeDatabase).not.toHaveBeenCalled();
    });
  });

  describe('when the database is unhealthy', () => {
    it('attempts a reconnect', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(reinitializeDatabase).toHaveBeenCalledTimes(1);
    });

    it('logs success when the reconnect works', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(logger.info).toHaveBeenCalledWith('Database reconnection successful');
    });

    it('warns when the reconnect completes but the database is still unhealthy', async () => {
      reinitializeDatabase.mockResolvedValue({ connected: true, schemaValid: false });

      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(logger.warn).toHaveBeenCalledWith(
        { connected: true, schemaValid: false },
        'Database reconnection attempt completed but still unhealthy'
      );
    });

    it('logs and carries on when the reconnect throws', async () => {
      reinitializeDatabase.mockRejectedValue(new Error('still down'));

      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Error during database reconnection attempt');
    });

    it('keeps retrying on later ticks', async () => {
      reinitializeDatabase.mockResolvedValue({ connected: false, schemaValid: false });
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      await jest.advanceTimersByTimeAsync(15000);

      expect(reinitializeDatabase).toHaveBeenCalledTimes(2);
    });

    it('backs off from 15s to 30s to 60s as failures accumulate', async () => {
      reinitializeDatabase.mockResolvedValue({ connected: false, schemaValid: false });
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle(); // failure 1
      await jest.advanceTimersByTimeAsync(15000); // failure 2
      await jest.advanceTimersByTimeAsync(15000); // failure 3
      await jest.advanceTimersByTimeAsync(30000); // failure 4

      const intervals = setIntervalSpy.mock.calls.map(([, ms]) => ms);
      expect(intervals).toEqual([15000, 15000, 15000, 30000, 60000]);
    });

    it('skips a check that overlaps one still in progress', async () => {
      reinitializeDatabase.mockReturnValue(new Promise(() => {}));
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      await jest.advanceTimersByTimeAsync(15000);

      expect(reinitializeDatabase).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith('Health check already in progress, skipping');
    });
  });

  describe('recovery', () => {
    it('announces the return to health and drops back to the normal interval', async () => {
      reinitializeDatabase.mockResolvedValue({ connected: false, schemaValid: false });
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      health.setStartupHealth(true, true);
      await jest.advanceTimersByTimeAsync(15000);

      expect(logger.info).toHaveBeenCalledWith('Database returned to healthy state');
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15000);
    });

    it('does not announce anything when it was never unhealthy', async () => {
      health.setStartupHealth(true, true);
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(logger.info).not.toHaveBeenCalledWith('Database returned to healthy state');
    });

    it('resets the failure count after a successful reconnect', async () => {
      reinitializeDatabase
        .mockResolvedValueOnce({ connected: false, schemaValid: false })
        .mockResolvedValueOnce({ connected: true, schemaValid: true });
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle(); // failure
      await jest.advanceTimersByTimeAsync(15000); // success

      // the health flag is owned by the caller, so a mock reconnect leaves the
      // cached status unhealthy and the next attempt counts as failure 1 again
      await jest.advanceTimersByTimeAsync(15000);

      const logged = logger.info.mock.calls.filter(([arg]) => arg && arg.consecutiveFailures !== undefined).map(([arg]) => arg.consecutiveFailures);
      expect(logged).toEqual([1, 2, 1]);
    });
  });

  describe('stopHealthMonitor', () => {
    it('stops further checks', async () => {
      health.setStartupHealth(true, true);
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      health.stopHealthMonitor();
      sequelize.authenticate.mockClear();
      await jest.advanceTimersByTimeAsync(60000);

      expect(sequelize.authenticate).not.toHaveBeenCalled();
    });

    it('logs that it stopped', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      health.stopHealthMonitor();

      expect(logger.info).toHaveBeenCalledWith('Database health monitor stopped');
    });

    it('does nothing when it was never started', () => {
      health.stopHealthMonitor();

      expect(logger.info).not.toHaveBeenCalledWith('Database health monitor stopped');
    });

    it('allows the monitor to be started again afterwards', async () => {
      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();
      health.stopHealthMonitor();

      health.startHealthMonitor(reinitializeDatabase, sequelize);
      await settle();

      expect(logger.warn).not.toHaveBeenCalledWith('Health monitor already running');
    });
  });
});
