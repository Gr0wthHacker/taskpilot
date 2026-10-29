import { lazy, Suspense } from 'react';
import { createHashRouter } from 'react-router-dom';
import Layout from './components/Layout';
import OnboardingGate from './components/OnboardingGate';

// Every view is a direct lazy import. Vite code-splits each into its own
// chunk under dist/renderer/assets/<Name>-<hash>.js, fetched on first
// navigation. Adding a new view: import here, add a route below.
const Inbox = lazy(() => import('./views/Inbox'));
const Board = lazy(() => import('./views/Board'));
const TaskDetail = lazy(() => import('./views/TaskDetail'));
const Derivation = lazy(() => import('./views/Derivation'));
const Execution = lazy(() => import('./views/Execution'));
const IODashboard = lazy(() => import('./views/IODashboard'));
const Calendar = lazy(() => import('./views/Calendar'));
const DailyPlan = lazy(() => import('./views/DailyPlan'));
const Review = lazy(() => import('./views/Review'));
const SearchView = lazy(() => import('./views/Search'));
const Settings = lazy(() => import('./views/Settings'));
const Projects = lazy(() => import('./views/Projects'));
const Businesses = lazy(() => import('./views/Businesses'));
const Content = lazy(() => import('./views/Content'));
const Goals = lazy(() => import('./views/Goals'));
const GoalDetail = lazy(() => import('./views/GoalDetail'));
const Graph = lazy(() => import('./views/Graph'));
const Knowledge = lazy(() => import('./views/Knowledge'));
const Reports = lazy(() => import('./views/Reports'));
const StatusReportView = lazy(() => import('./views/StatusReportView'));
const About = lazy(() => import('./views/About'));
const Schedules = lazy(() => import('./views/Schedules'));
const Delivery = lazy(() => import('./views/Delivery'));
const Templates = lazy(() => import('./views/Templates'));
const Archive = lazy(() => import('./views/Archive'));
const ImportView = lazy(() => import('./views/Import'));
const CoworkQueue = lazy(() => import('./views/CoworkQueue'));
const MissionControl = lazy(() => import('./views/MissionControl'));
const YourMove = lazy(() => import('./views/YourMove'));
const FocusMode = lazy(() => import('./views/FocusMode'));
const Onboarding = lazy(() => import('./views/Onboarding'));
const Triage = lazy(() => import('./views/Triage'));
const Watch = lazy(() => import('./views/Watch'));
const Conversations = lazy(() => import('./views/Conversations'));
const MemoryInbox = lazy(() => import('./views/MemoryInbox'));
const MemoryDetail = lazy(() => import('./views/MemoryDetail'));

function ViewFallback(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="text-sm text-muted-foreground">Loading…</div>
    </div>
  );
}

function withSuspense(node: React.ReactNode): JSX.Element {
  return <Suspense fallback={<ViewFallback />}>{node}</Suspense>;
}

// HashRouter — Electron loads via file:// which is hostile to BrowserRouter.
export const router = createHashRouter([
  // Onboarding is a full-screen view with no sidebar/layout chrome. Mounted
  // outside the Layout subtree so the shell doesn't compete with the wizard.
  {
    path: '/onboarding',
    element: withSuspense(<Onboarding />),
  },
  // Triage is a full-screen, keyboard-driven inbox walkthrough. Like
  // onboarding it owns the whole window with no sidebar chrome, so it lives
  // outside the Layout subtree.
  {
    path: '/triage',
    element: withSuspense(<Triage />),
  },
  // Focus mode is a full-screen, single-task deep-work surface. Like triage it
  // owns the whole window with no sidebar chrome.
  {
    path: '/focus/:id',
    element: withSuspense(<FocusMode />),
  },
  {
    path: '/',
    element: (
      <OnboardingGate>
        <Layout />
      </OnboardingGate>
    ),
    children: [
      { index: true, element: withSuspense(<YourMove />) },
      { path: 'inbox', element: withSuspense(<Inbox />) },
      { path: 'board', element: withSuspense(<Board />) },
      { path: 'task/:id', element: withSuspense(<TaskDetail />) },
      { path: 'derive', element: withSuspense(<Derivation />) },
      { path: 'derive/:id', element: withSuspense(<Derivation />) },
      { path: 'execute', element: withSuspense(<Execution />) },
      { path: 'execute/:id', element: withSuspense(<Execution />) },
      { path: 'io', element: withSuspense(<IODashboard />) },
      { path: 'calendar', element: withSuspense(<Calendar />) },
      { path: 'plan', element: withSuspense(<DailyPlan />) },
      { path: 'review', element: withSuspense(<Review />) },
      { path: 'search', element: withSuspense(<SearchView />) },
      { path: 'cowork', element: withSuspense(<CoworkQueue />) },
      { path: 'agents', element: withSuspense(<MissionControl />) },
      { path: 'projects', element: withSuspense(<Projects />) },
      { path: 'goals', element: withSuspense(<Goals />) },
      { path: 'goals/:id', element: withSuspense(<GoalDetail />) },
      { path: 'businesses', element: withSuspense(<Businesses />) },
      { path: 'content', element: withSuspense(<Content />) },
      { path: 'graph', element: withSuspense(<Graph />) },
      { path: 'knowledge', element: withSuspense(<Knowledge />) },
      { path: 'reports', element: withSuspense(<Reports />) },
      { path: 'schedules', element: withSuspense(<Schedules />) },
      { path: 'delivery', element: withSuspense(<Delivery />) },
      { path: 'reports/status', element: withSuspense(<StatusReportView />) },
      { path: 'about', element: withSuspense(<About />) },
      { path: 'templates', element: withSuspense(<Templates />) },
      { path: 'archive', element: withSuspense(<Archive />) },
      { path: 'import', element: withSuspense(<ImportView />) },
      { path: 'watch', element: withSuspense(<Watch />) },
      { path: 'conversations', element: withSuspense(<Conversations />) },
      { path: 'memory', element: withSuspense(<MemoryInbox />) },
      { path: 'memory/:id', element: withSuspense(<MemoryDetail />) },
      { path: 'settings', element: withSuspense(<Settings />) },
    ],
  },
]);
