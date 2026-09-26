import { renderHook, act } from '@testing-library/react';
import Hls from 'hls.js';
import { useHlsPipPlayer } from '../useHlsPipPlayer';

interface MockHlsInstance {
  handlers: Record<string, (...args: unknown[]) => void>;
  on: jest.Mock;
  loadSource: jest.Mock;
  attachMedia: jest.Mock;
  destroy: jest.Mock;
}

let instances: MockHlsInstance[] = [];

jest.mock('hls.js', () => {
  function MockHls(this: MockHlsInstance) {
    this.handlers = {};
    this.on = jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      this.handlers[event] = cb;
    });
    this.loadSource = jest.fn();
    this.attachMedia = jest.fn();
    this.destroy = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    instances.push(this);
  }
  MockHls.isSupported = jest.fn();
  MockHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
  MockHls.ErrorDetails = {
    MANIFEST_LOAD_ERROR: 'manifestLoadError',
    MANIFEST_PARSING_ERROR: 'manifestParsingError',
    MANIFEST_LOAD_TIMEOUT: 'manifestLoadTimeOut',
    FRAG_LOAD_ERROR: 'fragLoadError',
    FRAG_LOAD_TIMEOUT: 'fragLoadTimeOut',
  };
  return { __esModule: true, default: MockHls };
});

function makeFakeVideo(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  const video = document.createElement('video');
  video.play = jest.fn().mockResolvedValue(undefined);
  video.pause = jest.fn();
  video.load = jest.fn();
  (video as unknown as { requestPictureInPicture: jest.Mock }).requestPictureInPicture =
    jest.fn().mockResolvedValue({});
  Object.assign(video, overrides);
  return video;
}

describe('useHlsPipPlayer', () => {
  beforeEach(() => {
    instances = [];
    (Hls.isSupported as jest.Mock).mockReturnValue(true);
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    Object.defineProperty(document, 'pictureInPictureElement', { value: null, configurable: true });
    document.exitPictureInPicture = jest.fn().mockResolvedValue(undefined);
  });

  test('starts with no active video', () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    expect(result.current.state.youtubeId).toBeNull();
  });

  test('play() loads the ytstream URL through hls.js', () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = makeFakeVideo();

    act(() => result.current.play('abc123', 'My Video', 'test-token'));

    expect(result.current.state).toMatchObject({ youtubeId: 'abc123', title: 'My Video', status: 'loading' });
    expect(instances).toHaveLength(1);
    expect(instances[0].loadSource).toHaveBeenCalledWith('/api/ytstream/abc123?pipPreview=1&token=test-token');
    expect(instances[0].attachMedia).toHaveBeenCalled();
  });

  test('moves to pip status once the manifest parses and PiP is granted', async () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    const video = makeFakeVideo();
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = video;

    act(() => result.current.play('abc123', 'My Video', 'test-token'));
    await act(async () => {
      await instances[0].handlers.hlsManifestParsed();
    });

    expect(video.play).toHaveBeenCalled();
    expect(video.requestPictureInPicture).toHaveBeenCalled();
    expect(result.current.state.status).toBe('pip');
  });

  test('keeps playing inline when PiP is refused', async () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    const video = makeFakeVideo();
    (video.requestPictureInPicture as jest.Mock).mockRejectedValue(new Error('nope'));
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = video;

    act(() => result.current.play('abc123', 'My Video', 'test-token'));
    await act(async () => {
      await instances[0].handlers.hlsManifestParsed();
    });

    expect(result.current.state.status).toBe('playing');
  });

  test('falls back to a direct <video src> when the manifest fails to parse', async () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    const video = makeFakeVideo();
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = video;

    act(() => result.current.play('abc123', 'My Video', 'test-token'));
    act(() => {
      instances[0].handlers.hlsError({}, { fatal: true, details: 'manifestLoadError' });
    });

    expect(instances[0].destroy).toHaveBeenCalled();
    expect(video.getAttribute('src')).toBe('/api/ytstream/abc123?pipPreview=1&token=test-token');

    await act(async () => {
      video.dispatchEvent(new Event('loadedmetadata'));
      await Promise.resolve();
    });
    expect(video.play).toHaveBeenCalled();
  });

  test('surfaces a non-manifest fatal error instead of falling back', () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = makeFakeVideo();

    act(() => result.current.play('abc123', 'My Video', 'test-token'));
    act(() => {
      instances[0].handlers.hlsError({}, { fatal: true, details: 'bufferStalledError' });
    });

    expect(result.current.state).toMatchObject({ status: 'error', errorMessage: 'bufferStalledError' });
    expect(instances[0].destroy).not.toHaveBeenCalled();
  });

  test('translates a fragment-load CORS failure into a plain-language message', () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = makeFakeVideo();

    act(() => result.current.play('abc123', 'My Video', 'test-token'));
    act(() => {
      instances[0].handlers.hlsError({}, { fatal: true, details: 'fragLoadError' });
    });

    expect(result.current.state.status).toBe('error');
    expect(result.current.state.errorMessage).toMatch(/browsers block/i);
  });

  test('does not attempt playback without a token', () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = makeFakeVideo();

    act(() => result.current.play('abc123', 'My Video', null));

    expect(instances).toHaveLength(0);
    expect(result.current.state).toMatchObject({ youtubeId: 'abc123', status: 'error' });
  });

  test('a stale callback from a superseded play() call does not overwrite the current video', async () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = makeFakeVideo();

    act(() => result.current.play('first', 'First Video', 'test-token'));
    const firstInstance = instances[0];
    act(() => result.current.play('second', 'Second Video', 'test-token'));

    await act(async () => {
      await firstInstance.handlers.hlsManifestParsed();
    });

    expect(result.current.state.youtubeId).toBe('second');
  });

  test('close() exits Picture-in-Picture and resets state', () => {
    const { result } = renderHook(() => useHlsPipPlayer());
    const video = makeFakeVideo();
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = video;
    Object.defineProperty(document, 'pictureInPictureElement', { value: video, configurable: true });

    act(() => result.current.play('abc123', 'My Video', 'test-token'));
    act(() => result.current.close());

    expect(document.exitPictureInPicture).toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
    expect(result.current.state.youtubeId).toBeNull();
  });
});
