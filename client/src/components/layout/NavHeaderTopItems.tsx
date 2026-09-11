import React, { useState, useEffect } from 'react';
import { Box, Button, Paper } from '../ui';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { useThemeEngine } from '../../contexts/ThemeEngineContext';
import { NavItem, isNavItemExpanded, isNavPathActive } from './navigation';
import './layoutFallback.css';

interface NavHeaderTopItemsProps {
  navItems: NavItem[];
  showLandscapeNavItems: boolean;
  menuPaperStyle: React.CSSProperties;
}

export const NavHeaderTopItems: React.FC<NavHeaderTopItemsProps> = ({
  navItems,
  showLandscapeNavItems,
  menuPaperStyle,
}) => {
  const location = useLocation();
  const { showSectionIcons } = useThemeEngine();

  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Submenus are positioned relative to the viewport (not the item) so the row below
  // can be horizontally scrollable without clipping the dropdown.
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    setActiveKey(null);
    setMenuAnchor(null);
  }, [location.pathname]);

  const handleUnitEnter = (event: React.MouseEvent<HTMLElement>, key: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuAnchor({ top: rect.bottom, left: rect.left });
    setActiveKey(key);
  };

  const handleUnitLeave = () => {
    setActiveKey(null);
  };

  const getButtonStyle = (isParentActive: boolean): React.CSSProperties => {
    return {
      color: isParentActive ? 'var(--header-nav-active-color)' : 'var(--header-nav-default-color)',
      fontWeight: isParentActive ? 700 : 500,
      fontSize: '0.85rem',
      textTransform: 'none' as const,
      padding: '8px 12px',
      borderRadius: 'var(--radius-ui)',
      transition: 'all 0.15s ease-out',
      position: 'relative' as const,
    };
  };

  return (
    <Box
      className={`flex items-center gap-2${showLandscapeNavItems ? '' : ' nav-top-items-scroll'}`}
      style={{
        position: 'relative',
        height: showLandscapeNavItems ? 'auto' : '100%',
        width: '100%',
        flex: showLandscapeNavItems ? '0 0 auto' : undefined,
        flexWrap: showLandscapeNavItems ? 'wrap' : 'nowrap',
        justifyContent: 'center',
        minWidth: 0,
        // Non-landscape: the row gets a bounded share of the header (see NavHeader.tsx) and
        // scrolls horizontally instead of overflowing past the viewport edge when items don't fit.
        overflowX: showLandscapeNavItems ? 'visible' : 'auto',
        overflowY: 'visible',
        rowGap: showLandscapeNavItems ? 6 : 0,
        paddingBottom: showLandscapeNavItems ? 4 : 0,
      }}
    >
      {navItems.map((item) => {
        const isOpen = activeKey === item.key;
        const hasSubItems = item.subItems && item.subItems.length > 0;
        const isParentActive = isNavItemExpanded(location.pathname, item);

        return (
          <Box
            key={item.key}
            onMouseEnter={(event) => !showLandscapeNavItems && hasSubItems && handleUnitEnter(event, item.key)}
            onMouseLeave={() => {
              if (!showLandscapeNavItems) {
                handleUnitLeave();
              }
            }}
            style={{ position: 'relative', height: 'auto', display: 'flex', alignItems: 'center', flexShrink: 0 }}
          >
            <Button
              asChild
              variant="text"
              style={{
                ...getButtonStyle(isParentActive),
                padding: showLandscapeNavItems ? '5px 10px' : '8px 12px',
                fontSize: showLandscapeNavItems ? '0.76rem' : '0.85rem',
                whiteSpace: 'nowrap',
              }}
            >
              <RouterLink to={item.to}>
                {showSectionIcons && !showLandscapeNavItems && (
                  <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center [&>svg]:h-[1.25em] [&>svg]:w-[1.25em]">
                    {item.icon}
                  </span>
                )}
                <span>{item.label}</span>
              </RouterLink>
            </Button>

            {hasSubItems && isOpen && !showLandscapeNavItems && menuAnchor && (
              <div
                style={{
                  position: 'fixed',
                  top: menuAnchor.top,
                  left: menuAnchor.left,
                  zIndex: 1500,
                  paddingTop: 8,
                }}
              >
                <Paper style={menuPaperStyle}>
                  {(item.subItems ?? []).map((subItem) => {
                    const isSubActive = isNavPathActive(location.pathname, subItem.to);
                    return (
                      <RouterLink
                        key={subItem.key}
                        to={subItem.to}
                        onClick={handleUnitLeave}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: showSectionIcons && subItem.icon ? 8 : 0,
                          textDecoration: 'none',
                          width: '100%',
                          borderRadius: 'var(--layout-header-menu-radius)',
                          fontSize: '0.85rem',
                          fontWeight: 500,
                          color: isSubActive
                            ? 'var(--header-subnav-active-color)'
                            : 'var(--muted-foreground)',
                          padding: '8px 12px',
                          boxSizing: 'border-box',
                        }}
                      >
                        {showSectionIcons && subItem.icon && (
                          <span
                            aria-hidden="true"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 14,
                              height: 14,
                              flexShrink: 0,
                            }}
                          >
                            {subItem.icon}
                          </span>
                        )}
                        {subItem.label}
                      </RouterLink>
                    );
                  })}
                </Paper>
              </div>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
