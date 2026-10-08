import { NavContentBlueprint } from '@backstage/plugin-app-react';
import { Link, useLocation } from 'react-router-dom';
import { KpnLogo } from './KpnLogo';

type Item = { label: string; to: string; isActive: (path: string) => boolean };

const CNPG = '/cnpg';
const isClusterPath = (p: string) =>
  p === CNPG ||
  (p.startsWith(`${CNPG}/`) &&
    !p.startsWith(`${CNPG}/create`) &&
    !p.startsWith(`${CNPG}/dashboards`) &&
    !p.startsWith(`${CNPG}/projects`) &&
    !p.startsWith(`${CNPG}/locations`) &&
    !p.startsWith(`${CNPG}/buckets`));
const isProjectPath = (p: string) =>
  p.startsWith(`${CNPG}/projects`) && !p.startsWith(`${CNPG}/projects/create`);
const isLocationPath = (p: string) =>
  p.startsWith(`${CNPG}/locations`) && !p.startsWith(`${CNPG}/locations/create`);

/** The portal is CNPG-only, so the nav is a fixed list rather than every installed page. */
const sections: Array<{ title: string; items: Item[] }> = [
  {
    title: 'Locations',
    items: [
      { label: 'Locations', to: `${CNPG}/locations`, isActive: isLocationPath },
      {
        label: 'Add location',
        to: `${CNPG}/locations/create`,
        isActive: p => p.startsWith(`${CNPG}/locations/create`),
      },
    ],
  },
  {
    title: 'Projects',
    items: [
      { label: 'Projects', to: `${CNPG}/projects`, isActive: isProjectPath },
      {
        label: 'New project',
        to: `${CNPG}/projects/create`,
        isActive: p => p.startsWith(`${CNPG}/projects/create`),
      },
      { label: 'Buckets', to: `${CNPG}/buckets`, isActive: p => p.startsWith(`${CNPG}/buckets`) },
    ],
  },
  {
    title: 'Database',
    items: [
      { label: 'PostgreSQL', to: CNPG, isActive: isClusterPath },
      { label: 'New cluster', to: `${CNPG}/create`, isActive: p => p.startsWith(`${CNPG}/create`) },
    ],
  },
  {
    title: 'Monitoring',
    items: [
      {
        label: 'Dashboards',
        to: `${CNPG}/dashboards`,
        isActive: p => p.startsWith(`${CNPG}/dashboards`),
      },
    ],
  },
];

const KpnNav = () => {
  const { pathname } = useLocation();
  return (
    <nav className="kpn-nav" aria-label="sidebar nav">
      <Link to={CNPG} className="kpn-nav__brand" aria-label="Home">
        <KpnLogo height={26} />
        <span className="kpn-nav__product">Managed PostgreSQL</span>
      </Link>
      <div className="kpn-nav__sections">
        {sections.map(section => (
          <div key={section.title} className="kpn-nav__section">
            <div className="kpn-nav__heading">{section.title}</div>
            {section.items.map(item => (
              <Link
                key={item.to}
                to={item.to}
                className="kpn-nav__item"
                aria-current={item.isActive(pathname) ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="kpn-nav__footer">CloudNativePG · Crossplane</div>
    </nav>
  );
};

export const SidebarContent = NavContentBlueprint.make({
  params: { component: () => <KpnNav /> },
});
