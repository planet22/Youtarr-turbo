import React from 'react';
import { Grid, Typography, Box } from '../ui';
import { useNzbStats } from '../../hooks/useNzbStats';
import NzbStatCards from './components/NzbStatCards';
import NzbRecentQueriesTable from './components/NzbRecentQueriesTable';
import NzbCachedQueriesTable from './components/NzbCachedQueriesTable';

interface NzbPageProps {
  token: string | null;
}

function NzbPage({ token }: NzbPageProps) {
  const { stats, deleteCacheEntries } = useNzbStats(token);

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <Box className="px-2">
          <Typography variant="h5">NZB</Typography>
          <Typography variant="body2" color="textSecondary">
            Diagnostics for the Newznab/SABnzbd integration - only reflects searches from Sonarr, Radarr,
            or Prowlarr, not manual "Find Videos" searches.
          </Typography>
        </Box>
      </Grid>
      <Grid item xs={12}>
        <NzbStatCards stats={stats} />
      </Grid>
      <Grid item xs={12}>
        <NzbRecentQueriesTable queries={stats?.recentQueries ?? []} />
      </Grid>
      <Grid item xs={12}>
        <NzbCachedQueriesTable entries={stats?.cachedEntries ?? []} onDelete={deleteCacheEntries} />
      </Grid>
    </Grid>
  );
}

export default NzbPage;
