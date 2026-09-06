import React from 'react';
import { Card, CardContent, Typography, Box } from '../../ui';

interface ConfigurationCardProps {
  title: string;
  subtitle?: string;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Reusable card wrapper with consistent styling for configuration sections
 */
export const ConfigurationCard: React.FC<ConfigurationCardProps> = ({
  title,
  subtitle,
  headerAction,
  children,
}) => {
  return (
    <Card
      elevation={2}
      style={{
        marginBottom: 24,
        border: '1px solid var(--border)',
      }}
    >
      <CardContent>
        {headerAction ? (
          <Box className="flex items-start justify-between gap-2 flex-wrap">
            <Typography variant="h5" component="h2" gutterBottom>
              {title}
            </Typography>
            {headerAction}
          </Box>
        ) : (
          <Typography variant="h5" component="h2" gutterBottom>
            {title}
          </Typography>
        )}
        {subtitle && (
          <Typography variant="body2" color="textSecondary" gutterBottom>
            {subtitle}
          </Typography>
        )}
        {children}
      </CardContent>
    </Card>
  );
};
