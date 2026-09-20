import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { JellyfinSubfolderMappings, JellyfinSubfolderMapping } from '../JellyfinSubfolderMappings';
import { renderWithProviders } from '../../../../test-utils';
import { useSubfolders } from '../../../../hooks/useSubfolders';

jest.mock('axios', () => ({
  post: jest.fn(),
  isCancel: jest.fn(() => false),
  isAxiosError: jest.fn(() => false),
}));

jest.mock('../../../../hooks/useSubfolders', () => ({
  useSubfolders: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios');
const mockUseSubfolders = useSubfolders as jest.MockedFunction<typeof useSubfolders>;

const LIBRARIES = [
  { id: 'lib-1', title: 'YouTube' },
  { id: 'lib-2', title: 'Kids Shows' },
];

const DEFAULT_PROPS = {
  mappings: [] as JellyfinSubfolderMapping[],
  onMappingsChange: jest.fn(),
  token: 'test-token',
  jellyfinUrl: 'http://jellyfin:8096',
  jellyfinApiKey: 'key',
  jellyfinUserId: '',
};

const subfolderState = (overrides: Partial<ReturnType<typeof useSubfolders>> = {}): ReturnType<typeof useSubfolders> => ({
  subfolders: ['__kids', '__music'],
  loading: false,
  error: null,
  refetch: jest.fn(),
  createSubfolder: jest.fn(),
  deleteSubfolder: jest.fn(),
  ...overrides,
});

describe('JellyfinSubfolderMappings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ data: { libraries: LIBRARIES } });
    axios.isCancel.mockReturnValue(false);
    axios.isAxiosError.mockReturnValue(false);
    mockUseSubfolders.mockReturnValue(subfolderState());
  });

  const waitForLibraries = async () => {
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
  };

  describe('without credentials', () => {
    it('renders nothing when there are no mappings', () => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} jellyfinApiKey="" />);

      expect(screen.queryByText('Per-Subfolder Library Mappings')).not.toBeInTheDocument();
    });

    it.each([
      ['URL', { jellyfinUrl: '   ' }],
      ['API key', { jellyfinApiKey: '' }],
      ['token', { token: null }],
    ])('treats a missing %s as no credentials', (_label, overrides) => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} {...overrides} />);

      expect(screen.queryByText('Per-Subfolder Library Mappings')).not.toBeInTheDocument();
    });

    it('does not fetch libraries', () => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} jellyfinApiKey="" />);

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('keeps existing mappings visible so they can be removed', () => {
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} jellyfinApiKey="" mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }]} />
      );

      expect(screen.getByText('Per-Subfolder Library Mappings')).toBeInTheDocument();
      expect(screen.getByText('__kids')).toBeInTheDocument();
    });

    it('disables adding new mappings', () => {
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} jellyfinApiKey="" mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }]} />
      );

      expect(screen.getByTestId('add-jellyfin-mapping-button')).toBeDisabled();
    });

    it('still lets an existing mapping be removed', async () => {
      const user = userEvent.setup();
      const onMappingsChange = jest.fn();
      renderWithProviders(
        <JellyfinSubfolderMappings
          {...DEFAULT_PROPS}
          jellyfinApiKey=""
          onMappingsChange={onMappingsChange}
          mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }, { subfolder: null, libraryId: 'lib-1' }]}
        />
      );

      await user.click(screen.getByTestId('delete-jellyfin-mapping-kids'));

      expect(onMappingsChange).toHaveBeenCalledWith([{ subfolder: null, libraryId: 'lib-1' }]);
    });
  });

  describe('loading the Jellyfin libraries', () => {
    it('posts the trimmed connection details with the access token', async () => {
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} jellyfinUrl="  http://jellyfin:8096  " jellyfinApiKey=" key " jellyfinUserId=" user1 " />
      );

      await waitFor(() => expect(axios.post).toHaveBeenCalled());

      const [url, body, config] = axios.post.mock.calls[0];
      expect(url).toBe('/api/mediaservers/jellyfin/libraries');
      expect(body).toEqual({ jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'key', jellyfinUserId: 'user1' });
      expect(config.headers).toEqual({ 'x-access-token': 'test-token' });
    });

    it('omits a blank user id', async () => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} jellyfinUserId="   " />);

      await waitFor(() => expect(axios.post).toHaveBeenCalled());

      expect(axios.post.mock.calls[0][1].jellyfinUserId).toBeUndefined();
    });

    it('shows a loading indicator while it waits', async () => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      expect(await screen.findByText('Loading...')).toBeInTheDocument();
      await waitForLibraries();
    });

    it('shows the server\'s error message when the request fails', async () => {
      axios.isAxiosError.mockReturnValue(true);
      axios.post.mockRejectedValue({ response: { data: { error: 'Invalid API key' } } });

      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      expect(await screen.findByText('Invalid API key')).toBeInTheDocument();
    });

    it('shows a generic message when the failure has no server message', async () => {
      axios.post.mockRejectedValue(new Error('network'));

      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      expect(await screen.findByText('Failed to load Jellyfin libraries')).toBeInTheDocument();
    });

    it('shows a generic message when the server error is not text', async () => {
      axios.isAxiosError.mockReturnValue(true);
      axios.post.mockRejectedValue({ response: { data: { error: { code: 5 } } } });

      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      expect(await screen.findByText('Failed to load Jellyfin libraries')).toBeInTheDocument();
    });

    it('ignores a cancelled request', async () => {
      axios.isCancel.mockReturnValue(true);
      axios.post.mockRejectedValue(new Error('canceled'));

      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      await waitFor(() => expect(axios.post).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
      expect(screen.queryByText('Failed to load Jellyfin libraries')).not.toBeInTheDocument();
    });

    it('treats a response with no libraries as an empty list', async () => {
      axios.post.mockResolvedValue({ data: {} });

      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }]} />);
      await waitForLibraries();

      expect(screen.getByText(/lib-2/)).toBeInTheDocument();
    });

    it('warns when the channel subfolders cannot be loaded', () => {
      mockUseSubfolders.mockReturnValue(subfolderState({ error: new Error('boom') }));

      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      expect(screen.getByText(/Could not load channel subfolders/)).toBeInTheDocument();
    });

    it('only asks for subfolders when there are credentials', () => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} jellyfinApiKey="" />);

      expect(mockUseSubfolders).toHaveBeenCalledWith(null);
    });

    it('asks for subfolders with the token when connected', () => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      expect(mockUseSubfolders).toHaveBeenCalledWith('test-token');
    });
  });

  describe('the mapping table', () => {
    it('shows the library name and the subfolder for each mapping', async () => {
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }]} />
      );
      await waitForLibraries();

      expect(screen.getByText('__kids')).toBeInTheDocument();
      expect(screen.getByText('Kids Shows')).toBeInTheDocument();
    });

    it('labels the root folder mapping', async () => {
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} mappings={[{ subfolder: null, libraryId: 'lib-1' }]} />
      );
      await waitForLibraries();

      expect(screen.getByText('Root folder')).toBeInTheDocument();
      expect(screen.getByTestId('delete-jellyfin-mapping-root')).toBeInTheDocument();
    });

    it('labels the delete button for assistive technology', async () => {
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }]} />
      );
      await waitForLibraries();

      expect(screen.getByRole('button', { name: 'Remove mapping for __kids' })).toBeInTheDocument();
    });

    it('explains that everything triggers a full rescan when there are no mappings', async () => {
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);
      await waitForLibraries();

      expect(screen.getByText(/No per-subfolder mappings configured/)).toBeInTheDocument();
    });

    it('removes the right mapping', async () => {
      const user = userEvent.setup();
      const onMappingsChange = jest.fn();
      renderWithProviders(
        <JellyfinSubfolderMappings
          {...DEFAULT_PROPS}
          onMappingsChange={onMappingsChange}
          mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }, { subfolder: 'music', libraryId: 'lib-1' }]}
        />
      );
      await waitForLibraries();

      await user.click(screen.getByTestId('delete-jellyfin-mapping-music'));

      expect(onMappingsChange).toHaveBeenCalledWith([{ subfolder: 'kids', libraryId: 'lib-2' }]);
    });
  });

  describe('adding a mapping', () => {
    const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitForLibraries();
      await user.click(screen.getByTestId('add-jellyfin-mapping-button'));
    };

    it('shows the subfolder and library selects', async () => {
      const user = userEvent.setup();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      await openForm(user);

      expect(screen.getByRole('button', { name: 'Subfolder' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Jellyfin Library' })).toBeInTheDocument();
    });

    it('hides the add button while the form is open', async () => {
      const user = userEvent.setup();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      await openForm(user);

      expect(screen.queryByTestId('add-jellyfin-mapping-button')).not.toBeInTheDocument();
    });

    it('starts with Add disabled', async () => {
      const user = userEvent.setup();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);

      await openForm(user);

      expect(screen.getByTestId('confirm-add-jellyfin-mapping-button')).toBeDisabled();
    });

    it('keeps Add disabled until a library is chosen too', async () => {
      const user = userEvent.setup();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Subfolder' }));
      await user.click(screen.getByRole('option', { name: '__kids' }));

      expect(screen.getByTestId('confirm-add-jellyfin-mapping-button')).toBeDisabled();
    });

    it('adds the chosen subfolder and library', async () => {
      const user = userEvent.setup();
      const onMappingsChange = jest.fn();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} onMappingsChange={onMappingsChange} />);
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Subfolder' }));
      await user.click(screen.getByRole('option', { name: '__kids' }));
      await user.click(screen.getByRole('button', { name: 'Jellyfin Library' }));
      await user.click(screen.getByRole('option', { name: 'YouTube' }));
      await user.click(screen.getByTestId('confirm-add-jellyfin-mapping-button'));

      expect(onMappingsChange).toHaveBeenCalledWith([{ subfolder: 'kids', libraryId: 'lib-1' }]);
    });

    it('stores the root folder as a null subfolder', async () => {
      const user = userEvent.setup();
      const onMappingsChange = jest.fn();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} onMappingsChange={onMappingsChange} />);
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Subfolder' }));
      await user.click(screen.getByRole('option', { name: 'Root folder' }));
      await user.click(screen.getByRole('button', { name: 'Jellyfin Library' }));
      await user.click(screen.getByRole('option', { name: 'Kids Shows' }));
      await user.click(screen.getByTestId('confirm-add-jellyfin-mapping-button'));

      expect(onMappingsChange).toHaveBeenCalledWith([{ subfolder: null, libraryId: 'lib-2' }]);
    });

    it('appends to the existing mappings', async () => {
      const user = userEvent.setup();
      const onMappingsChange = jest.fn();
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} onMappingsChange={onMappingsChange} mappings={[{ subfolder: 'music', libraryId: 'lib-2' }]} />
      );
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Subfolder' }));
      await user.click(screen.getByRole('option', { name: '__kids' }));
      await user.click(screen.getByRole('button', { name: 'Jellyfin Library' }));
      await user.click(screen.getByRole('option', { name: 'YouTube' }));
      await user.click(screen.getByTestId('confirm-add-jellyfin-mapping-button'));

      expect(onMappingsChange).toHaveBeenCalledWith([
        { subfolder: 'music', libraryId: 'lib-2' },
        { subfolder: 'kids', libraryId: 'lib-1' },
      ]);
    });

    it('closes the form after adding', async () => {
      const user = userEvent.setup();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Subfolder' }));
      await user.click(screen.getByRole('option', { name: '__kids' }));
      await user.click(screen.getByRole('button', { name: 'Jellyfin Library' }));
      await user.click(screen.getByRole('option', { name: 'YouTube' }));
      await user.click(screen.getByTestId('confirm-add-jellyfin-mapping-button'));

      expect(screen.queryByRole('button', { name: 'Subfolder' })).not.toBeInTheDocument();
    });

    it('does not offer a subfolder that is already mapped', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <JellyfinSubfolderMappings {...DEFAULT_PROPS} mappings={[{ subfolder: 'kids', libraryId: 'lib-2' }]} />
      );
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Subfolder' }));

      expect(screen.getByRole('option', { name: '__kids' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('cancelling closes the form and leaves the mappings alone', async () => {
      const user = userEvent.setup();
      const onMappingsChange = jest.fn();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} onMappingsChange={onMappingsChange} />);
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('button', { name: 'Subfolder' })).not.toBeInTheDocument();
      expect(onMappingsChange).not.toHaveBeenCalled();
    });

    it('forgets the choices after cancelling', async () => {
      const user = userEvent.setup();
      renderWithProviders(<JellyfinSubfolderMappings {...DEFAULT_PROPS} />);
      await openForm(user);
      await user.click(screen.getByRole('button', { name: 'Subfolder' }));
      await user.click(screen.getByRole('option', { name: '__kids' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await user.click(screen.getByTestId('add-jellyfin-mapping-button'));

      expect(screen.getByTestId('confirm-add-jellyfin-mapping-button')).toBeDisabled();
    });
  });
});
