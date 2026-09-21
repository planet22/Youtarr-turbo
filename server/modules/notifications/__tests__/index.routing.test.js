/* eslint-env jest */

jest.mock('../../../logger');

// Which sender each service gets, the skip rules for empty runs, and how
// failures are reported. Senders are mocked; registry and formatters are real.
describe('notifications module routing', () => {
  let notifications;
  let senders;
  let logger;
  let configValues;

  const summary = (overrides = {}) => ({ totalDownloaded: 2, videos: [], ...overrides });
  const setUrls = (...entries) => { configValues = { notificationsEnabled: true, appriseUrls: entries }; };
  const url = (u, extra = {}) => ({ url: u, name: `n-${u}`, richFormatting: true, ...extra });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    senders = {
      appriseSender: { send: jest.fn().mockResolvedValue(), sendHtml: jest.fn().mockResolvedValue(), sendMarkdown: jest.fn().mockResolvedValue() },
      discordSender: { send: jest.fn().mockResolvedValue() },
    };
    configValues = { notificationsEnabled: true, appriseUrls: [] };

    jest.doMock('../senders', () => senders);
    jest.doMock('../../configModule', () => ({ getConfig: () => configValues }));

    logger = require('../../../logger');
    notifications = require('../index');
  });

  describe('configuration', () => {
    it('is configured only when enabled with at least one URL', () => {
      setUrls(url('discord://a/b'));
      expect(notifications.isConfigured()).toBe(true);

      configValues.notificationsEnabled = false;
      expect(notifications.isConfigured()).toBe(false);

      configValues = { notificationsEnabled: true, appriseUrls: [] };
      expect(notifications.isConfigured()).toBe(false);
    });

    it('treats a list that is not an array as empty', () => {
      expect(notifications.getUrlsFromConfig({ appriseUrls: 'discord://a/b' })).toEqual([]);
    });

    it('treats a missing list as empty', () => {
      expect(notifications.getUrlsFromConfig({})).toEqual([]);
    });

    it('turns a plain URL string into an entry named after its service', () => {
      expect(notifications.getUrlsFromConfig({ appriseUrls: ['discord://a/b'] })).toEqual([{ url: 'discord://a/b', name: 'Discord', richFormatting: true }]);
    });

    it('leaves rich formatting off for a plain string URL of a service without it', () => {
      expect(notifications.getUrlsFromConfig({ appriseUrls: ['pover://a/b'] })[0].richFormatting).toBe(false);
    });

    it('keeps rich formatting on unless an entry turns it off', () => {
      const [on, off] = notifications.getUrlsFromConfig({ appriseUrls: [{ url: 'discord://a', name: 'x' }, { url: 'discord://b', name: 'y', richFormatting: false }] });

      expect([on.richFormatting, off.richFormatting]).toEqual([true, false]);
    });

    it('names an object entry after its service when it has no name', () => {
      expect(notifications.getUrlsFromConfig({ appriseUrls: [{ url: 'tgram://a' }] })[0].name).toBe('Telegram');
    });

    it('drops entries with a blank URL', () => {
      expect(notifications.getUrlsFromConfig({ appriseUrls: [{ url: '   ' }, { name: 'no url' }, 'discord://a/b'] })).toHaveLength(1);
    });
  });

  describe('sending a download notification', () => {
    it('does nothing when notifications are not configured', async () => {
      configValues = { notificationsEnabled: false, appriseUrls: [url('discord://a')] };

      await notifications.sendDownloadNotification({ finalSummary: summary(), videoData: [] });

      expect(senders.discordSender.send).not.toHaveBeenCalled();
    });

    it.each([
      ['discord://a/b', 'discordSender', 'send'],
      ['slack://a/b/c', 'appriseSender', 'sendMarkdown'],
      ['tgram://a/b', 'appriseSender', 'sendHtml'],
      ['mailto://user:pw@example.com', 'appriseSender', 'sendHtml'],
      ['pover://a/b', 'appriseSender', 'send'],
      ['unknown://a/b', 'appriseSender', 'send'],
    ])('sends %s through %s.%s', async (u, sender, method) => {
      setUrls(url(u));

      await notifications.sendDownloadNotification({ finalSummary: summary(), videoData: [] });

      expect(senders[sender][method]).toHaveBeenCalledTimes(1);
    });

    it('sends the URL as the only target of an apprise call', async () => {
      setUrls(url('tgram://a/b'));

      await notifications.sendDownloadNotification({ finalSummary: summary(), videoData: [] });

      expect(senders.appriseSender.sendHtml.mock.calls[0][2]).toEqual(['tgram://a/b']);
    });

    it('uses plain text for a service when rich formatting is turned off', async () => {
      setUrls(url('discord://a/b', { richFormatting: false }));

      await notifications.sendDownloadNotification({ finalSummary: summary(), videoData: [] });

      expect(senders.discordSender.send).not.toHaveBeenCalled();
      expect(senders.appriseSender.send).toHaveBeenCalledTimes(1);
    });

    it('sends to every configured URL', async () => {
      setUrls(url('discord://a'), url('pover://b'));

      await notifications.sendDownloadNotification({ finalSummary: summary(), videoData: [] });

      expect(senders.discordSender.send).toHaveBeenCalledTimes(1);
      expect(senders.appriseSender.send).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['no videos and nothing else to report', summary({ totalDownloaded: 0 })],
      ['empty termination and diagnosis lists', summary({ totalDownloaded: 0, terminatedChannels: [], terminationFailures: [], diagnoses: [] })],
    ])('skips a run with %s', async (_label, finalSummary) => {
      setUrls(url('pover://a'));

      await notifications.sendDownloadNotification({ finalSummary, videoData: [] });

      expect(senders.appriseSender.send).not.toHaveBeenCalled();
    });

    it.each([
      ['a terminated channel', { terminatedChannels: ['c'] }],
      ['a termination failure', { terminationFailures: ['f'] }],
      ['a diagnosed failure', { diagnoses: [{ key: 'k' }] }],
    ])('still notifies for %s even with no new videos', async (_label, extra) => {
      setUrls(url('pover://a'));

      await notifications.sendDownloadNotification({ finalSummary: summary({ totalDownloaded: 0, ...extra }), videoData: [] });

      expect(senders.appriseSender.send).toHaveBeenCalledTimes(1);
    });

    it('logs a failed send and keeps sending to the others', async () => {
      setUrls(url('discord://a'), url('pover://b'));
      senders.discordSender.send.mockRejectedValue(new Error('webhook gone'));

      await notifications.sendDownloadNotification({ finalSummary: summary(), videoData: [] });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ name: 'n-discord://a' }), 'Failed to send notification');
      expect(senders.appriseSender.send).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ successCount: 1, totalCount: 2 }), 'Download notification sent successfully');
    });

    it('does not report success when every send failed', async () => {
      setUrls(url('pover://a'));
      senders.appriseSender.send.mockRejectedValue(new Error('down'));

      await notifications.sendDownloadNotification({ finalSummary: summary(), videoData: [] });

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Download notification sent successfully');
    });

    it('never throws when the summary is missing', async () => {
      setUrls(url('pover://a'));

      await expect(notifications.sendDownloadNotification({})).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to send download notification');
    });
  });

  describe('sending an auto-removal notification', () => {
    const removal = { totalDeleted: 3, plan: {}, deletedByAge: 3 };

    it('does nothing when notifications are not configured', async () => {
      configValues = { notificationsEnabled: false, appriseUrls: [] };

      await notifications.sendAutoRemovalNotification(removal);

      expect(senders.appriseSender.send).not.toHaveBeenCalled();
    });

    it.each([[null], [undefined], [{ totalDeleted: 0 }]])('skips a run that removed nothing (%p)', async (result) => {
      setUrls(url('pover://a'));

      await notifications.sendAutoRemovalNotification(result);

      expect(senders.appriseSender.send).not.toHaveBeenCalled();
    });

    it.each([
      ['discord://a', 'discordSender', 'send'],
      ['slack://a/b/c', 'appriseSender', 'sendMarkdown'],
      ['tgram://a', 'appriseSender', 'sendHtml'],
      ['pover://a', 'appriseSender', 'send'],
    ])('sends %s through %s.%s', async (u, sender, method) => {
      setUrls(url(u));

      await notifications.sendAutoRemovalNotification(removal);

      expect(senders[sender][method]).toHaveBeenCalledTimes(1);
    });

    it('logs a failed send and reports the others', async () => {
      setUrls(url('discord://a'), url('pover://b'));
      senders.discordSender.send.mockRejectedValue(new Error('gone'));

      await notifications.sendAutoRemovalNotification(removal);

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ name: 'n-discord://a' }), 'Failed to send auto-removal notification');
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ totalDeleted: 3, successCount: 1, totalCount: 2 }), 'Auto-removal notification sent successfully');
    });

    it('does not report success when every send failed', async () => {
      setUrls(url('pover://a'));
      senders.appriseSender.send.mockRejectedValue(new Error('down'));

      await notifications.sendAutoRemovalNotification(removal);

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Auto-removal notification sent successfully');
    });
  });

  describe('sending a test notification to every URL', () => {
    it('fails when nothing is configured', async () => {
      await expect(notifications.sendTestNotification()).rejects.toThrow('No notification URLs are configured');
    });

    it('sends to every URL, each with its own formatting', async () => {
      setUrls(url('discord://a'), url('tgram://b'), url('pover://c'));

      await notifications.sendTestNotification();

      expect(senders.discordSender.send).toHaveBeenCalledTimes(1);
      expect(senders.appriseSender.sendHtml).toHaveBeenCalledTimes(1);
      expect(senders.appriseSender.send).toHaveBeenCalledTimes(1);
    });

    it('works even when notifications are switched off', async () => {
      configValues = { notificationsEnabled: false, appriseUrls: [url('pover://a')] };

      await expect(notifications.sendTestNotification()).resolves.toBeUndefined();
    });

    it('reports every failure when all sends fail', async () => {
      setUrls(url('discord://a'), url('pover://b'));
      senders.discordSender.send.mockRejectedValue(new Error('bad webhook'));
      senders.appriseSender.send.mockRejectedValue(new Error('apprise missing'));

      await expect(notifications.sendTestNotification()).rejects.toThrow('n-discord://a: bad webhook; n-pover://b: apprise missing');
    });

    it('reports the failing service when only some of the sends fail', async () => {
      setUrls(url('discord://a'), url('pover://b'));
      senders.discordSender.send.mockRejectedValue(new Error('bad webhook'));

      await expect(notifications.sendTestNotification()).rejects.toMatchObject({ message: 'n-discord://a: bad webhook' });
    });

    it('still sends to the working services when one fails', async () => {
      setUrls(url('discord://a'), url('pover://b'));
      senders.discordSender.send.mockRejectedValue(new Error('bad webhook'));

      await notifications.sendTestNotification().catch(() => {});

      expect(senders.appriseSender.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('sending a test notification to one URL', () => {
    it.each([[undefined], [''], ['   ']])('requires a URL (%p)', async (u) => {
      await expect(notifications.sendTestNotificationToSingle({ url: u, name: 'x' })).rejects.toThrow('Notification URL is required');
    });

    it.each([
      ['discord://a', 'discordSender', 'send'],
      ['slack://a/b/c', 'appriseSender', 'sendMarkdown'],
      ['tgram://a', 'appriseSender', 'sendHtml'],
      ['pover://a', 'appriseSender', 'send'],
    ])('sends %s through %s.%s', async (u, sender, method) => {
      await notifications.sendTestNotificationToSingle({ url: u, name: 'Test', richFormatting: true });

      expect(senders[sender][method]).toHaveBeenCalledTimes(1);
    });

    it('uses plain text when rich formatting is off', async () => {
      await notifications.sendTestNotificationToSingle({ url: 'discord://a', name: 'Test', richFormatting: false });

      expect(senders.discordSender.send).not.toHaveBeenCalled();
      expect(senders.appriseSender.send).toHaveBeenCalledTimes(1);
    });

    it('propagates a send failure', async () => {
      senders.appriseSender.send.mockRejectedValue(new Error('down'));

      await expect(notifications.sendTestNotificationToSingle({ url: 'pover://a', name: 'x' })).rejects.toThrow('down');
    });
  });
});
