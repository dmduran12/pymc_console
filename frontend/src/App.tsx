import { Routes, Route } from 'react-router-dom';
import { Component, ReactNode } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { BackgroundProvider } from '@/components/layout/BackgroundProvider';

// Pages
import Dashboard from '@/pages/Dashboard';
import Packets from '@/pages/Packets';
import Neighbors from '@/pages/Neighbors';
import Statistics from '@/pages/Statistics';
import System from '@/pages/System';
import Logs from '@/pages/Logs';
import Settings from '@/pages/Settings';

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
  return (
    <>
      {/* Dynamic background - controlled by BackgroundSelector */}
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
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/packets" element={<Packets />} />
                  <Route path="/neighbors" element={<Neighbors />} />
                  <Route path="/statistics" element={<Statistics />} />
                  <Route path="/system" element={<System />} />
                  <Route path="/logs" element={<Logs />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </PageErrorBoundary>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
