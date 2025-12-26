/**
 * Edge Animation Hook
 * 
 * Manages edge trace-in/retract animations and weight interpolation.
 * 
 * Animation behaviors:
 * - Trace-in: Lines "draw" from point A to B with staggered delays
 * - Retract: Lines "zip" back toward nodes when topology is toggled off
 * - Weight interpolation: Smooth thickness transitions when data updates
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { EDGE_ANIMATION_DURATION, EDGE_EXIT_DURATION } from '../constants';
import type { TopologyEdge } from '@/lib/mesh-topology';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface EdgeAnimationState {
  /** Progress per edge (0 = not started/retracted, 1 = complete) */
  edgeAnimProgress: Map<string, number>;
  /** Weight animation progress (0-1 for interpolation) */
  weightAnimProgress: number;
  /** Whether exit animation is in progress */
  isExiting: boolean;
  /** Start weights for interpolation */
  animStartWeights: Map<string, number>;
  /** Target weights for interpolation */
  animTargetWeights: Map<string, number>;
}

export interface EdgePolyline {
  from: [number, number];
  to: [number, number];
  edge: TopologyEdge;
}

export interface UseEdgeAnimationOptions {
  /** Whether topology is currently shown */
  showTopology: boolean;
  /** Filtered polylines to animate */
  polylines: EdgePolyline[];
  /** Weak edges to animate */
  weakPolylines: EdgePolyline[];
  /** Maximum certain count for weight calculation */
  maxCertainCount: number;
  /** Function to calculate edge weight */
  getWeight: (certainCount: number, maxCount: number) => number;
}

export interface UseEdgeAnimationReturn extends EdgeAnimationState {
  /** Reset all animation state (for deep analysis completion) */
  resetAnimationState: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Easing Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Cubic ease-in-out for smooth animations */
function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Cubic ease-out for snappy retraction */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hook Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export function useEdgeAnimation({
  showTopology,
  polylines,
  weakPolylines,
  maxCertainCount,
  getWeight,
}: UseEdgeAnimationOptions): UseEdgeAnimationReturn {
  // Animation progress per edge (0 = not started, 1 = complete)
  const [edgeAnimProgress, setEdgeAnimProgress] = useState<Map<string, number>>(new Map());
  
  // Weight animation progress (0-1 for interpolation)
  const [weightAnimProgress, setWeightAnimProgress] = useState(1);
  
  // Exit animation state
  const [isExiting, setIsExiting] = useState(false);
  
  // Track previous topology state for detecting toggles
  const prevShowTopologyRef = useRef(showTopology);
  
  // Track which edges we've seen before (for detecting new edges)
  const knownEdgesRef = useRef<Set<string>>(new Set());
  
  // Track the last edge set signature to detect changes
  const lastEdgeSetRef = useRef<string>('');
  
  // Animation weight snapshots (state so they can be passed to children for render)
  const [animStartWeights, setAnimStartWeights] = useState<Map<string, number>>(new Map());
  const [animTargetWeights, setAnimTargetWeights] = useState<Map<string, number>>(new Map());
  
  // Track previous weights for next update cycle
  const prevWeightsRef = useRef<Map<string, number>>(new Map());
  
  // Ref to track current progress for exit animation capture
  const edgeAnimProgressRef = useRef<Map<string, number>>(new Map());
  
  // Keep ref in sync with state
  useEffect(() => {
    edgeAnimProgressRef.current = edgeAnimProgress;
  }, [edgeAnimProgress]);
  
  // Reset function for external use (e.g., deep analysis completion)
  const resetAnimationState = useCallback(() => {
    setEdgeAnimProgress(new Map());
    knownEdgesRef.current = new Set();
    lastEdgeSetRef.current = '';
    setAnimStartWeights(new Map());
    setAnimTargetWeights(new Map());
  }, []);
  
  // Handle topology toggle - detect changes and trigger exit animation
  // Note: setState calls in this effect are intentional for animation state machine transitions
  useEffect(() => {
    const wasShowing = prevShowTopologyRef.current;
    const isShowing = showTopology;
    prevShowTopologyRef.current = showTopology;
    
    // Toggling OFF: start exit animation (retract edges toward nodes)
    if (wasShowing && !isShowing && !isExiting) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Animation state machine: trigger exit mode
      setIsExiting(true);
      
      // Capture current edge progress values as starting points for retraction
      const startProgressMap = new Map(edgeAnimProgressRef.current);
      
      let startTime: number | null = null;
      const animateExit = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / EDGE_EXIT_DURATION, 1);
        const eased = easeOutCubic(progress);
        
        // Retract each edge from its current progress toward 0
        setEdgeAnimProgress(() => {
          const next = new Map<string, number>();
          for (const [key, startVal] of startProgressMap) {
            next.set(key, startVal * (1 - eased));
          }
          return next;
        });
        
        if (progress < 1) {
          requestAnimationFrame(animateExit);
        } else {
          // Exit animation complete - fully reset state
          setIsExiting(false);
          setEdgeAnimProgress(new Map());
          knownEdgesRef.current = new Set();
          lastEdgeSetRef.current = '';
          setAnimStartWeights(new Map());
          setAnimTargetWeights(new Map());
        }
      };
      
      requestAnimationFrame(animateExit);
    }
    
    // Toggling ON: reset edge state for fresh animation start
    if (!wasShowing && isShowing) {
      setEdgeAnimProgress(new Map());
      knownEdgesRef.current = new Set();
      lastEdgeSetRef.current = '';
    }
  }, [showTopology, isExiting]);
  
  // Main animation effect - trace in new edges, animate weight changes
  useEffect(() => {
    // Skip if we're in exit animation or topology is off
    if (!showTopology || isExiting) {
      return;
    }
    
    // Combine validated and weak edges for animation
    const allAnimatedEdges = [...polylines, ...weakPolylines];
    
    // Build current weight signature (detects both new edges and weight changes)
    const currentWeightSignature = allAnimatedEdges
      .map(p => `${p.edge.key}:${p.edge.certainCount}`)
      .sort()
      .join(',');
    
    // Detect if this is a toggle-on (no previous edges) or data update (edges changed)
    const isInitialToggle = knownEdgesRef.current.size === 0;
    const edgesChanged = lastEdgeSetRef.current !== '' && lastEdgeSetRef.current !== currentWeightSignature;
    
    if (isInitialToggle || edgesChanged) {
      // Find new edges that need trace animation
      const newEdgeKeys: string[] = [];
      const existingEdgeKeys: string[] = [];
      
      for (const { edge } of allAnimatedEdges) {
        if (!knownEdgesRef.current.has(edge.key)) {
          newEdgeKeys.push(edge.key);
        } else {
          existingEdgeKeys.push(edge.key);
        }
      }
      
      // Capture current weights as "start" BEFORE computing new targets
      if (edgesChanged && existingEdgeKeys.length > 0) {
        const startWeights = new Map<string, number>();
        for (const key of existingEdgeKeys) {
          // Use the previously stored weight (from last render cycle)
          const prevWeight = prevWeightsRef.current.get(key);
          if (prevWeight !== undefined) {
            startWeights.set(key, prevWeight);
          }
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: initialize animation interpolation state
        setAnimStartWeights(startWeights);
        setWeightAnimProgress(0);
      }
      
      // Compute and store target weights for all edges
      const targetWeights = new Map<string, number>();
      for (const { edge } of polylines) {
        const weight = getWeight(edge.certainCount, maxCertainCount);
        targetWeights.set(edge.key, weight);
      }
      setAnimTargetWeights(targetWeights);
      // Initialize new edges at progress 0
      setEdgeAnimProgress(prev => {
        const next = new Map(prev);
        for (const key of newEdgeKeys) {
          next.set(key, 0);
        }
        // Ensure existing edges are at 1
        for (const key of existingEdgeKeys) {
          if (!next.has(key)) {
            next.set(key, 1);
          }
        }
        return next;
      });
      
      // Start trace animation for new edges (staggered by index)
      if (newEdgeKeys.length > 0) {
        let startTime: number | null = null;
        const staggerDelay = Math.min(100, EDGE_ANIMATION_DURATION / newEdgeKeys.length / 2);
        
        const animateTrace = (timestamp: number) => {
          if (!startTime) startTime = timestamp;
          const elapsed = timestamp - startTime;
          
          setEdgeAnimProgress(prev => {
            const next = new Map(prev);
            
            newEdgeKeys.forEach((key, index) => {
              const edgeStartTime = index * staggerDelay;
              const edgeElapsed = Math.max(0, elapsed - edgeStartTime);
              const progress = Math.min(edgeElapsed / EDGE_ANIMATION_DURATION, 1);
              const eased = easeInOutCubic(progress);
              next.set(key, eased);
            });
            
            return next;
          });
          
          // Continue animation if not all complete
          const totalDuration = EDGE_ANIMATION_DURATION + (newEdgeKeys.length - 1) * staggerDelay;
          if (elapsed < totalDuration) {
            requestAnimationFrame(animateTrace);
          }
        };
        
        requestAnimationFrame(animateTrace);
      }
      
      // Animate weight growth for existing edges
      if (edgesChanged && existingEdgeKeys.length > 0) {
        let startTime: number | null = null;
        
        const animateWeight = (timestamp: number) => {
          if (!startTime) startTime = timestamp;
          const elapsed = timestamp - startTime;
          const progress = Math.min(elapsed / EDGE_ANIMATION_DURATION, 1);
          const eased = easeInOutCubic(progress);
          
          setWeightAnimProgress(eased);
          
          if (progress < 1) {
            requestAnimationFrame(animateWeight);
          }
        };
        
        requestAnimationFrame(animateWeight);
      }
      
      // Update known edges
      for (const key of newEdgeKeys) {
        knownEdgesRef.current.add(key);
      }
    }
    
    // Update prevWeightsRef with current computed weights (for NEXT update cycle)
    for (const { edge } of polylines) {
      const weight = getWeight(edge.certainCount, maxCertainCount);
      prevWeightsRef.current.set(edge.key, weight);
    }
    
    lastEdgeSetRef.current = currentWeightSignature;
  }, [showTopology, isExiting, polylines, weakPolylines, maxCertainCount, getWeight]);
  
  return {
    edgeAnimProgress,
    weightAnimProgress,
    isExiting,
    animStartWeights,
    animTargetWeights,
    resetAnimationState,
  };
}
