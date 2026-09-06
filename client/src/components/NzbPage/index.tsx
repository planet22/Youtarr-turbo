import React from 'react';
import { Grid, Typography, Box, Accordion, AccordionSummary, AccordionDetails } from '../ui';
import { useNzbStats } from '../../hooks/useNzbStats';
import NzbStatCards from './components/NzbStatCards';
import NzbRecentQueriesTable from './components/NzbRecentQueriesTable';
import NzbCachedQueriesTable from './components/NzbCachedQueriesTable';
import NzbSearchTracesTable from './components/NzbSearchTracesTable';
import NzbCacheKeySummary from './components/NzbCacheKeySummary';
import NzbFailedGrabsTable from './components/NzbFailedGrabsTable';
import NzbJobsSection from './components/NzbJobsSection';

interface NzbPageProps {
  token: string | null;
}

function NzbPage({ token }: NzbPageProps) {
  const { stats, deleteCacheEntries, cancelCurrentJob } = useNzbStats(token);

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
        <Accordion defaultExpanded>
          <AccordionSummary>
            <Typography variant="subtitle1">Search &amp; Cache</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <NzbCacheKeySummary settings={stats?.searchSettings ?? null} />
              </Grid>
              <Grid item xs={12}>
                <NzbRecentQueriesTable queries={stats?.recentQueries ?? []} />
              </Grid>
              <Grid item xs={12}>
                <NzbCachedQueriesTable entries={stats?.cachedEntries ?? []} onDelete={deleteCacheEntries} />
              </Grid>
            </Grid>
          </AccordionDetails>
        </Accordion>
      </Grid>

      <Grid item xs={12}>
        <Accordion>
          <AccordionSummary>
            <Typography variant="subtitle1">Search Filter Debug</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <NzbSearchTracesTable traces={stats?.searchTraces ?? []} />
          </AccordionDetails>
        </Accordion>
      </Grid>

      <Grid item xs={12}>
        <Accordion defaultExpanded>
          <AccordionSummary>
            <Typography variant="subtitle1">Downloads &amp; Jobs</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <NzbFailedGrabsTable grabs={stats?.failedGrabs ?? []} />
              </Grid>
              <Grid item xs={12}>
                <NzbJobsSection jobs={stats?.jobs ?? null} onCancelCurrentJob={cancelCurrentJob} />
              </Grid>
            </Grid>
          </AccordionDetails>
        </Accordion>
      </Grid>
    </Grid>
  );
}

export default NzbPage;
