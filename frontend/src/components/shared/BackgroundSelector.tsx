

import { useState, useEffect, useRef } from 'react';
import clsx from 'clsx';

const BACKGROUNDS = [
  { id: 'default', src: '/images/bg.jpg', theme: null },
  { id: 'amber', src: '/images/bg-amber.jpg', theme: 'amber' },
  { id: 'grey', src: '/images/bg-grey.jpg', theme: 'grey' },
  { id: 'black', src: '/images/bg-black.jpg', theme: 'black' },
  { id: 'flora', src: '/images/bg-flora.jpg', theme: 'flora' },
] as const;

type BackgroundId = typeof BACKGROUNDS[number]['id'];

const STORAGE_KEY = 'pymc-background';
const BRIGHTNESS_KEY = 'pymc-bg-brightness';

/**
 * Background selector with square thumbnail chips
 * Visual-only selection (no text labels)
 */
export function BackgroundSelector() {
  const [selected, setSelected] = useState<BackgroundId>('default');
const [brightness, setBrightness] = useState(80); // 0-100, default 80%
  const [showSlider, setShowSlider] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  // Track drag start Y and initial brightness for relative dragging
  const dragStartRef = useRef<{ y: number; brightness: number } | null>(null);

  // Load preference from localStorage on mount
  useEffect(() => {
    // Use queueMicrotask to avoid sync setState in effect
    queueMicrotask(() => setMounted(true));
    
    const stored = localStorage.getItem(STORAGE_KEY) as BackgroundId | null;
    const storedBrightness = localStorage.getItem(BRIGHTNESS_KEY);
    
    if (storedBrightness) {
      const val = parseInt(storedBrightness, 10);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        queueMicrotask(() => setBrightness(val));
      }
    }
    
    if (stored && BACKGROUNDS.some(bg => bg.id === stored)) {
      queueMicrotask(() => setSelected(stored));
      // Apply theme on initial load
      const bg = BACKGROUNDS.find(b => b.id === stored);
      if (bg?.theme) {
        document.documentElement.setAttribute('data-theme', bg.theme);
      }
    }
  }, []);

  // Apply background and theme change
  const handleSelect = (id: BackgroundId) => {
    setSelected(id);
    setShowSlider(true); // Show slider immediately on selection
    localStorage.setItem(STORAGE_KEY, id);
    
    // Apply theme to document
    const bg = BACKGROUNDS.find(b => b.id === id);
    if (bg?.theme) {
      document.documentElement.setAttribute('data-theme', bg.theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    
    // Dispatch custom event so layout can update background image
    window.dispatchEvent(new CustomEvent('background-change', { detail: id }));
  };

  // Handle brightness change
  const handleBrightnessChange = (value: number) => {
    setBrightness(value);
    localStorage.setItem(BRIGHTNESS_KEY, String(value));
    window.dispatchEvent(new CustomEvent('brightness-change', { detail: value }));
  };

  // Don't render until mounted to avoid hydration mismatch
  if (!mounted) {
    return <div className="flex gap-2" />;
  }

  // Calculate brightness delta from drag distance
  // Moving up = brighter, down = dimmer
  // Touch: 200px drag = full 0-100 range (comfortable for finger)
  // Mouse: 80px drag = full 0-100 range (more responsive for desktop)
  const calcBrightnessFromDrag = (clientY: number, isTouch: boolean): number => {
    if (!dragStartRef.current) return brightness;
    const deltaY = dragStartRef.current.y - clientY; // Negative = down, positive = up
    const dragDistance = isTouch ? 200 : 80; // Touch needs more distance, mouse is more precise
    const deltaBrightness = (deltaY / dragDistance) * 100;
    const newValue = Math.round(Math.max(0, Math.min(100, dragStartRef.current.brightness + deltaBrightness)));
    return newValue;
  };

  return (
    <div className="flex gap-2 items-center flex-shrink-0">
      {BACKGROUNDS.map((bg) => {
        const isSelected = selected === bg.id;
        const showOverlay = isSelected && (showSlider || isDragging);
        
        return (
          <div
            key={bg.id}
            ref={isSelected ? sliderRef : undefined}
            className={clsx(
              'relative rounded-md overflow-hidden transition-all duration-300 ease-out',
              'ring-offset-1 ring-offset-bg-body w-10 h-10',
              isSelected
                ? 'ring-2 ring-accent-primary scale-105 cursor-ns-resize'
                : 'ring-1 ring-white/20 hover:ring-white/40 opacity-70 hover:opacity-100 cursor-pointer'
            )}
            onMouseEnter={() => isSelected && setShowSlider(true)}
            onMouseLeave={() => !isDragging && setShowSlider(false)}
            onClick={() => !isSelected && handleSelect(bg.id)}
            onTouchStart={(e) => {
              if (!isSelected) return;
              e.preventDefault();
              
              // Start drag tracking
              const touch = e.touches[0];
              dragStartRef.current = { y: touch.clientY, brightness };
              setIsDragging(true);
              setShowSlider(true);
              
              const onMove = (ev: TouchEvent) => {
                ev.preventDefault();
                const touch = ev.touches[0];
                handleBrightnessChange(calcBrightnessFromDrag(touch.clientY, true));
              };
              const onEnd = () => {
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                dragStartRef.current = null;
                setIsDragging(false);
                // Keep slider visible briefly after release
                setTimeout(() => setShowSlider(false), 1500);
              };
              
              document.addEventListener('touchmove', onMove, { passive: false });
              document.addEventListener('touchend', onEnd);
            }}
            onMouseDown={(e) => {
              if (!isSelected) return;
              e.preventDefault();
              
              // Start drag tracking
              dragStartRef.current = { y: e.clientY, brightness };
              setIsDragging(true);
              setShowSlider(true);
              
              const onMove = (ev: MouseEvent) => {
                handleBrightnessChange(calcBrightnessFromDrag(ev.clientY, false));
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                dragStartRef.current = null;
                setIsDragging(false);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          >
            {/* Background image - dims when adjusting */}
            <div 
              className="absolute bg-cover bg-center transition-opacity duration-200"
              style={{ 
                inset: 0,
                backgroundImage: `url(${bg.src})`,
                opacity: showOverlay ? 0.4 : 1 
              }}
            />
            
            {/* Brightness fill overlay - shows current level */}
            {isSelected && (
              <div 
                className={clsx(
                  'absolute inset-0 transition-opacity duration-200',
                  showOverlay ? 'opacity-100' : 'opacity-0'
                )}
              >
                {/* Dark fill from bottom showing dimmed portion */}
                <div 
                  className="absolute inset-x-0 bottom-0 bg-black/70 transition-all duration-100 ease-out"
                  style={{ height: `${100 - brightness}%` }}
                />
                
                {/* Brightness line indicator */}
                <div
                  className="absolute inset-x-1 h-0.5 bg-white rounded-full shadow-lg transition-all duration-100 ease-out"
                  style={{ top: `${100 - brightness}%` }}
                />
                
                {/* Percentage in center */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] font-mono font-bold text-white drop-shadow-lg">
                    {brightness}%
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Hook to get current background URL
 * Used by layout to apply the selected background
 */
export function useBackground() {
  const [backgroundSrc, setBackgroundSrc] = useState('/images/bg.jpg');

  useEffect(() => {
    // Load initial value (use queueMicrotask to avoid sync setState in effect)
    const stored = localStorage.getItem(STORAGE_KEY) as BackgroundId | null;
    const bg = BACKGROUNDS.find(b => b.id === stored) || BACKGROUNDS[0];
    queueMicrotask(() => setBackgroundSrc(bg.src));

    // Listen for changes
    const handleChange = (e: CustomEvent<BackgroundId>) => {
      const bg = BACKGROUNDS.find(b => b.id === e.detail) || BACKGROUNDS[0];
      setBackgroundSrc(bg.src);
    };

    window.addEventListener('background-change', handleChange as EventListener);
    return () => {
      window.removeEventListener('background-change', handleChange as EventListener);
    };
  }, []);

  return backgroundSrc;
}
