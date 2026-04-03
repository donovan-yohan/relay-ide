import { useState, useEffect, useRef, useCallback } from 'react';
import './PinInput.css';

export interface PinInputProps {
  id?: string;
  value?: string;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  maxLength?: number;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
  onComplete?: (value: string) => void;
  error?: boolean;
  disabled?: boolean;
  length?: number;
}

export function PinInput({
  id,
  value = '',
  placeholder = 'PIN',
  onKeyDown,
  maxLength = 20,
  autoFocus = false,
  onChange,
  onComplete,
  error = false,
  disabled = false,
  length,
}: PinInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [isIdle, setIsIdle] = useState(true);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);

    const handler = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimeoutRef.current !== undefined) {
        clearTimeout(idleTimeoutRef.current);
      }
    };
  }, []);

  const resetIdle = useCallback(() => {
    setIsIdle(false);
    if (idleTimeoutRef.current !== undefined) {
      clearTimeout(idleTimeoutRef.current);
    }
    idleTimeoutRef.current = setTimeout(() => {
      setIsIdle(true);
    }, 530);
  }, []);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      onChange?.(newValue);
      resetIdle();

      if (length !== undefined && newValue.length === length) {
        onComplete?.(newValue);
      }
    },
    [onChange, onComplete, length, resetIdle]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      resetIdle();
      onKeyDown?.(e);
    },
    [onKeyDown, resetIdle]
  );

  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (idleTimeoutRef.current !== undefined) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = undefined;
    }
    setIsIdle(true);
  }, []);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const dots = value.length;
  const showPlaceholder = !value && !isFocused;

  return (
    <div
      className={`pin-input ${isFocused ? 'focused' : ''} ${error ? 'error' : ''} ${disabled ? 'disabled' : ''}`}
      onClick={focusInput}
    >
      <input
        ref={inputRef}
        id={id}
        type="password"
        inputMode="numeric"
        maxLength={maxLength}
        className="pin-hidden-input"
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      <div className="pin-display">
        {showPlaceholder ? (
          <span className="pin-placeholder">{placeholder}</span>
        ) : (
          <>
            {Array.from({ length: dots }).map((_, i) => (
              <span key={i} className="pin-dot">
                {'\u2022'}
              </span>
            ))}
            {isFocused && (
              <span className={`pin-cursor ${isIdle && !prefersReducedMotion ? 'blinking' : ''}`}>
                {'\u2588'}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}