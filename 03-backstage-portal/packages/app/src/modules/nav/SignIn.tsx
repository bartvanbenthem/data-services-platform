import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { KpnLogo } from './KpnLogo';

/** The default guest sign-in, centred and branded. */
export const KpnSignInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => {
      const { SignInPage } = await import('@backstage/core-components');
      return props => (
        <SignInPage
          {...props}
          providers={['guest']}
          align="center"
          titleComponent={
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 16 }}
            >
              <KpnLogo height={34} />
              <span style={{ fontSize: 22, fontWeight: 500, color: '#e9ebf0' }}>
                Managed PostgreSQL
              </span>
            </span>
          }
        />
      );
    },
  },
});
