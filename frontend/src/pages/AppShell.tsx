import { NavLink, Outlet, useLocation } from 'react-router-dom';

export function AppShell() {
  const { pathname } = useLocation();
  const workbenchActive = pathname === '/';
  const observabilityActive = pathname.startsWith('/observability');

  return (
    <div className="mx-auto max-w-6xl px-4 py-4 space-y-4">
      <header className="navbar bg-base-200 rounded-box">
        <div className="navbar-start">
          <span className="text-xl font-bold">AI Interpreter Workbench</span>
        </div>
      </header>

      <div className="bg-base-200 rounded-box px-4 pt-2">
        <div role="tablist" aria-label="Primary" className="tabs tabs-box tabs-sm">
          <NavLink
            to="/"
            end
            role="tab"
            aria-selected={workbenchActive}
            className={`tab ${workbenchActive ? 'tab-active' : ''}`}
          >
            Workbench
          </NavLink>
          <NavLink
            to="/observability"
            role="tab"
            aria-selected={observabilityActive}
            className={`tab ${observabilityActive ? 'tab-active' : ''}`}
          >
            Observability
          </NavLink>
        </div>
      </div>

      <Outlet />
    </div>
  );
}
