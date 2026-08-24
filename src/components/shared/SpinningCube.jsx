import { cn } from '@/lib/utils';

/**
 * A pure-CSS 3D cube carrying the abstract Hostkind glyph on all six sides.
 * No 3D library is needed.
 *
 * @param {number|string} size      Edge length (px number or any CSS length). Default 96.
 * @param {number}        duration  Seconds per full rotation. Default 18.
 * @param {number}        opacity   0–1, for faded background usage. Default 1.
 */
export function SpinningCube({ size = 96, duration = 18, opacity = 1, className, style }) {
  const cubeSize = typeof size === 'number' ? `${size}px` : size;
  return (
    <div
      className={cn('ls-cube-scene', className)}
      style={{
        '--cube-size': cubeSize,
        '--cube-duration': `${duration}s`,
        opacity,
        ...style,
      }}
      aria-hidden="true"
    >
      <div className="ls-cube">
        <div className="ls-cube__face ls-cube__face--front" />
        <div className="ls-cube__face ls-cube__face--back" />
        <div className="ls-cube__face ls-cube__face--right" />
        <div className="ls-cube__face ls-cube__face--left" />
        <div className="ls-cube__face ls-cube__face--top" />
        <div className="ls-cube__face ls-cube__face--bottom" />
      </div>
    </div>
  );
}
