import { useState, useRef, useCallback, memo } from 'react';
import clsx from 'clsx';
import { useTheme, THEME_PRESETS, preloadImage } from '@/lib/theme';

/**
 * Theme selector with square thumbnail chips.
 * 
 * Pure UI component - all state managed by ThemeContext.
 * Each thumbnail represents a theme preset (color scheme + background).
 * Drag up/down on selected thumbnail to adjust brightness.
 */
export const BackgroundSelector = memo(function BackgroundSelector() {
  const { theme, setThemePreset, setBrightness } = useTheme();
  const { backgroundImage, brightness } = theme;

  // Local UI state only
  const [showSlider, setShowSlider] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ y: number; brightness: number } | null>(null);

  // Find which preset matches current background
  const selectedPresetId = THEME_PRESETS.find(p => p.backgroundImage === backgroundImage)?.id ?? 'default';

  // Calculate brightness delta from drag distance
  const calcBrightnessFromDrag = useCallback((clientY: number, isTouch: boolean): number => {
    if (!dragStartRef.current) return brightness;
    const deltaY = dragStartRef.current.y - clientY;
    const dragDistance = isTouch ? 200 : 80;
    const deltaBrightness = (deltaY / dragDistance) * 100;
    return Math.round(Math.max(0, Math.min(100, dragStartRef.current.brightness + deltaBrightness)));
  }, [brightness]);

  // Handle preset selection
  const handleSelect = useCallback((presetId: string) => {
    setThemePreset(presetId);
    setShowSlider(true);
  }, [setThemePreset]);

  // Handle brightness drag
  const handleBrightnessChange = useCallback((value: number) => {
    setBrightness(value);
  }, [setBrightness]);

  // Preload adjacent theme images on hover for instant switching
  const handlePresetHover = useCallback((presetId: string) => {
    const preset = THEME_PRESETS.find(p => p.id === presetId);
    if (preset) {
      preloadImage(preset.backgroundImage);
    }
  }, []);

  return (
    <div className="flex gap-2 items-center flex-shrink-0">
      {THEME_PRESETS.map((preset) => {
        const isSelected = selectedPresetId === preset.id;
        const showOverlay = isSelected && (showSlider || isDragging);

        return (
          <div
            key={preset.id}
            ref={isSelected ? sliderRef : undefined}
            className={clsx(
              'relative rounded-md overflow-hidden transition-all duration-300 ease-out',
              'ring-offset-1 ring-offset-bg-body w-10 h-10',
              isSelected
                ? 'ring-2 ring-accent-primary scale-105 cursor-ns-resize'
                : 'ring-1 ring-white/20 hover:ring-white/40 opacity-70 hover:opacity-100 cursor-pointer'
            )}
            onMouseEnter={() => {
              if (isSelected) {
                setShowSlider(true);
              } else {
                handlePresetHover(preset.id);
              }
            }}
            onMouseLeave={() => !isDragging && setShowSlider(false)}
            onClick={() => !isSelected && handleSelect(preset.id)}
            onTouchStart={(e) => {
              if (!isSelected) return;
              e.preventDefault();

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
                setTimeout(() => setShowSlider(false), 1500);
              };

              document.addEventListener('touchmove', onMove, { passive: false });
              document.addEventListener('touchend', onEnd);
            }}
            onMouseDown={(e) => {
              if (!isSelected) return;
              e.preventDefault();

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
            {/* Background image thumbnail */}
            <div
              className="absolute bg-cover bg-center transition-opacity duration-200"
              style={{
                inset: 0,
                backgroundImage: `url(${preset.backgroundImage})`,
                opacity: showOverlay ? 0.4 : 1,
              }}
            />

            {/* Brightness fill overlay */}
            {isSelected && (
              <div
                className={clsx(
                  'absolute inset-0 transition-opacity duration-200',
                  showOverlay ? 'opacity-100' : 'opacity-0'
                )}
              >
                {/* Dark fill from bottom */}
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
});
