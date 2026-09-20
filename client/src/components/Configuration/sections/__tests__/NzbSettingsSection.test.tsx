import React from 'react';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { NzbSettingsSection } from '../NzbSettingsSection';
import { renderWithProviders } from '../../../../test-utils';
import { ConfigState } from '../../types';
import { DEFAULT_CONFIG } from '../../../../config/configSchema';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), delete: jest.fn() }));
const axios = require('axios');

type Nzb = ConfigState['nzb'];
type Category = Nzb['categories'][number];

const buildCategory = (overrides: Partial<Category> = {}): Category => ({
  name: 'sonarr',
  subfolder: 'Sonarr',
  mediaMode: 'download',
  searchMode: 'flat',
  importStrategy: 'hardlink',
  newznabCategoryIds: ['5040'],
  additionalLocalFilter: false,
  excludeTerms: [],
  postEncode: false,
  ...overrides,
});

const buildConfig = (nzb: Partial<Nzb> = {}): ConfigState => ({
  ...DEFAULT_CONFIG,
  nzb: { ...DEFAULT_CONFIG.nzb, ...nzb },
});

function renderSection(nzb: Partial<Nzb> = {}, token: string | null = 'tok') {
  const onConfigChange = jest.fn();
  const onMobileTooltipClick = jest.fn();
  const utils = renderWithProviders(
    <NzbSettingsSection
      config={buildConfig(nzb)}
      token={token}
      onConfigChange={onConfigChange}
      onMobileTooltipClick={onMobileTooltipClick}
    />
  );
  return { ...utils, onConfigChange, onMobileTooltipClick };
}

// The nzb object passed to the most recent onConfigChange call
const lastNzb = (onConfigChange: jest.Mock): Nzb => onConfigChange.mock.calls[onConfigChange.mock.calls.length - 1][0].nzb;

describe('NzbSettingsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockImplementation(async (url: string) => {
      if (url === '/api/nzb/diagnostic-logs') return { data: { count: 5 } };
      if (url === '/api/nzb/resolution-cache') return { data: { count: 12 } };
      return { data: {} };
    });
    axios.delete.mockResolvedValue({});
    axios.post.mockResolvedValue({ data: { apiKey: 'new-key-123' } });
  });

  describe('header', () => {
    it('renders the section title', () => {
      renderSection();

      expect(screen.getByText('Sonarr / Radarr / Prowlarr (NZB)')).toBeInTheDocument();
    });

    it('reflects the debug logging setting', () => {
      renderSection({ debugLogging: true });

      expect(screen.getByLabelText('NZB debug logging')).toBeChecked();
    });

    it('toggles debug logging', async () => {
      const { onConfigChange } = renderSection({ debugLogging: false });

      await userEvent.click(screen.getByLabelText('NZB debug logging'));

      expect(lastNzb(onConfigChange).debugLogging).toBe(true);
    });

    it('toggles the integration on and off', async () => {
      const { onConfigChange } = renderSection({ enabled: false });

      await userEvent.click(screen.getByLabelText('Enable NZB integration'));

      expect(lastNzb(onConfigChange).enabled).toBe(true);
    });

    it('keeps the rest of the nzb settings when changing one', async () => {
      const { onConfigChange } = renderSection({ apiKey: 'keep-me', enabled: false });

      await userEvent.click(screen.getByLabelText('Enable NZB integration'));

      expect(lastNzb(onConfigChange).apiKey).toBe('keep-me');
    });
  });

  describe('API key', () => {
    it('offers Generate when there is no key yet', () => {
      renderSection({ apiKey: '' });

      expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    });

    it('offers Regenerate when a key exists', () => {
      renderSection({ apiKey: 'abc' });

      expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    });

    it('starts with the key masked and can reveal it', async () => {
      renderSection({ apiKey: 'abc' });

      await userEvent.click(screen.getByRole('button', { name: 'Show NZB API key' }));

      expect(screen.getByRole('button', { name: 'Hide NZB API key' })).toBeInTheDocument();
    });

    it('can hide the key again', async () => {
      renderSection({ apiKey: 'abc' });
      await userEvent.click(screen.getByRole('button', { name: 'Show NZB API key' }));

      await userEvent.click(screen.getByRole('button', { name: 'Hide NZB API key' }));

      expect(screen.getByRole('button', { name: 'Show NZB API key' })).toBeInTheDocument();
    });

    it('requests a new key with the access token', async () => {
      renderSection({ apiKey: '' });

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

      await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/nzb/regenerate-key', {}, { headers: { 'x-access-token': 'tok' } }));
    });

    it('stores the new key and reveals it', async () => {
      const { onConfigChange } = renderSection({ apiKey: '' });

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

      await waitFor(() => expect(lastNzb(onConfigChange).apiKey).toBe('new-key-123'));
      expect(await screen.findByRole('button', { name: 'Hide NZB API key' })).toBeInTheDocument();
    });

    it('is disabled and labelled while generating', async () => {
      axios.post.mockReturnValue(new Promise(() => {}));
      renderSection({ apiKey: '' });

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

      expect(await screen.findByRole('button', { name: 'Generating...' })).toBeDisabled();
    });

    it('shows the error message when generating fails', async () => {
      axios.post.mockRejectedValue(new Error('Server exploded'));
      renderSection({ apiKey: '' });

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

      expect(await screen.findByText('Server exploded')).toBeInTheDocument();
    });

    it('uses a generic message for a non-Error failure', async () => {
      axios.post.mockRejectedValue('nope');
      renderSection({ apiKey: '' });

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

      expect(await screen.findByText('Failed to generate key')).toBeInTheDocument();
    });

    it('sends an empty token header when there is no token', async () => {
      renderSection({ apiKey: '' }, null);

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

      await waitFor(() => expect(axios.post.mock.calls[0][2]).toEqual({ headers: { 'x-access-token': '' } }));
    });
  });

  describe('basic settings', () => {
    it('sets the remote base path', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Path Sonarr/Radarr sees this folder as'), { target: { value: '/data' } });

      expect(lastNzb(onConfigChange).remoteBasePath).toBe('/data');
    });

    it('stores a blank remote base path as null', () => {
      const { onConfigChange } = renderSection({ remoteBasePath: '/data' });

      fireEvent.change(screen.getByLabelText('Path Sonarr/Radarr sees this folder as'), { target: { value: '' } });

      expect(lastNzb(onConfigChange).remoteBasePath).toBeNull();
    });

    it('sets the search cache minutes', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Search result cache (minutes)'), { target: { value: '30' } });

      expect(lastNzb(onConfigChange).searchCacheMinutes).toBe(30);
    });

    it('does not allow a negative cache time', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Search result cache (minutes)'), { target: { value: '-4' } });

      expect(lastNzb(onConfigChange).searchCacheMinutes).toBe(0);
    });

    it('treats a cleared cache time as 0', () => {
      const { onConfigChange } = renderSection({ searchCacheMinutes: 20 });

      fireEvent.change(screen.getByLabelText('Search result cache (minutes)'), { target: { value: '' } });

      expect(lastNzb(onConfigChange).searchCacheMinutes).toBe(0);
    });
  });

  describe('video actual resolution', () => {
    it('reflects the configured checks', () => {
      renderSection({ resolutionDetection: { fixed: true, thumb: false, extract: true } });

      expect(screen.getByLabelText('Fixed (previously downloaded)')).toBeChecked();
      expect(screen.getByLabelText('Thumbnail check')).not.toBeChecked();
      expect(screen.getByLabelText('Real extraction (accurate, slower)')).toBeChecked();
    });

    it('turns the fixed check off', async () => {
      const { onConfigChange } = renderSection({ resolutionDetection: { fixed: true, thumb: true, extract: false } });

      await userEvent.click(screen.getByLabelText('Fixed (previously downloaded)'));

      expect(lastNzb(onConfigChange).resolutionDetection).toEqual({ fixed: false, thumb: true, extract: false });
    });

    it('turns the thumbnail check off', async () => {
      const { onConfigChange } = renderSection({ resolutionDetection: { fixed: true, thumb: true, extract: false } });

      await userEvent.click(screen.getByLabelText('Thumbnail check'));

      expect(lastNzb(onConfigChange).resolutionDetection).toEqual({ fixed: true, thumb: false, extract: false });
    });

    it('turns real extraction on', async () => {
      const { onConfigChange } = renderSection({ resolutionDetection: { fixed: true, thumb: true, extract: false } });

      await userEvent.click(screen.getByLabelText('Real extraction (accurate, slower)'));

      expect(lastNzb(onConfigChange).resolutionDetection).toEqual({ fixed: true, thumb: true, extract: true });
    });

    it('uses the documented defaults when none are configured', () => {
      renderSection({ resolutionDetection: undefined });

      expect(screen.getByLabelText('Fixed (previously downloaded)')).toBeChecked();
      expect(screen.getByLabelText('Thumbnail check')).toBeChecked();
      expect(screen.getByLabelText('Real extraction (accurate, slower)')).not.toBeChecked();
    });

    it('does not warn while at least one check is on', () => {
      renderSection({ resolutionDetection: { fixed: false, thumb: false, extract: true } });

      expect(screen.queryByText(/All resolution checks are off/)).not.toBeInTheDocument();
    });

    it('warns when every check is off', () => {
      renderSection({ resolutionDetection: { fixed: false, thumb: false, extract: false } });

      expect(screen.getByText(/All resolution checks are off/)).toBeInTheDocument();
    });
  });

  describe('diagnostic log limits', () => {
    it('shows the configured limits', () => {
      renderSection({ diagnosticLogLimits: { recentQueries: 11, searchTraces: 22, failedGrabs: 33 } });

      expect(screen.getByLabelText('Recent queries')).toHaveValue(11);
      expect(screen.getByLabelText('Search debug traces')).toHaveValue(22);
      expect(screen.getByLabelText('Failed grabs')).toHaveValue(33);
    });

    it('uses the defaults when no limits are configured', () => {
      renderSection({ diagnosticLogLimits: undefined });

      expect(screen.getByLabelText('Recent queries')).toHaveValue(50);
      expect(screen.getByLabelText('Search debug traces')).toHaveValue(20);
    });

    it.each([
      ['Recent queries', 'recentQueries'],
      ['Search debug traces', 'searchTraces'],
      ['Failed grabs', 'failedGrabs'],
    ] as const)('updates only the %s limit', (label, key) => {
      const { onConfigChange } = renderSection({ diagnosticLogLimits: { recentQueries: 50, searchTraces: 20, failedGrabs: 20 } });

      fireEvent.change(screen.getByLabelText(label), { target: { value: '40' } });

      expect(lastNzb(onConfigChange).diagnosticLogLimits).toEqual({ recentQueries: 50, searchTraces: 20, failedGrabs: 20, [key]: 40 });
    });

    it('caps a limit at 100', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Recent queries'), { target: { value: '5000' } });

      expect(lastNzb(onConfigChange).diagnosticLogLimits?.recentQueries).toBe(100);
    });

    it('raises a limit below 1 to 1', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Recent queries'), { target: { value: '0' } });

      expect(lastNzb(onConfigChange).diagnosticLogLimits?.recentQueries).toBe(1);
    });

    it('treats a cleared limit as 1', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Recent queries'), { target: { value: '' } });

      expect(lastNzb(onConfigChange).diagnosticLogLimits?.recentQueries).toBe(1);
    });

    it('shows the stored row count', async () => {
      renderSection();

      expect(await screen.findByText('Stored rows: 5')).toBeInTheDocument();
    });

    it('shows a placeholder until the count loads', () => {
      axios.get.mockReturnValue(new Promise(() => {}));
      renderSection();

      expect(screen.getByText('Stored rows: …')).toBeInTheDocument();
    });

    it('disables Clear when nothing is stored', async () => {
      axios.get.mockImplementation(async () => ({ data: { count: 0 } }));
      renderSection();
      await screen.findByText('Stored rows: 0');

      expect(screen.getAllByRole('button', { name: 'Clear' })[0]).toBeDisabled();
    });

    it('shows the load error', async () => {
      axios.get.mockRejectedValue({ response: { data: { error: 'Table missing' } } });
      renderSection();

      expect((await screen.findAllByText('Table missing')).length).toBeGreaterThan(0);
    });

    describe('clear confirmation', () => {
      async function openDialog() {
        const utils = renderSection();
        await screen.findByText('Stored rows: 5');
        await userEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]);
        return { ...utils, dialog: await screen.findByRole('dialog') };
      }

      it('asks for confirmation before deleting anything', async () => {
        const { dialog } = await openDialog();

        expect(within(dialog).getByText('Clear Diagnostic Logs')).toBeInTheDocument();
        expect(axios.delete).not.toHaveBeenCalled();
      });

      it('states how many rows will be removed', async () => {
        const { dialog } = await openDialog();

        expect(within(dialog).getByText(/permanently deletes 5 stored rows/)).toBeInTheDocument();
      });

      it('cancels without deleting', async () => {
        const { dialog } = await openDialog();

        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(axios.delete).not.toHaveBeenCalled();
      });

      it('deletes the logs once confirmed', async () => {
        const { dialog } = await openDialog();

        await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));

        await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/nzb/diagnostic-logs', { headers: { 'x-access-token': 'tok' } }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      });
    });

    it('uses the singular for a single stored row', async () => {
      axios.get.mockImplementation(async (url: string) => ({ data: { count: url === '/api/nzb/diagnostic-logs' ? 1 : 0 } }));
      renderSection();
      await screen.findByText('Stored rows: 1');

      await userEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]);

      expect(await screen.findByText(/permanently deletes 1 stored row across/)).toBeInTheDocument();
    });
  });

  describe('NZB video cache', () => {
    it('defaults the limit to 5000', () => {
      renderSection({ videoResolutionCacheLimit: undefined });

      expect(screen.getByLabelText('Max cached videos')).toHaveValue(5000);
    });

    it('sets the limit', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Max cached videos'), { target: { value: '2500' } });

      expect(lastNzb(onConfigChange).videoResolutionCacheLimit).toBe(2500);
    });

    it('caps the limit at 10,000', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Max cached videos'), { target: { value: '99999' } });

      expect(lastNzb(onConfigChange).videoResolutionCacheLimit).toBe(10000);
    });

    it('raises the limit to at least 100', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Max cached videos'), { target: { value: '5' } });

      expect(lastNzb(onConfigChange).videoResolutionCacheLimit).toBe(100);
    });

    it('treats a cleared limit as 100', () => {
      const { onConfigChange } = renderSection();

      fireEvent.change(screen.getByLabelText('Max cached videos'), { target: { value: '' } });

      expect(lastNzb(onConfigChange).videoResolutionCacheLimit).toBe(100);
    });

    it('shows the cached video count', async () => {
      renderSection();

      expect(await screen.findByText('Cached videos: 12')).toBeInTheDocument();
    });

    describe('clear confirmation', () => {
      async function openDialog() {
        renderSection();
        await screen.findByText('Cached videos: 12');
        await userEvent.click(screen.getAllByRole('button', { name: 'Clear' })[1]);
        return screen.findByRole('dialog');
      }

      it('states how many cached resolutions will be removed', async () => {
        const dialog = await openDialog();

        expect(within(dialog).getByText('Clear NZB Video Cache')).toBeInTheDocument();
        expect(within(dialog).getByText(/permanently deletes 12 cached video resolutions/)).toBeInTheDocument();
      });

      it('cancels without deleting', async () => {
        const dialog = await openDialog();

        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(axios.delete).not.toHaveBeenCalled();
      });

      it('clears the cache once confirmed', async () => {
        const dialog = await openDialog();

        await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));

        await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/nzb/resolution-cache', { headers: { 'x-access-token': 'tok' } }));
      });
    });
  });

  describe('categories', () => {
    it('shows no category rows when none are configured', () => {
      renderSection({ categories: [] });

      expect(screen.queryByRole('button', { name: 'Remove category' })).not.toBeInTheDocument();
    });

    it('shows a row for every category', () => {
      renderSection({ categories: [buildCategory({ name: 'sonarr' }), buildCategory({ name: 'radarr' })] });

      expect(screen.getAllByRole('button', { name: 'Remove category' })).toHaveLength(2);
      expect(screen.getByDisplayValue('sonarr')).toBeInTheDocument();
      expect(screen.getByDisplayValue('radarr')).toBeInTheDocument();
    });

    it('adds a blank category with sensible defaults', async () => {
      const { onConfigChange } = renderSection({ categories: [buildCategory()] });

      await userEvent.click(screen.getByRole('button', { name: 'Add Category' }));

      expect(lastNzb(onConfigChange).categories).toHaveLength(2);
      expect(lastNzb(onConfigChange).categories[1]).toEqual({
        name: '',
        subfolder: '',
        mediaMode: 'download',
        searchMode: 'flat',
        importStrategy: 'hardlink',
        newznabCategoryIds: ['5040'],
        additionalLocalFilter: false,
        excludeTerms: [],
        postEncode: false,
      });
    });

    it('removes the chosen category', async () => {
      const { onConfigChange } = renderSection({ categories: [buildCategory({ name: 'sonarr' }), buildCategory({ name: 'radarr' })] });

      await userEvent.click(screen.getAllByRole('button', { name: 'Remove category' })[0]);

      expect(lastNzb(onConfigChange).categories.map((c) => c.name)).toEqual(['radarr']);
    });

    it('renames a category without touching the others', () => {
      const { onConfigChange } = renderSection({ categories: [buildCategory({ name: 'sonarr' }), buildCategory({ name: 'radarr' })] });

      fireEvent.change(screen.getByDisplayValue('radarr'), { target: { value: 'movies' } });

      expect(lastNzb(onConfigChange).categories.map((c) => c.name)).toEqual(['sonarr', 'movies']);
    });

    it('sets the subfolder', () => {
      const { onConfigChange } = renderSection({ categories: [buildCategory({ subfolder: 'Sonarr' })] });

      fireEvent.change(screen.getByDisplayValue('Sonarr'), { target: { value: 'TV' } });

      expect(lastNzb(onConfigChange).categories[0].subfolder).toBe('TV');
    });

    it('stores a cleared subfolder as null', () => {
      const { onConfigChange } = renderSection({ categories: [buildCategory({ subfolder: 'Sonarr' })] });

      fireEvent.change(screen.getByDisplayValue('Sonarr'), { target: { value: '' } });

      expect(lastNzb(onConfigChange).categories[0].subfolder).toBeNull();
    });

    it('toggles the additional local filter', async () => {
      const { onConfigChange } = renderSection({ categories: [buildCategory({ additionalLocalFilter: false })] });

      await userEvent.click(screen.getByLabelText('Additional local filter'));

      expect(lastNzb(onConfigChange).categories[0].additionalLocalFilter).toBe(true);
    });

    it('toggles transcoding before reporting complete', async () => {
      const { onConfigChange } = renderSection({ categories: [buildCategory({ postEncode: false })] });

      await userEvent.click(screen.getByLabelText('Transcode before reporting complete'));

      expect(lastNzb(onConfigChange).categories[0].postEncode).toBe(true);
    });

    describe('exclude terms', () => {
      it('shows the terms one per line', () => {
        renderSection({ categories: [buildCategory({ excludeTerms: ['trailer', 'advert'] })] });

        expect(screen.getByLabelText('Exclude if title contains')).toHaveValue('trailer\nadvert');
      });

      it('splits, trims and drops blank lines when edited', () => {
        const { onConfigChange } = renderSection({ categories: [buildCategory()] });

        fireEvent.change(screen.getByLabelText('Exclude if title contains'), { target: { value: ' trailer \n\n outtakes\n  ' } });

        expect(lastNzb(onConfigChange).categories[0].excludeTerms).toEqual(['trailer', 'outtakes']);
      });

      it('shows an empty box for a category with no terms property', () => {
        renderSection({ categories: [buildCategory({ excludeTerms: undefined })] });

        expect(screen.getByLabelText('Exclude if title contains')).toHaveValue('');
      });
    });

    describe('Newznab categories', () => {
      it('summarises the selected categories', () => {
        renderSection({ categories: [buildCategory({ newznabCategoryIds: ['5040', '2040'] })] });

        expect(screen.getByRole('button', { name: /5040 - TV HD \(Sonarr\), 2040 - Movies HD \(Radarr\)/ })).toBeInTheDocument();
      });

      it('says when none are selected', () => {
        renderSection({ categories: [buildCategory({ newznabCategoryIds: [] })] });

        expect(screen.getByRole('button', { name: /None selected/ })).toBeInTheDocument();
      });

      it('adds a category id when an unchecked option is chosen', async () => {
        const { onConfigChange } = renderSection({ categories: [buildCategory({ newznabCategoryIds: ['5040'] })] });
        await userEvent.click(screen.getByRole('button', { name: /5040 - TV HD/ }));

        await userEvent.click(await screen.findByText('5000 - TV (Sonarr, general)'));

        expect(lastNzb(onConfigChange).categories[0].newznabCategoryIds).toEqual(['5040', '5000']);
      });

      it('removes a category id when a checked option is chosen', async () => {
        const { onConfigChange } = renderSection({ categories: [buildCategory({ newznabCategoryIds: ['5040', '5000'] })] });
        await userEvent.click(screen.getByRole('button', { name: /5040 - TV HD/ }));

        await userEvent.click(await screen.findByText('5000 - TV (Sonarr, general)'));

        expect(lastNzb(onConfigChange).categories[0].newznabCategoryIds).toEqual(['5040']);
      });
    });

    describe('importing exclude terms from a file', () => {
      // The file input is hidden with no label or role, so grab it when the
      // Import button clicks it rather than querying the DOM for it.
      let clickedInputs: HTMLInputElement[];
      let clickSpy: jest.SpyInstance;

      beforeEach(() => {
        clickedInputs = [];
        clickSpy = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
          clickedInputs.push(this);
        });
      });

      afterEach(() => {
        clickSpy.mockRestore();
      });

      async function pickFile(file: File, categories: Category[] = [buildCategory()]) {
        const utils = renderSection({ categories });
        await userEvent.click(screen.getAllByRole('button', { name: /Import \.txt/ })[0]);
        fireEvent.change(clickedInputs[0], { target: { files: [file] } });
        return utils;
      }

      const textFile = (contents: string, name = 'terms.txt') => new File([contents], name, { type: 'text/plain' });

      it('opens the file picker', async () => {
        renderSection({ categories: [buildCategory()] });

        await userEvent.click(screen.getByRole('button', { name: /Import \.txt/ }));

        expect(clickedInputs).toHaveLength(1);
        expect(clickedInputs[0].accept).toBe('.txt,text/plain');
      });

      it('replaces the terms with the file contents, one per line', async () => {
        const { onConfigChange } = await pickFile(textFile('trailer\r\n advert \n\nouttakes\n'));

        await waitFor(() => expect(lastNzb(onConfigChange).categories[0].excludeTerms).toEqual(['trailer', 'advert', 'outtakes']));
      });

      it('rejects a file that is not .txt', async () => {
        await pickFile(textFile('x', 'terms.csv'));

        expect(await screen.findByText('Only .txt files can be imported.')).toBeInTheDocument();
      });

      it('accepts an upper-case .TXT extension', async () => {
        const { onConfigChange } = await pickFile(textFile('one', 'TERMS.TXT'));

        await waitFor(() => expect(lastNzb(onConfigChange).categories[0].excludeTerms).toEqual(['one']));
      });

      it('rejects a file over 256KB', async () => {
        const file = textFile('x');
        Object.defineProperty(file, 'size', { value: 256 * 1024 + 1 });

        await pickFile(file);

        expect(await screen.findByText(/File is too large \(max 256KB\)/)).toBeInTheDocument();
      });

      it('rejects binary content', async () => {
        await pickFile(textFile('abc\u0000def'));

        expect(await screen.findByText(/doesn't look like a plain text file/)).toBeInTheDocument();
      });

      it('rejects content dense with control characters', async () => {
        await pickFile(textFile('\u0001\u0002\u0003\u0004abc'));

        expect(await screen.findByText(/doesn't look like a plain text file/)).toBeInTheDocument();
      });

      it('rejects a file with no terms in it', async () => {
        await pickFile(textFile('\n  \n\n'));

        expect(await screen.findByText('That file has no terms in it.')).toBeInTheDocument();
      });

      it('does not change the terms when the file is rejected', async () => {
        const { onConfigChange } = await pickFile(textFile('x', 'terms.csv'));

        expect(onConfigChange).not.toHaveBeenCalled();
      });

      it('ignores the change event when no file was chosen', async () => {
        const { onConfigChange } = renderSection({ categories: [buildCategory()] });
        await userEvent.click(screen.getByRole('button', { name: /Import \.txt/ }));

        fireEvent.change(clickedInputs[0], { target: { files: [] } });

        expect(onConfigChange).not.toHaveBeenCalled();
      });

      it('clears an earlier error when the import button is pressed again', async () => {
        await pickFile(textFile('x', 'terms.csv'));
        await screen.findByText('Only .txt files can be imported.');

        await userEvent.click(screen.getAllByRole('button', { name: /Import \.txt/ })[0]);

        expect(screen.queryByText('Only .txt files can be imported.')).not.toBeInTheDocument();
      });

      it('applies an import to the right category', async () => {
        const utils = renderSection({ categories: [buildCategory({ name: 'sonarr' }), buildCategory({ name: 'radarr' })] });
        await userEvent.click(screen.getAllByRole('button', { name: /Import \.txt/ })[1]);

        fireEvent.change(clickedInputs[0], { target: { files: [textFile('promo')] } });

        await waitFor(() => expect(lastNzb(utils.onConfigChange).categories.map((c) => c.excludeTerms)).toEqual([[], ['promo']]));
      });
    });
  });
});
