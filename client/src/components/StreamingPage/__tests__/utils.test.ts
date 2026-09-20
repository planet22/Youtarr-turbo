import { formatBytesPerSecond, formatStreamRate, formatStreamTotal } from '../utils';

describe('formatBytesPerSecond', () => {
  it('shows zero as bytes per second', () => {
    expect(formatBytesPerSecond(0)).toBe('0 B/s');
  });

  it('scales a slow rate to KB/s', () => {
    expect(formatBytesPerSecond(10 * 1024)).toBe('10.0 KB/s');
  });

  it('scales a fast rate to MB/s', () => {
    expect(formatBytesPerSecond(22.5 * 1024 * 1024)).toBe('22.5 MB/s');
  });

  it('scales a very fast rate to GB/s', () => {
    expect(formatBytesPerSecond(2 * 1024 * 1024 * 1024)).toBe('2.00 GB/s');
  });

  it('never shows a negative rate', () => {
    expect(formatBytesPerSecond(-5)).toBe('0 B/s');
  });
});

describe('formatStreamTotal / formatStreamRate', () => {
  it('shows an exact total without a marker', () => {
    expect(formatStreamTotal({ bytesTransferred: 2 * 1024 * 1024 })).toBe('2.0 MB');
  });

  it('marks an estimated total with a tilde', () => {
    expect(formatStreamTotal({ bytesTransferred: 2 * 1024 * 1024, bytesEstimated: true })).toBe('~2.0 MB');
  });

  it('shows a missing total as zero', () => {
    expect(formatStreamTotal({ bytesTransferred: null })).toBe('0 B');
  });

  it('marks an estimated rate with a tilde', () => {
    expect(formatStreamRate({ bytesPerSecond: 1024, bytesEstimated: true })).toBe('~1.0 KB/s');
  });

  it('shows an exact rate without a marker', () => {
    expect(formatStreamRate({ bytesPerSecond: 1024 })).toBe('1.0 KB/s');
  });
});
