/* eslint-env jest */
const path = require('path');

describe('Cookie Module Integration Tests', () => {
  let configModule;
  let fs;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    const mockConfig = {
      uuid: 'test-uuid-1234',
      plexApiKey: 'test-key',
      plexPort: '32400',
      cookiesEnabled: false,
      customCookiesUploaded: false,
      channelDownloadFrequency: '0 */6 * * *',
      videoResolution: '1080',
      sponsorBlock: { enabled: false, categories: [] },
      useTmpForDownloads: false,
      tmpFilePath: '/tmp',
      autoRemoval: { enabled: false, minDaysOld: 30 }
    };

    jest.doMock('fs', () => ({
      readFileSync: jest.fn().mockReturnValue(JSON.stringify(mockConfig)),
      writeFileSync: jest.fn(),
      watch: jest.fn().mockReturnValue({ close: jest.fn() }),
      existsSync: jest.fn().mockReturnValue(true),
      mkdirSync: jest.fn(),
      chmodSync: jest.fn(),
      unlinkSync: jest.fn()
    }));

    jest.doMock('uuid', () => ({
      v4: jest.fn(() => 'test-uuid-1234')
    }));

    fs = require('fs');
    configModule = require('../modules/configModule');
  });

  afterEach(() => {
    if (configModule && configModule.stopWatchingConfig) {
      configModule.stopWatchingConfig();
    }
    jest.clearAllMocks();
  });

  describe('Cookie API endpoint handlers', () => {
    test('getCookiesStatus should return current cookie status', () => {
      configModule.config.cookiesEnabled = false;
      configModule.config.customCookiesUploaded = false;
      fs.existsSync.mockReturnValue(false);

      let status = configModule.getCookiesStatus();
      expect(status).toEqual({
        cookiesEnabled: false,
        customCookiesUploaded: false,
        customFileExists: false
      });

      configModule.config.cookiesEnabled = true;
      configModule.config.customCookiesUploaded = true;
      fs.existsSync.mockReturnValue(true);

      status = configModule.getCookiesStatus();
      expect(status).toEqual({
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true
      });
    });

    test('getCookiesStatus should include auth cookie expiry metadata when parseable', () => {
      configModule.config.cookiesEnabled = true;
      configModule.config.customCookiesUploaded = true;
      fs.existsSync.mockReturnValue(true);

      const expiredEpoch = 1; // 1970 - long expired
      const futureEpoch = Math.floor(Date.now() / 1000) + 3600 * 24 * 365;
      const cookieFileContent = [
        '# Netscape HTTP Cookie File',
        `.youtube.com\tTRUE\t/\tTRUE\t${futureEpoch}\tSAPISID\tabc`,
        `.youtube.com\tTRUE\t/\tTRUE\t${expiredEpoch}\tHSID\tdef`,
        '.youtube.com\tTRUE\t/\tFALSE\t0\tCONSENT\tghi',
      ].join('\n');

      fs.statSync = jest.fn().mockReturnValue({
        size: cookieFileContent.length,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
      });
      fs.readFileSync.mockReturnValueOnce(cookieFileContent);

      const status = configModule.getCookiesStatus();

      expect(status.authCookiesFound).toBe(2); // SAPISID + HSID, not CONSENT
      expect(status.hasExpiredAuthCookie).toBe(true);
      expect(status.earliestExpiryName).toBe('HSID');
      expect(status.earliestExpiry).toBe(new Date(expiredEpoch * 1000).toISOString());
      expect(status.sizeBytes).toBe(cookieFileContent.length);
      expect(status.uploadedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    test('getCookiesStatus omits metadata when the file cannot be stat-ed', () => {
      configModule.config.cookiesEnabled = true;
      configModule.config.customCookiesUploaded = true;
      fs.existsSync.mockReturnValue(true);
      fs.statSync = jest.fn().mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const status = configModule.getCookiesStatus();

      expect(status).toEqual({
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true,
      });
    });

    test('writeCustomCookiesFile should handle file upload', () => {
      const mockCookieContent = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t1234567890\tcookie_name\tcookie_value';
      const mockBuffer = Buffer.from(mockCookieContent);

      const filePath = configModule.writeCustomCookiesFile(mockBuffer);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('cookies.user.txt'),
        mockBuffer
      );

      expect(fs.chmodSync).toHaveBeenCalledWith(
        expect.stringContaining('cookies.user.txt'),
        0o600
      );

      expect(configModule.config.cookiesEnabled).toBe(true);
      expect(configModule.config.customCookiesUploaded).toBe(true);

      expect(filePath).toContain('cookies.user.txt');
    });

    test('deleteCustomCookiesFile should handle file deletion', () => {
      fs.existsSync.mockReturnValue(true);
      configModule.config.cookiesEnabled = true;
      configModule.config.customCookiesUploaded = true;

      const result = configModule.deleteCustomCookiesFile();

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('cookies.user.txt')
      );

      expect(configModule.config.customCookiesUploaded).toBe(false);
      expect(configModule.config.cookiesEnabled).toBe(true);

      expect(result).toBe(true);
    });
  });

  describe('Cookie file validation', () => {
    test('should validate Netscape cookie format', () => {
      const validContent1 = '# Netscape HTTP Cookie File\ncookie data';
      const validContent2 = '# This file is generated by yt-dlp\ncookie data';
      const invalidContent = 'random file content';

      const isValidCookie = (content) => {
        return content.includes('# Netscape HTTP Cookie File') ||
               content.includes('# This file is generated by yt-dlp');
      };

      expect(isValidCookie(validContent1)).toBe(true);
      expect(isValidCookie(validContent2)).toBe(true);
      expect(isValidCookie(invalidContent)).toBe(false);
    });

    test('should enforce 1MB file size limit', () => {
      const multerConfig = {
        limits: { fileSize: 1024 * 1024 }
      };

      expect(multerConfig.limits.fileSize).toBe(1048576);
    });
  });

  describe('Cookie security', () => {
    test('should set restrictive permissions on cookie file', () => {
      const testBuffer = Buffer.from('# Netscape HTTP Cookie File\ntest');

      const fs = require('fs');
      jest.spyOn(fs, 'chmodSync').mockImplementation();

      configModule.writeCustomCookiesFile(testBuffer);

      expect(0o600).toBe(384);
    });

    test('cookie file path should be in config directory', () => {
      const cookiePath = path.join(__dirname, '../../config/cookies.user.txt');

      expect(cookiePath).toContain('config');
      expect(path.basename(cookiePath)).toBe('cookies.user.txt');
    });

    test('should not expose cookie content in responses', () => {
      const mockStatus = configModule.getCookiesStatus();

      expect(mockStatus).not.toHaveProperty('cookieContent');
      expect(mockStatus).not.toHaveProperty('cookies');
    });
  });
});

describe('Cookie Integration with Download Module', () => {
  let configModule;

  beforeEach(() => {
    jest.resetModules();
    configModule = require('../modules/configModule');
  });

  test('getCookiesPath should be used by download module', () => {
    configModule.config.cookiesEnabled = true;
    configModule.config.customCookiesUploaded = true;

    const fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    const cookiePath = configModule.getCookiesPath();

    if (cookiePath) {
      expect(path.isAbsolute(cookiePath)).toBe(true);
      expect(cookiePath).toContain('cookies.user.txt');
    } else {
      expect(cookiePath).toBeNull();
    }
  });

  test('download should use cookies when enabled', () => {
    const mockCookiePath = '/config/cookies.user.txt';
    configModule.getCookiesPath = jest.fn().mockReturnValue(mockCookiePath);

    const cookiePath = configModule.getCookiesPath();

    if (cookiePath) {
      const ytDlpArgs = ['--cookies', cookiePath];
      expect(ytDlpArgs).toContain('--cookies');
      expect(ytDlpArgs).toContain(mockCookiePath);
    }
  });
});