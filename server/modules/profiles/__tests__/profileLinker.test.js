/* eslint-env jest */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const profileLinker = require('../profileLinker');

const ID = 'abc123def45';
const OTHER_ID = 'zzz999yyy88';

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function inode(file) {
  return fs.statSync(file).ino;
}

describe('profileLinker', () => {
  let base;
  let profileRoot;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-linker-'));
    profileRoot = path.join(base, '__profiles__', 'Alice');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('nested video folder', () => {
    let videoDir;
    let video;

    beforeEach(() => {
      videoDir = path.join(base, '__Kids', 'Chan', `Chan - Title - ${ID}`);
      write(path.join(videoDir, `Chan - Title [${ID}].mp4`));
      write(path.join(videoDir, `Chan - Title [${ID}].nfo`));
      write(path.join(videoDir, 'poster.jpg'));
      write(path.join(base, '__Kids', 'Chan', 'poster.jpg'));
      write(path.join(base, '__Kids', 'Chan', 'Chan.m3u'));
      video = { youtubeId: ID, filePath: path.join(videoDir, `Chan - Title [${ID}].mp4`) };
    });

    test('links the media file as a hardlink of the library file', async () => {
      await profileLinker.linkVideo(base, 'Alice', video);
      const linked = path.join(profileRoot, 'Chan', `Chan - Title - ${ID}`, `Chan - Title [${ID}].mp4`);
      expect(inode(linked)).toBe(inode(video.filePath));
    });

    test('returns every file of the video folder as its link paths', async () => {
      const paths = await profileLinker.linkVideo(base, 'Alice', video);
      expect(paths.map((p) => path.basename(p)).sort()).toEqual([`Chan - Title [${ID}].mp4`, `Chan - Title [${ID}].nfo`, 'poster.jpg']);
    });

    test('links the channel poster as a shared sidecar', async () => {
      await profileLinker.linkVideo(base, 'Alice', video);
      expect(fs.existsSync(path.join(profileRoot, 'Chan', 'poster.jpg'))).toBe(true);
    });

    test('does not link the channel .m3u file', async () => {
      await profileLinker.linkVideo(base, 'Alice', video);
      expect(fs.existsSync(path.join(profileRoot, 'Chan', 'Chan.m3u'))).toBe(false);
    });

    test('is idempotent when run twice', async () => {
      await profileLinker.linkVideo(base, 'Alice', video);
      await expect(profileLinker.linkVideo(base, 'Alice', video)).resolves.toHaveLength(3);
    });

    test('replaces a stale link after the library file is re-downloaded', async () => {
      await profileLinker.linkVideo(base, 'Alice', video);
      fs.rmSync(video.filePath);
      write(video.filePath, 'new');
      await profileLinker.linkVideo(base, 'Alice', video);
      const linked = path.join(profileRoot, 'Chan', `Chan - Title - ${ID}`, `Chan - Title [${ID}].mp4`);
      expect(inode(linked)).toBe(inode(video.filePath));
    });

    test('unlinking removes the whole channel folder once no media is left', async () => {
      const paths = await profileLinker.linkVideo(base, 'Alice', video);
      await profileLinker.unlinkPaths(base, 'Alice', paths);
      expect(fs.existsSync(path.join(profileRoot, 'Chan'))).toBe(false);
    });

    test('unlinking leaves the library file in place', async () => {
      const paths = await profileLinker.linkVideo(base, 'Alice', video);
      await profileLinker.unlinkPaths(base, 'Alice', paths);
      expect(fs.existsSync(video.filePath)).toBe(true);
    });

    test('unlinking keeps the profile root folder', async () => {
      const paths = await profileLinker.linkVideo(base, 'Alice', video);
      await profileLinker.unlinkPaths(base, 'Alice', paths);
      expect(fs.existsSync(profileRoot)).toBe(true);
    });
  });

  describe('flat channel folder', () => {
    let chanDir;
    let video;

    beforeEach(() => {
      chanDir = path.join(base, 'Chan');
      write(path.join(chanDir, `One [${ID}].mp4`));
      write(path.join(chanDir, `One [${ID}].jpg`));
      write(path.join(chanDir, `Two [${OTHER_ID}].mp4`));
      write(path.join(chanDir, 'poster.jpg'));
      video = { youtubeId: ID, filePath: path.join(chanDir, `One [${ID}].mp4`) };
    });

    test('links only the files carrying the video id', async () => {
      const paths = await profileLinker.linkVideo(base, 'Alice', video);
      expect(paths.map((p) => path.basename(p)).sort()).toEqual([`One [${ID}].jpg`, `One [${ID}].mp4`]);
    });

    test('does not link other videos in the same folder', async () => {
      await profileLinker.linkVideo(base, 'Alice', video);
      expect(fs.existsSync(path.join(profileRoot, 'Chan', `Two [${OTHER_ID}].mp4`))).toBe(false);
    });

    test('unlinking keeps the channel folder while another video is still linked', async () => {
      const paths = await profileLinker.linkVideo(base, 'Alice', video);
      await profileLinker.linkVideo(base, 'Alice', { youtubeId: OTHER_ID, filePath: path.join(chanDir, `Two [${OTHER_ID}].mp4`) });
      await profileLinker.unlinkPaths(base, 'Alice', paths);
      expect(fs.existsSync(path.join(profileRoot, 'Chan', `Two [${OTHER_ID}].mp4`))).toBe(true);
    });
  });

  test('returns no paths when the video file no longer exists', async () => {
    const video = { youtubeId: ID, filePath: path.join(base, 'Chan', `Gone [${ID}].mp4`) };
    await expect(profileLinker.linkVideo(base, 'Alice', video)).resolves.toEqual([]);
  });

  test('unlinkPaths refuses to delete files outside the profile folder', async () => {
    const outside = path.join(base, 'Chan', `One [${ID}].mp4`);
    write(outside);
    await profileLinker.unlinkPaths(base, 'Alice', [outside]);
    expect(fs.existsSync(outside)).toBe(true);
  });

  test('renameProfileRoot moves the profile folder', async () => {
    await profileLinker.ensureProfileRoot(base, 'Alice');
    await profileLinker.renameProfileRoot(base, 'Alice', 'Bob');
    expect(fs.existsSync(path.join(base, '__profiles__', 'Bob'))).toBe(true);
  });

  test('removeProfileRoot deletes the profile folder', async () => {
    await profileLinker.ensureProfileRoot(base, 'Alice');
    await profileLinker.removeProfileRoot(base, 'Alice');
    expect(fs.existsSync(profileRoot)).toBe(false);
  });

  test('removeProfileRoot refuses a name that escapes the profiles directory', async () => {
    await expect(profileLinker.removeProfileRoot(base, '..')).rejects.toThrow('Refusing to remove');
  });
});
