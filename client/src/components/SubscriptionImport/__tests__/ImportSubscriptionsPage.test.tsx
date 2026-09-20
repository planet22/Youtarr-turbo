import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import ImportSubscriptionsPage from '../index';
import { ReviewChannel } from '../../../types/subscriptionImport';

const mockNavigate = jest.fn();
const mockUpload = jest.fn();
let mockUploadState: { loading: boolean; error: { details?: string } | null } = { loading: false, error: null };
let mockJobDetail: { status: string; id?: string } | null = null;

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
jest.mock('axios', () => {
  class MockAxiosError extends Error {
    response?: { data?: { error?: string } };
    constructor(message: string, response?: { data?: { error?: string } }) {
      super(message);
      this.response = response;
    }
  }
  const post = jest.fn();
  return { __esModule: true, default: { post }, AxiosError: MockAxiosError };
});
jest.mock('../hooks/usePreviewUpload', () => ({
  usePreviewUpload: () => ({ ...mockUploadState, upload: mockUpload }),
}));
jest.mock('../hooks/useImportJob', () => ({
  useImportJob: (jobId: string | null) => ({ jobDetail: jobId ? mockJobDetail : null }),
}));
jest.mock('../../../hooks/useSubfolders', () => ({
  useSubfolders: () => ({ subfolders: ['Music'], createSubfolder: jest.fn() }),
}));
jest.mock('../../../hooks/useConfig', () => ({
  useConfig: () => ({ config: { defaultSubfolder: 'Default', preferredResolution: '720' } }),
}));

function mockEl(tag: string, props: Record<string, unknown> | null, ...children: unknown[]) {
  return require('react').createElement(tag, props, ...children);
}

jest.mock('../components/SourcePicker', () => ({
  __esModule: true,
  default: (props: { loading: boolean; error: string | null; errorDetails?: string; onSubmit: (s: string, f: File) => void }) =>
    mockEl('div', null,
      mockEl('span', null, `picker loading:${props.loading}`),
      props.error ? mockEl('span', null, `picker error:${props.error}`) : null,
      props.errorDetails ? mockEl('span', null, `picker details:${props.errorDetails}`) : null,
      mockEl('button', { type: 'button', onClick: () => props.onSubmit('takeout', new File(['x'], 'subs.csv')) }, 'submit-source')),
}));
jest.mock('../components/DisclaimerBanner', () => ({ __esModule: true, default: () => mockEl('div', null, 'disclaimer') }));
jest.mock('../components/BulkActionsBar', () => ({
  __esModule: true,
  default: (props: { onStartImport: () => void; importDisabled: boolean; dispatch: (a: { type: string }) => void }) =>
    mockEl('div', null,
      mockEl('span', null, `bulk disabled:${props.importDisabled}`),
      mockEl('button', { type: 'button', onClick: props.onStartImport }, 'start-import'),
      mockEl('button', { type: 'button', onClick: () => props.dispatch({ type: 'DESELECT_ALL' }) }, 'deselect-all')),
}));
jest.mock('../components/ReviewTable', () => ({
  __esModule: true,
  default: (props: { channels: { title: string }[]; defaultSubfolderDisplay: string | null; globalPreferredResolution: string }) =>
    mockEl('div', null,
      mockEl('span', null, `table default:${props.defaultSubfolderDisplay} res:${props.globalPreferredResolution}`),
      ...props.channels.map((c) => mockEl('span', { key: c.title }, `row:${c.title}`))),
}));
jest.mock('../components/ImportProgress', () => ({
  __esModule: true,
  default: (props: { jobDetail: { status: string }; onCancel: () => void }) =>
    mockEl('div', null,
      mockEl('span', null, `progress:${props.jobDetail.status}`),
      mockEl('button', { type: 'button', onClick: props.onCancel }, 'cancel-import')),
}));
jest.mock('../components/ImportSummary', () => ({
  __esModule: true,
  default: (props: { jobDetail: { status: string } }) => mockEl('div', null, `summary:${props.jobDetail.status}`),
}));
jest.mock('../components/RecentImportsSection', () => ({
  __esModule: true,
  default: (props: { currentPhase: string }) => mockEl('div', null, `recent:${props.currentPhase}`),
}));

const axios = require('axios').default;

const channel = (id: string, overrides: Partial<ReviewChannel> = {}): ReviewChannel => ({
  channelId: id,
  url: `https://youtube.com/channel/${id}`,
  title: `Channel ${id}`,
  alreadySubscribed: false,
  ...overrides,
} as ReviewChannel);

function renderPage(path = '/subscriptions/import') {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <ImportSubscriptionsPage token="tok" />
    </MemoryRouter>
  );
  return utils;
}

async function reachReview(channels: ReviewChannel[]) {
  mockUpload.mockResolvedValue({ channels });
  await userEvent.click(screen.getByRole('button', { name: 'submit-source' }));
  await screen.findByText('disclaimer');
}

describe('ImportSubscriptionsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadState = { loading: false, error: null };
    mockJobDetail = null;
  });

  describe('header', () => {
    it('explains the page', () => {
      renderPage();

      expect(screen.getByText('Import Channels')).toBeInTheDocument();
      expect(screen.getByText(/Preview subscriptions, tune per-channel defaults/)).toBeInTheDocument();
    });

    it('goes back to the channels list', async () => {
      renderPage();

      await userEvent.click(screen.getByRole('button', { name: 'Back to channels' }));

      expect(mockNavigate).toHaveBeenCalledWith('/subscriptions');
    });
  });

  describe('choosing a source', () => {
    it('starts on the source picker and the recent imports list', () => {
      renderPage();

      expect(screen.getByText('picker loading:false')).toBeInTheDocument();
      expect(screen.getByText('recent:source')).toBeInTheDocument();
    });

    it('passes the upload state to the picker', () => {
      mockUploadState = { loading: true, error: { details: 'Bad header row' } };
      renderPage();

      expect(screen.getByText('picker loading:true')).toBeInTheDocument();
      expect(screen.getByText('picker details:Bad header row')).toBeInTheDocument();
    });

    it('uploads the file for the chosen source', async () => {
      renderPage();
      await reachReview([channel('a')]);

      expect(mockUpload).toHaveBeenCalledWith('takeout', expect.any(File));
    });

    it('moves on to reviewing the channels', async () => {
      renderPage();

      await reachReview([channel('a'), channel('b')]);

      expect(screen.getByText('row:Channel a')).toBeInTheDocument();
      expect(screen.getByText('row:Channel b')).toBeInTheDocument();
      expect(screen.queryByText(/picker loading/)).not.toBeInTheDocument();
    });

    it('shows the upload error and stays on the picker', async () => {
      mockUpload.mockRejectedValue(new Error('Not a takeout file'));
      renderPage();

      await userEvent.click(screen.getByRole('button', { name: 'submit-source' }));

      expect(await screen.findByText('picker error:Not a takeout file')).toBeInTheDocument();
    });

    it('uses a generic message for a non-Error failure', async () => {
      mockUpload.mockRejectedValue('nope');
      renderPage();

      await userEvent.click(screen.getByRole('button', { name: 'submit-source' }));

      expect(await screen.findByText('picker error:Upload failed')).toBeInTheDocument();
    });
  });

  describe('reviewing', () => {
    it('shows the global defaults to the table', async () => {
      renderPage();

      await reachReview([channel('a')]);

      expect(screen.getByText('table default:Default res:720')).toBeInTheDocument();
    });

    it('leaves importing enabled when no upload is running', async () => {
      renderPage();
      await reachReview([channel('a')]);

      expect(screen.getByText('bulk disabled:false')).toBeInTheDocument();
    });

    it('starts an import of the selected channels only', async () => {
      axios.post.mockResolvedValue({ data: { jobId: 'job-9' } });
      renderPage();
      await reachReview([channel('a'), channel('b', { alreadySubscribed: true })]);

      await userEvent.click(screen.getByRole('button', { name: 'start-import' }));

      await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
        '/api/subscriptions/imports',
        { channels: [expect.objectContaining({ channelId: 'a', url: 'https://youtube.com/channel/a', title: 'Channel a', settings: expect.any(Object) })] },
        { headers: { 'x-access-token': 'tok' } }
      ));
      expect(axios.post.mock.calls[0][1].channels).toHaveLength(1);
    });

    it('moves to the importing phase once the job starts', async () => {
      axios.post.mockResolvedValue({ data: { jobId: 'job-9' } });
      renderPage();
      await reachReview([channel('a')]);

      await userEvent.click(screen.getByRole('button', { name: 'start-import' }));

      expect(await screen.findByText('Loading import progress…')).toBeInTheDocument();
      expect(screen.getByText('recent:importing')).toBeInTheDocument();
    });

    it('does nothing when no channel is selected', async () => {
      renderPage();
      await reachReview([channel('a')]);
      await userEvent.click(screen.getByRole('button', { name: 'deselect-all' }));

      await userEvent.click(screen.getByRole('button', { name: 'start-import' }));

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('shows the server error when starting fails', async () => {
      const { AxiosError } = require('axios');
      axios.post.mockRejectedValue(new AxiosError('Request failed', { data: { error: 'Too many channels' } }));
      renderPage();
      await reachReview([channel('a')]);

      await userEvent.click(screen.getByRole('button', { name: 'start-import' }));

      expect(await screen.findByText('picker error:Too many channels')).toBeInTheDocument();
    });

    it('falls back to the request message when the server sends none', async () => {
      const { AxiosError } = require('axios');
      axios.post.mockRejectedValue(new AxiosError('Request failed', { data: {} }));
      renderPage();
      await reachReview([channel('a')]);

      await userEvent.click(screen.getByRole('button', { name: 'start-import' }));

      expect(await screen.findByText('picker error:Request failed')).toBeInTheDocument();
    });

    it('uses a generic message for a non-axios failure', async () => {
      axios.post.mockRejectedValue(new Error('boom'));
      renderPage();
      await reachReview([channel('a')]);

      await userEvent.click(screen.getByRole('button', { name: 'start-import' }));

      expect(await screen.findByText('picker error:Failed to start import')).toBeInTheDocument();
    });
  });

  describe('resuming a job from the url', () => {
    it('jumps straight to the importing phase for ?job=', async () => {
      renderPage('/subscriptions/import?job=job-5');

      expect(await screen.findByText('Loading import progress…')).toBeInTheDocument();
      expect(screen.queryByText(/picker loading/)).not.toBeInTheDocument();
    });

    it('shows the job progress once it loads', async () => {
      mockJobDetail = { status: 'In Progress' };
      renderPage('/subscriptions/import?job=job-5');

      expect(await screen.findByText('progress:In Progress')).toBeInTheDocument();
    });
  });

  describe('importing', () => {
    it('cancels the running job', async () => {
      axios.post.mockResolvedValue({});
      mockJobDetail = { status: 'In Progress' };
      renderPage('/subscriptions/import?job=job-5');

      await userEvent.click(await screen.findByRole('button', { name: 'cancel-import' }));

      expect(axios.post).toHaveBeenCalledWith('/api/subscriptions/imports/job-5/cancel', {}, { headers: { 'x-access-token': 'tok' } });
    });

    it('ignores a failed cancel', async () => {
      axios.post.mockRejectedValue(new Error('gone'));
      mockJobDetail = { status: 'In Progress' };
      renderPage('/subscriptions/import?job=job-5');

      await userEvent.click(await screen.findByRole('button', { name: 'cancel-import' }));

      await waitFor(() => expect(axios.post).toHaveBeenCalled());
      expect(screen.getByText('progress:In Progress')).toBeInTheDocument();
    });

    it('shows the summary once the job stops being in progress', async () => {
      mockJobDetail = { status: 'In Progress' };
      const { rerender } = renderPage('/subscriptions/import?job=job-5');
      await screen.findByText('progress:In Progress');

      mockJobDetail = { status: 'Complete' };
      rerender(
        <MemoryRouter initialEntries={['/subscriptions/import?job=job-5']}>
          <ImportSubscriptionsPage token="tok" />
        </MemoryRouter>
      );

      expect(await screen.findByText('summary:Complete')).toBeInTheDocument();
      expect(screen.getByText('recent:complete')).toBeInTheDocument();
    });
  });
});
