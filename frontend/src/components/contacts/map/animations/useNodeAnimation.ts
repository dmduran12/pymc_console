/**
 * Node Animation Hook
 * 
 * Manages node fade animations for solo mode transitions.
 * Staggered fade with randomized delays for organic feel.
 */

import { useState, useRef, useEffect } from 'react';
import { NODE_FADE_DURATION, MAX_NODE_STAGGER_DELAY } from '../constants';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface UseNodeAnimationOptions {
  /** Current solo direct mode state */
  soloDirect: boolean;
  /** Current solo hubs mode state */
  soloHubs: boolean;
  /** All neighbor hashes to potentially animate */
  neighborHashes: string[];
  /** Set of hub-connected node hashes */
  hubConnectedNodes: Set<string>;
  /** Set of direct (zero-hop) node hashes */
  directNodeSet: Set<string>;
  /** Set of nodes connected to local via topology */
  localConnectedNodes: Set<string>;
  /** Whether topology is currently shown */
  showTopology: boolean;
}

export interface UseNodeAnimationReturn {
  /** Current opacity per node (during animation) */
  nodeOpacities: Map<string, number>;
  /** Get the effective opacity for a node (animated or default) */
  getNodeOpacity: (hash: string, shouldShow: boolean) => number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Easing Function
// ═══════════════════════════════════════════════════════════════════════════════

/** Cubic ease-in-out for smooth animations */
function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hook Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export function useNodeAnimation({
  soloDirect,
  soloHubs,
  neighborHashes,
  hubConnectedNodes,
  directNodeSet,
  localConnectedNodes,
  showTopology,
}: UseNodeAnimationOptions): UseNodeAnimationReturn {
  // Node opacity state during animation
  const [nodeOpacities, setNodeOpacities] = useState<Map<string, number>>(new Map());
  
  // Track previous mode states to detect changes
  const prevSoloDirectRef = useRef(soloDirect);
  const prevSoloHubsRef = useRef(soloHubs);
  
  // Persist random stagger delays per node across toggles
  const nodeStaggerDelaysRef = useRef<Map<string, number>>(new Map());
  
  // Animation frame reference for cleanup
  const nodeAnimationFrameRef = useRef<number | null>(null);
  
  // Keep refs of visibility sets for animation closure
  const hubConnectedNodesRef = useRef(hubConnectedNodes);
  const directNodeSetRef = useRef(directNodeSet);
  const localConnectedNodesRef = useRef(localConnectedNodes);
  const showTopologyRef = useRef(showTopology);
  
  // Update refs when values change
  useEffect(() => {
    hubConnectedNodesRef.current = hubConnectedNodes;
    directNodeSetRef.current = directNodeSet;
    localConnectedNodesRef.current = localConnectedNodes;
    showTopologyRef.current = showTopology;
  }, [hubConnectedNodes, directNodeSet, localConnectedNodes, showTopology]);
  
  // Main animation effect
  useEffect(() => {
    const wasDirectMode = prevSoloDirectRef.current;
    const wasHubsMode = prevSoloHubsRef.current;
    const isDirectMode = soloDirect;
    const isHubsMode = soloHubs;
    prevSoloDirectRef.current = soloDirect;
    prevSoloHubsRef.current = soloHubs;
    
    // Detect which mode changed
    const directChanged = wasDirectMode !== isDirectMode;
    const hubsChanged = wasHubsMode !== isHubsMode;
    
    // Skip if no change
    if (!directChanged && !hubsChanged) return;
    
    // Cancel any existing animation
    if (nodeAnimationFrameRef.current) {
      cancelAnimationFrame(nodeAnimationFrameRef.current);
      nodeAnimationFrameRef.current = null;
    }
    
    // Use refs to get current values (avoids stale closures)
    const hubConnected = hubConnectedNodesRef.current;
    const directNodes = directNodeSetRef.current;
    const localConnected = localConnectedNodesRef.current;
    const topologyOn = showTopologyRef.current;
    
    // Generate random stagger delays (only once per node, persisted across toggles)
    for (const hash of neighborHashes) {
      if (!nodeStaggerDelaysRef.current.has(hash)) {
        nodeStaggerDelaysRef.current.set(hash, Math.random());
      }
    }
    
    // Helper: determine if node should be visible given mode state
    const isVisibleInMode = (hash: string, directMode: boolean, hubsMode: boolean): boolean => {
      const isHubConnected = hubConnected.has(hash);
      const isDirect = directNodes.has(hash);
      const isLocalConnected = topologyOn && localConnected.has(hash);
      
      if (!directMode && !hubsMode) return true;
      if (directMode && hubsMode) return isHubConnected || isDirect || isLocalConnected;
      if (hubsMode) return isHubConnected;
      if (directMode) return isDirect || isLocalConnected;
      return true;
    };
    
    // Build animation targets - only for nodes whose visibility actually changed
    const animationTargets: Array<{ hash: string; startOpacity: number; targetOpacity: number }> = [];
    
    for (const hash of neighborHashes) {
      const wasVisible = isVisibleInMode(hash, wasDirectMode, wasHubsMode);
      const nowVisible = isVisibleInMode(hash, isDirectMode, isHubsMode);
      
      // Only animate if visibility changed
      if (wasVisible !== nowVisible) {
        animationTargets.push({
          hash,
          startOpacity: wasVisible ? 1 : 0,
          targetOpacity: nowVisible ? 1 : 0,
        });
      }
    }
    
    if (animationTargets.length === 0) return;
    
    // Initialize animating nodes to their start opacity
    setNodeOpacities(prev => {
      const next = new Map(prev);
      for (const { hash, startOpacity } of animationTargets) {
        next.set(hash, startOpacity);
      }
      return next;
    });
    
    // Capture targets for animation closure
    const targets = animationTargets;
    
    let startTime: number | null = null;
    const animateNodes = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      
      let allComplete = true;
      
      setNodeOpacities(() => {
        const next = new Map<string, number>();
        
        for (const { hash, startOpacity, targetOpacity } of targets) {
          const staggerDelay = (nodeStaggerDelaysRef.current.get(hash) ?? 0) * MAX_NODE_STAGGER_DELAY;
          const nodeElapsed = Math.max(0, elapsed - staggerDelay);
          const progress = Math.min(nodeElapsed / NODE_FADE_DURATION, 1);
          const eased = easeInOutCubic(progress);
          
          // Interpolate between start and target
          const opacity = startOpacity + (targetOpacity - startOpacity) * eased;
          next.set(hash, opacity);
          
          if (progress < 1) allComplete = false;
        }
        
        return next;
      });
      
      const totalDuration = NODE_FADE_DURATION + MAX_NODE_STAGGER_DELAY;
      if (elapsed < totalDuration && !allComplete) {
        nodeAnimationFrameRef.current = requestAnimationFrame(animateNodes);
      } else {
        nodeAnimationFrameRef.current = null;
        // Animation complete - clear opacity map so nodes use default visibility
        setNodeOpacities(new Map());
      }
    };
    
    nodeAnimationFrameRef.current = requestAnimationFrame(animateNodes);
    
    // Cleanup on unmount
    return () => {
      if (nodeAnimationFrameRef.current) {
        cancelAnimationFrame(nodeAnimationFrameRef.current);
        nodeAnimationFrameRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soloDirect, soloHubs, neighborHashes]);
  
  // Helper to get effective opacity for a node
  const getNodeOpacity = (hash: string, shouldShow: boolean): number => {
    if (nodeOpacities.has(hash)) {
      return nodeOpacities.get(hash)!;
    }
    return shouldShow ? 1 : 0;
  };
  
  return {
    nodeOpacities,
    getNodeOpacity,
  };
}
