import { ThemeBlueprint } from '@backstage/plugin-app-react';
import {
  createUnifiedTheme,
  genPageTheme,
  pageTheme as defaultPageThemes,
  palettes,
  UnifiedThemeProvider,
} from '@backstage/theme';

/** KPN brand colours; mirrored as CSS tokens in ./kpn.css for Backstage UI. */
export const kpn = {
  green: '#00c300',
  bg: '#0e0f13',
  surface: '#16181f',
  surfaceRaised: '#1d2029',
  border: '#272a35',
  text: '#e9ebf0',
  textMuted: '#9197a6',
};

// Backstage's MUI page headers (sign-in, catalog pages) become a flat dark bar.
const flat = genPageTheme({
  colors: [kpn.surface, kpn.surface],
  shape: 'none',
});
const pageTheme = Object.fromEntries(
  Object.keys(defaultPageThemes).map(k => [k, flat]),
);

const theme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    primary: { main: kpn.green },
    secondary: { main: kpn.green },
    background: { default: kpn.bg, paper: kpn.surface },
    text: { primary: kpn.text, secondary: kpn.textMuted },
    link: kpn.green,
    linkHover: '#33d633',
    navigation: {
      ...palettes.dark.navigation,
      background: kpn.surface,
      indicator: kpn.green,
      color: kpn.textMuted,
      selectedColor: kpn.text,
    },
  },
  pageTheme,
  defaultPageTheme: 'home',
});

/**
 * The only theme in the portal. The `data-theme-name="kpn"` attribute it sets
 * on <body> scopes the Backstage UI token overrides in ./kpn.css.
 */
export const kpnTheme = ThemeBlueprint.make({
  name: 'kpn',
  params: {
    theme: {
      id: 'kpn',
      title: 'KPN',
      variant: 'dark',
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={theme} themeName="kpn">
          {children}
        </UnifiedThemeProvider>
      ),
    },
  },
});
