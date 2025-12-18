import { useState, useEffect, memo } from 'react';
import { useTheme } from '@/lib/theme';

/**
 * Background image renderer with best-in-class performance optimizations.
 * 
 * Features:
 * - CSS containment for paint isolation
 * - will-change hints for GPU-accelerated transitions
 * - Crossfade transition between background images
 * - Brightness overlay with smooth transitions
 * - Preloads images before switching to prevent flash
 */
export const BackgroundProvider = memo(function BackgroundProvider() {
  const { theme } = useTheme();
  const { backgroundImage, brightness } = theme;

  // Track the currently displayed image (for crossfade)
  const [displayedImage, setDisplayedImage] = useState(backgroundImage);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Handle image transitions with preloading
  useEffect(() => {
    if (backgroundImage === displayedImage) return;

    // Preload the new image before switching
    const img = new Image();
    img.onload = () => {
      setIsTransitioning(true);
      // Allow the fade-out to start, then switch image
      requestAnimationFrame(() => {
        setDisplayedImage(backgroundImage);
        // Reset transition state after animation completes
        setTimeout(() => setIsTransitioning(false), 300);
      });
    };
    img.onerror = () => {
      // Fallback: switch immediately if load fails
      setDisplayedImage(backgroundImage);
    };
    img.src = backgroundImage;
  }, [backgroundImage, displayedImage]);

  // Calculate overlay opacity: 0 at 100% brightness, 1 at 0% brightness
  const overlayOpacity = (100 - brightness) / 100;

  return (
    <>
      {/* 
        Background image layer
        - Fixed positioning with full viewport coverage
        - contain: paint isolates repaints to this element
        - will-change hints GPU acceleration for opacity transitions
        - object-fit: cover ensures consistent scaling
      */}
      <div
        className="fixed inset-0 -z-20"
        style={{
          contain: 'paint',
          willChange: isTransitioning ? 'opacity' : 'auto',
        }}
        aria-hidden="true"
      >
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-300 ease-out"
          style={{
            backgroundImage: `url(${displayedImage})`,
            opacity: isTransitioning ? 0.7 : 1,
          }}
        />
      </div>

      {/* 
        Brightness overlay
        - Separate layer for independent opacity control
        - pointer-events-none to not block interactions
        - Smooth transition for brightness changes
      */}
      <div
        className="fixed inset-0 -z-10 bg-black pointer-events-none transition-opacity duration-200 ease-out"
        style={{
          opacity: overlayOpacity,
          contain: 'paint',
        }}
        aria-hidden="true"
      />
    </>
  );
});
