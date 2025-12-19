/**
 * DeepAnalysisModal - Progress modal for deep topology analysis
 * 
 * Shows a 3-step progress indicator:
 * 1. Fetching X Packets
 * 2. Analyzing Database
 * 3. Building Topology
 * 
 * Then shows "Ready!" with a big checkmark before closing.
 */

import { memo } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Database, GitBranch, Download } from 'lucide-react';
import clsx from 'clsx';

export type AnalysisStep = 'fetching' | 'analyzing' | 'building' | 'complete';

// Purple node color from design system
const PURPLE_NODE = '#4338CA';

interface DeepAnalysisModalProps {
  isOpen: boolean;
  currentStep: AnalysisStep;
  packetCount: number;
  onClose?: () => void;
}

interface StepIndicatorProps {
  label: string;
  icon: React.ReactNode;
  status: 'pending' | 'active' | 'complete';
  detail?: string;
}

function StepIndicator({ label, icon, status, detail }: StepIndicatorProps) {
  return (
    <div className={clsx(
      'flex items-center gap-3 py-3 px-4 rounded-xl transition-all duration-300',
      status === 'active' && 'bg-[#4338CA]/10',
      status === 'complete' && 'bg-accent-success/10',
      status === 'pending' && 'opacity-40'
    )}>
      {/* Status icon */}
      <div className={clsx(
        'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300',
        status === 'active' && 'bg-[#4338CA]/20',
        status === 'complete' && 'bg-accent-success/20',
        status === 'pending' && 'bg-white/5'
      )}>
        {status === 'complete' ? (
          <Check className="w-4 h-4 text-accent-success" />
        ) : status === 'active' ? (
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: PURPLE_NODE }} />
        ) : (
          <span className="text-text-muted">{icon}</span>
        )}
      </div>
      
      {/* Label and detail */}
      <div className="flex-1 min-w-0">
        <div className={clsx(
          'text-sm font-medium transition-colors',
          status === 'active' && 'text-[#4338CA]',
          status === 'complete' && 'text-accent-success',
          status === 'pending' && 'text-text-muted'
        )}>
          {label}
        </div>
        {detail && status !== 'pending' && (
          <div className="text-xs text-text-muted mt-0.5 truncate">
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

function DeepAnalysisModalComponent({ isOpen, currentStep, packetCount }: DeepAnalysisModalProps) {
  if (!isOpen) return null;
  
  const isComplete = currentStep === 'complete';
  
  // Determine step statuses
  const getStepStatus = (step: AnalysisStep): 'pending' | 'active' | 'complete' => {
    const stepOrder: AnalysisStep[] = ['fetching', 'analyzing', 'building', 'complete'];
    const currentIndex = stepOrder.indexOf(currentStep);
    const stepIndex = stepOrder.indexOf(step);
    
    if (stepIndex < currentIndex) return 'complete';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };
  
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center">
      {/* Backdrop - subtle blur, not too dark */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      
      {/* Modal */}
      <div 
        className="relative glass-card w-full max-w-sm mx-4 p-6 animate-in fade-in zoom-in-95 duration-200"
        style={{
          background: 'rgba(20, 20, 22, 0.95)',
          border: '1px solid rgba(140, 160, 200, 0.15)',
        }}
      >
        {isComplete ? (
          /* Ready! State */
          <div className="flex flex-col items-center py-6">
            <div 
              className="w-16 h-16 rounded-full flex items-center justify-center mb-4 animate-in zoom-in-50 duration-300"
              style={{ backgroundColor: 'rgba(57, 217, 138, 0.2)' }}
            >
              <Check className="w-8 h-8 text-accent-success" />
            </div>
            <h3 className="text-lg font-semibold text-accent-success">Ready!</h3>
          </div>
        ) : (
          /* Progress State */
          <>
            {/* Header */}
            <div className="flex items-center gap-3 mb-5">
              <div 
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: 'rgba(67, 56, 202, 0.15)' }}
              >
                <GitBranch className="w-5 h-5" style={{ color: PURPLE_NODE }} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-text-primary">Deep Analysis</h3>
                <p className="text-xs text-text-muted">Building mesh topology</p>
              </div>
            </div>
            
            {/* Progress Steps */}
            <div className="space-y-2">
              <StepIndicator
                label="Fetching Packets"
                icon={<Download className="w-4 h-4" />}
                status={getStepStatus('fetching')}
                detail={packetCount > 0 ? `${packetCount.toLocaleString()} packets` : 'Loading database...'}
              />
              
              <StepIndicator
                label="Analyzing Database"
                icon={<Database className="w-4 h-4" />}
                status={getStepStatus('analyzing')}
                detail="Processing packet paths"
              />
              
              <StepIndicator
                label="Building Topology"
                icon={<GitBranch className="w-4 h-4" />}
                status={getStepStatus('building')}
                detail="Computing mesh edges"
              />
            </div>
            
            {/* Footer hint */}
            <p className="text-xs text-text-muted text-center mt-5">
              This may take a few seconds...
            </p>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

export const DeepAnalysisModal = memo(DeepAnalysisModalComponent);
