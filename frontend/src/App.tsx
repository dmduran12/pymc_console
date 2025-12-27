import { Routes, Route } from 'react-router-dom';
import { Component, ReactNode, useEffect, lazy, Suspense } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { BackgroundProvider } from '@/components/layout/BackgroundProvider';
import { useInitializeApp } from '@/lib/stores/useStore';

// Skeletons for route transitions
import {
  DashboardSkeleton,
  ListSkeleton,
  MapSkeleton,
  ChartSkeleton,
  SystemSkeleton,
  FormSkeleton,
} from '@/components/layout/PageSkeleton';

// ═══════════════════════════════════════════════════════════════════════════════
// Lazy-loaded pages for code splitting
// Each page is loaded on-demand, reducing initial bundle size significantly.
// ═══════════════════════════════════════════════════════════════════════════════
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Packets = lazy(() => import('@/pages/Packets'));
const Contacts = lazy(() => import('@/pages/Contacts'));
const Statistics = lazy(() => import('@/pages/Statistics'));
const System = lazy(() => import('@/pages/System'));
const Logs = lazy(() => import('@/pages/Logs'));
const Terminal = lazy(() => import('@/pages/Terminal'));
const Settings = lazy(() => import('@/pages/Settings'));

// Error boundary to catch page render errors
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class PageErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="glass-card p-8 text-center">
          <p className="type-subheading text-accent-red mb-2">Page failed to render</p>
          <p className="type-body text-white/50 mb-4">{this.state.error?.message || 'Unknown error'}</p>
          <button 
            onClick={() => this.setState({ hasError: false })}
            className="px-4 py-2 bg-accent-primary/20 text-accent-primary rounded-lg hover:bg-accent-primary/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const initializeApp = useInitializeApp();
  
  // Initialize app data on mount (parallel fetch of stats + packets)
  useEffect(() => {
    initializeApp();
  }, [initializeApp]);
  
  return (
    <>
      {/* Dynamic background - controlled by ThemeContext */}
      <BackgroundProvider />

      {/* App shell: sidebar + main content */}
      <div className="flex min-h-screen">
        <Sidebar />

        {/* Main content area */}
        <main className="flex-1 min-w-0 pt-14 lg:pt-0">
          <div className="h-full overflow-y-auto">
            <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
              <PageErrorBoundary>
                <Routes>
                  <Route path="/" element={
                    <Suspense fallback={<DashboardSkeleton />}>
                      <Dashboard />
                    </Suspense>
                  } />
                  <Route path="/packets" element={
                    <Suspense fallback={<ListSkeleton />}>
                      <Packets />
                    </Suspense>
                  } />
                  <Route path="/contacts" element={
                    <Suspense fallback={<MapSkeleton />}>
                      <Contacts />
                    </Suspense>
                  } />
                  <Route path="/statistics" element={
                    <Suspense fallback={<ChartSkeleton />}>
                      <Statistics />
                    </Suspense>
                  } />
                  <Route path="/system" element={
                    <Suspense fallback={<SystemSkeleton />}>
                      <System />
                    </Suspense>
                  } />
                  <Route path="/logs" element={
                    <Suspense fallback={<ListSkeleton />}>
                      <Logs />
                    </Suspense>
                  } />
                  <Route path="/terminal" element={
                    <Suspense fallback={<ListSkeleton />}>
                      <Terminal />
                    </Suspense>
                  } />
                  <Route path="/settings" element={
                    <Suspense fallback={<FormSkeleton />}>
                      <Settings />
                    </Suspense>
                  } />
                </Routes>
              </PageErrorBoundary>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
