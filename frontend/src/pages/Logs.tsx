import { memo, useState, useCallback, useEffect } from 'react';
import { useLogs, useLogsLoading, useLiveMode, useFetchLogs, useSetLiveMode } from '@/lib/stores/useStore';
import { usePolling } from '@/lib/hooks/usePolling';
import { FileText, Circle, RefreshCw, Bug, Info, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { getLogLevelColor, POLLING_INTERVALS } from '@/lib/constants';
import { setLogLevel, type LogLevel } from '@/lib/api';
import { LogsSkeleton } from '@/components/shared/Skeleton';
import { PageContainer, PageHeader, Card } from '@/components/layout/PageLayout';
import type { LogEntry } from '@/types/api';

/** Memoized log row to prevent re-renders when other logs update */
const LogRow = memo(function LogRow({ log }: { log: LogEntry }) {
  const colorClass = getLogLevelColor(log.level);
  return (
    <div className={clsx('p-3 rounded-lg border bg-bg-subtle', colorClass)}>
      <div className="flex items-start gap-3">
        <span className={clsx('px-2 py-0.5 rounded text-xs font-medium border shrink-0', colorClass)}>
          {log.level}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-text-secondary break-words whitespace-pre-wrap">
            {log.message}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {new Date(log.timestamp).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  );
});

/** Log level toggle component */
function LogLevelToggle() {
  const logs = useLogs();
  const [selectedLevel, setSelectedLevel] = useState<LogLevel>('INFO');
  const [isChanging, setIsChanging] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (logs.length > 0) {
      const hasDebugLogs = logs.some(log => log.level === 'DEBUG');
      setSelectedLevel(hasDebugLogs ? 'DEBUG' : 'INFO');
    }
  }, [logs]);

  const handleToggle = useCallback(async (newLevel: LogLevel) => {
    if (newLevel === selectedLevel || isChanging) return;
    
    setIsChanging(true);
    setStatusMessage(null);
    
    try {
      const response = await setLogLevel(newLevel);
      if (response.success && response.data) {
        setSelectedLevel(newLevel);
        setStatusMessage(response.data.message);
        setTimeout(() => setStatusMessage(null), 5000);
      } else {
        setStatusMessage(response.error || 'Failed to change log level');
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch {
      setStatusMessage('Failed to change log level');
      setTimeout(() => setStatusMessage(null), 3000);
    } finally {
      setIsChanging(false);
    }
  }, [selectedLevel, isChanging]);

  return (
    <div className="flex items-center gap-2">
      {statusMessage && (
        <span className="text-xs text-text-muted animate-pulse">
          {statusMessage}
        </span>
      )}
      <div className="flex rounded-lg border border-border-subtle overflow-hidden">
        <button
          onClick={() => handleToggle('INFO')}
          disabled={isChanging}
          className={clsx(
            'px-3 py-1.5 sm:px-4 sm:py-2 text-sm font-medium flex items-center gap-2 transition-colors',
            selectedLevel === 'INFO'
              ? 'bg-accent-primary/20 text-accent-primary border-accent-primary/30'
              : 'bg-bg-subtle text-text-muted hover:bg-bg-elevated',
            isChanging && 'opacity-50 cursor-not-allowed'
          )}
        >
          <Info className="w-4 h-4" />
          INFO
        </button>
        <button
          onClick={() => handleToggle('DEBUG')}
          disabled={isChanging}
          className={clsx(
            'px-3 py-1.5 sm:px-4 sm:py-2 text-sm font-medium flex items-center gap-2 transition-colors border-l border-border-subtle',
            selectedLevel === 'DEBUG'
              ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
              : 'bg-bg-subtle text-text-muted hover:bg-bg-elevated',
            isChanging && 'opacity-50 cursor-not-allowed'
          )}
        >
          {isChanging ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Bug className="w-4 h-4" />
          )}
          DEBUG
        </button>
      </div>
    </div>
  );
}

export default function Logs() {
  const logs = useLogs();
  const logsLoading = useLogsLoading();
  const liveMode = useLiveMode();
  const fetchLogs = useFetchLogs();
  const setLiveMode = useSetLiveMode();

  usePolling(fetchLogs, POLLING_INTERVALS.logs, liveMode);

  return (
    <PageContainer>
      <PageHeader
        title="System Logs"
        icon={<FileText />}
        controls={
          <>
            <LogLevelToggle />
            {liveMode && (
              <div className="flex items-center gap-2 text-sm">
                <Circle className="w-2 h-2 fill-accent-success text-accent-success animate-pulse" />
                <span className="text-text-muted">Live</span>
              </div>
            )}
            <button
              onClick={() => setLiveMode(!liveMode)}
              className={clsx(
                'px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-sm font-medium transition-colors',
                'flex items-center gap-2 border',
                liveMode
                  ? 'bg-accent-success/20 text-accent-success border-accent-success/30'
                  : 'bg-bg-subtle text-text-muted border-border-subtle hover:bg-bg-elevated'
              )}
            >
              <RefreshCw className={clsx('w-4 h-4', liveMode && 'animate-spin')} />
              <span className="hidden xs:inline">{liveMode ? 'Live' : 'Paused'}</span>
            </button>
          </>
        }
      />

      <Card>
        <div className="space-y-2 max-h-[calc(100vh-300px)] sm:max-h-[calc(100vh-250px)] overflow-y-auto font-mono text-sm">
          {logsLoading && logs.length === 0 ? (
            <LogsSkeleton count={10} />
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-text-muted">
              No logs available
            </div>
          ) : (
            logs.map((log, index) => (
              <LogRow key={`${log.timestamp}-${index}`} log={log} />
            ))
          )}
        </div>
      </Card>
    </PageContainer>
  );
}
