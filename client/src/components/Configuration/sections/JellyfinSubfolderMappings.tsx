import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useSubfolders } from '../../../hooks/useSubfolders';
import { stripSubfolderPrefix } from '../../../utils/subfolderDisplay';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '../../ui';
import { Add as AddIcon, Delete as DeleteIcon } from '../../../lib/icons';
import { JellyfinLibrary, resolveLibraryDisplay } from '../../../utils/jellyfinLibraries';
import { PlexLibraryLabel } from './components/PlexLibraryLabel';

export interface JellyfinSubfolderMapping {
  subfolder: string | null;
  libraryId: string;
}

interface JellyfinSubfolderMappingsProps {
  mappings: JellyfinSubfolderMapping[];
  onMappingsChange: (mappings: JellyfinSubfolderMapping[]) => void;
  token: string | null;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  jellyfinUserId: string;
}

/** Mirrors PlexSubfolderMappings' ROOT_SELECT_VALUE sentinel. */
const ROOT_SELECT_VALUE = '__YOUTARR_ROOT_LIBRARY_MAPPING__';

const selectValueToSubfolder = (value: string): string | null =>
  value === ROOT_SELECT_VALUE ? null : stripSubfolderPrefix(value);

const formatMappingSubfolder = (subfolder: string | null): string =>
  subfolder ? `__${subfolder}` : 'Root folder';

/**
 * Per-subfolder Jellyfin library mapping - same UI/behavior as
 * PlexSubfolderMappings, but Jellyfin has no shared "connection status" hook
 * (unlike usePlexConnection), so this component fetches its own library list
 * from the currently-entered (not necessarily saved) Jellyfin URL/API key/user,
 * mirroring how MediaServerPlaylistSection's own Test Connection/user-list
 * fetches already work off those same unsaved form values.
 */
export const JellyfinSubfolderMappings: React.FC<JellyfinSubfolderMappingsProps> = ({
  mappings,
  onMappingsChange,
  token,
  jellyfinUrl,
  jellyfinApiKey,
  jellyfinUserId,
}) => {
  const [newSubfolder, setNewSubfolder] = useState<string>('');
  const [newLibraryId, setNewLibraryId] = useState<string>('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [jellyfinLibraries, setJellyfinLibraries] = useState<JellyfinLibrary[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(false);
  const [librariesError, setLibrariesError] = useState<string | null>(null);

  const hasCredentials = Boolean(jellyfinUrl.trim() && jellyfinApiKey.trim() && token);

  useEffect(() => {
    if (!hasCredentials) {
      setJellyfinLibraries([]);
      return;
    }
    let cancelled = false;
    setLoadingLibraries(true);
    setLibrariesError(null);
    axios
      .post<{ libraries: JellyfinLibrary[] }>(
        '/api/mediaservers/jellyfin/libraries',
        { jellyfinUrl: jellyfinUrl.trim(), jellyfinApiKey: jellyfinApiKey.trim(), jellyfinUserId: jellyfinUserId.trim() || undefined },
        { headers: { 'x-access-token': token || '' } }
      )
      .then((res) => {
        if (!cancelled) setJellyfinLibraries(res.data.libraries || []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          (axios.isAxiosError(err) && err.response?.data?.error) ||
          'Failed to load Jellyfin libraries';
        setLibrariesError(typeof message === 'string' ? message : 'Failed to load Jellyfin libraries');
        setJellyfinLibraries([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingLibraries(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasCredentials, jellyfinUrl, jellyfinApiKey, jellyfinUserId, token]);

  const { subfolders, loading: loadingSubfolders, error: subfolderFetchError } = useSubfolders(hasCredentials ? token : null);

  const loadingData = loadingLibraries || loadingSubfolders;

  const isMappingDuplicate = (subfolder: string | null): boolean =>
    mappings.some((m) => m.subfolder === subfolder);

  const handleAddMapping = () => {
    if (!newSubfolder || !newLibraryId) return;

    const subfolder = selectValueToSubfolder(newSubfolder);
    if (isMappingDuplicate(subfolder)) return;

    onMappingsChange([...mappings, { subfolder, libraryId: newLibraryId }]);
    setNewSubfolder('');
    setNewLibraryId('');
    setShowAddForm(false);
  };

  const handleDeleteMapping = (subfolder: string | null) => {
    onMappingsChange(mappings.filter((m) => m.subfolder !== subfolder));
  };

  const isAddDisabled =
    !newSubfolder ||
    !newLibraryId ||
    isMappingDuplicate(selectValueToSubfolder(newSubfolder));

  // When disconnected and no mappings exist yet, the whole section is unnecessary noise.
  // When disconnected but mappings exist, keep the table visible so users can delete entries.
  if (!hasCredentials && mappings.length === 0) {
    return null;
  }

  return (
    <Box className="mt-4">
      <Divider className="mb-4" />
      <Box className="flex items-center justify-between mb-2">
        <Typography variant="subtitle2">
          Per-Subfolder Library Mappings
        </Typography>
        {!showAddForm && (
          <Tooltip title={!hasCredentials ? 'Enter Jellyfin URL and API key above to add new mappings' : ''}>
            <span>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setShowAddForm(true)}
                data-testid="add-jellyfin-mapping-button"
                disabled={loadingData || !hasCredentials}
              >
                Add Mapping
              </Button>
            </span>
          </Tooltip>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary" className="block mb-4">
        Map each subfolder to a specific Jellyfin library. When a download lands in a mapped
        subfolder, only that library is refreshed instead of the whole server. Subfolders without
        a mapping still trigger a full server rescan.
      </Typography>

      {loadingData && (
        <Box className="flex items-center gap-2 mb-4">
          <CircularProgress size={16} />
          <Typography variant="caption" color="text.secondary">
            Loading...
          </Typography>
        </Box>
      )}

      {subfolderFetchError && (
        <Alert severity="warning" className="mb-4">
          Could not load channel subfolders. Check your connection and try refreshing.
        </Alert>
      )}

      {librariesError && (
        <Alert severity="warning" className="mb-4">
          {librariesError}
        </Alert>
      )}

      {mappings.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Subfolder</TableCell>
              <TableCell>Jellyfin Library</TableCell>
              <TableCell style={{ width: 48, paddingLeft: 4, paddingRight: 4 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {mappings.map((mapping) => {
              const display = resolveLibraryDisplay(jellyfinLibraries, mapping.libraryId);
              return (
                <TableRow key={`${mapping.subfolder === null ? '\x00root' : mapping.subfolder}-${mapping.libraryId}`}>
                  <TableCell>
                    <Typography variant="body2" className="font-mono">
                      {formatMappingSubfolder(mapping.subfolder)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <PlexLibraryLabel display={display} />
                  </TableCell>
                  <TableCell style={{ width: 48, paddingLeft: 4, paddingRight: 4 }}>
                    <IconButton
                      size="small"
                      onClick={() => handleDeleteMapping(mapping.subfolder)}
                      aria-label={`Remove mapping for ${formatMappingSubfolder(mapping.subfolder)}`}
                      data-testid={`delete-jellyfin-mapping-${mapping.subfolder ?? 'root'}`}
                    >
                      <DeleteIcon size={16} />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {mappings.length === 0 && !showAddForm && !loadingData && (
        <Typography variant="body2" color="text.secondary" className="block mb-4">
          No per-subfolder mappings configured. All downloads trigger a full server rescan.
        </Typography>
      )}

      {showAddForm && hasCredentials && (
        <Box className="flex flex-wrap items-start gap-3 mt-2">
          <FormControl style={{ minWidth: 160 }}>
            <InputLabel id="new-jellyfin-mapping-subfolder-label">Subfolder</InputLabel>
            <Select
              labelId="new-jellyfin-mapping-subfolder-label"
              label="Subfolder"
              value={newSubfolder}
              onChange={(e: SelectChangeEvent) => setNewSubfolder(e.target.value)}
              data-testid="new-jellyfin-mapping-subfolder-select"
              disabled={loadingData}
            >
              <MenuItem value={ROOT_SELECT_VALUE}>Root folder</MenuItem>
              {subfolders.map((folder) => (
                <MenuItem
                  key={folder}
                  value={folder}
                  disabled={isMappingDuplicate(selectValueToSubfolder(folder))}
                >
                  {folder}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl style={{ minWidth: 180 }}>
            <InputLabel id="new-jellyfin-mapping-library-label">Jellyfin Library</InputLabel>
            <Select
              labelId="new-jellyfin-mapping-library-label"
              label="Jellyfin Library"
              value={newLibraryId}
              onChange={(e: SelectChangeEvent) => setNewLibraryId(e.target.value)}
              data-testid="new-jellyfin-mapping-library-select"
              disabled={loadingData}
            >
              {jellyfinLibraries.map((lib) => (
                <MenuItem key={lib.id} value={lib.id}>
                  {lib.title}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button
            variant="contained"
            size="small"
            onClick={handleAddMapping}
            disabled={isAddDisabled}
            data-testid="confirm-add-jellyfin-mapping-button"
            className="h-10"
          >
            Add
          </Button>
          <Button
            size="small"
            onClick={() => {
              setShowAddForm(false);
              setNewSubfolder('');
              setNewLibraryId('');
            }}
            className="h-10"
          >
            Cancel
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default JellyfinSubfolderMappings;
