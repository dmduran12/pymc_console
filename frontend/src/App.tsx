import { Routes, Route } from 'react-router-dom';
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
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/packets" element={<Packets />} />
                <Route path="/neighbors" element={<Neighbors />} />
                <Route path="/statistics" element={<Statistics />} />
                <Route path="/system" element={<System />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
