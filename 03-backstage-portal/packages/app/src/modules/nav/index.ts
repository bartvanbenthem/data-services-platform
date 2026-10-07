import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { kpnTheme } from '../theme';
import { AppShell, RootRedirect } from './AppShell';
import { KpnSignInPage } from './SignIn';
import { SidebarContent } from './Sidebar';

export const navModule = createFrontendModule({
  pluginId: 'app',
  extensions: [SidebarContent, AppShell, RootRedirect, KpnSignInPage, kpnTheme],
});
