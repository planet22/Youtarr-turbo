import React from 'react';
import { Gauge, Percent, ListOrdered, Database } from 'lucide-react';
import { Grid, Card, CardContent, Typography, Box } from '../../ui';
import { NzbStats } from '../../../hooks/useNzbStats';

interface NzbStatCardsProps {
  stats: NzbStats | null;
}

interface StatTile {
  key: string;
  label: string;
  value: string;
  icon: React.ReactNode;
}

function NzbStatCards({ stats }: NzbStatCardsProps) {
  const tiles: StatTile[] = [
    {
      key: 'qps',
      label: 'Queries / sec (last 60s)',
      value: stats ? stats.queriesPerSecond.toFixed(2) : '--',
      icon: <Gauge size={20} />,
    },
    {
      key: 'hitRate',
      label: 'Cache hit rate',
      value: stats ? `${Math.round(stats.cacheHitRate * 100)}%` : '--',
      icon: <Percent size={20} />,
    },
    {
      key: 'total',
      label: 'Total NZB queries',
      value: stats ? String(stats.totalQueries) : '--',
      icon: <ListOrdered size={20} />,
    },
    {
      key: 'cached',
      label: 'Cached queries',
      value: stats ? String(stats.cachedEntries.length) : '--',
      icon: <Database size={20} />,
    },
  ];

  return (
    <Grid container spacing={2}>
      {tiles.map((tile) => (
        <Grid item xs={6} md={3} key={tile.key}>
          <Card>
            <CardContent>
              <Box className="flex items-center gap-2 text-muted-foreground mb-1">
                {tile.icon}
                <Typography variant="body2" color="textSecondary">
                  {tile.label}
                </Typography>
              </Box>
              <Typography variant="h5">{tile.value}</Typography>
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}

export default NzbStatCards;
