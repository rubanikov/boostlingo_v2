import type { RouteObject } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ObservabilityPage } from './observability/ObservabilityPage';
import { TraceDetailPage } from './observability/TraceDetailPage';
import { WorkbenchPage } from './WorkbenchPage';

export function createAppRoutes(): RouteObject[] {
  return [
    {
      path: '/',
      element: <AppShell />,
      children: [
        { index: true, element: <WorkbenchPage /> },
        { path: 'observability', element: <ObservabilityPage /> },
        { path: 'observability/traces/:traceId', element: <TraceDetailPage /> },
      ],
    },
  ];
}
