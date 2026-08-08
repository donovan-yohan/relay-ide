import React, { useState, useRef, useEffect, useCallback } from 'react';
import './TuiInput.css';
import { getTuiCursorGeometry } from './tuiCursorGeometry.js';

export interface TuiInputProps {
  value?: string;
  placeholder?: string;
  type?: 'text' | 'password';
  disabled?: boolean;
  id?: string;
  onInput?: (e: React.FormEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onScroll?: (e: React.UIEvent<HTMLInputElement>) => void;
  onChange?: (value: string) => void;
  className?: string;
  autoFocus?: boolean;
  [key: string]: unknown;
}

export const TuiInput: React.FC<TuiInputProps> = ({
  value = '',
  placeholder,
  type = 'text',
  disabled = false,
  id,
  onInput,
  onKeyDown,
  onScroll,
  onChange,
  className = '',
  autoFocus = false,
  ...rest
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [isIdle, setIsIdle] = useState(true);
  const [cursorLeft, setCursorLeft] = useState(0);
  const [cursorTop, setCursorTop] = useState(0);
  const [cursorHeight, setCursorHeight] = useState(16);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);

    const handler = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const updateCursorPosition = useCallback(() => {
    if (!inputRef.current || !measureRef.current) return;

    const inputValue = inputRef.current.value;
    const selStart = inputRef.current.selectionStart ?? 0;
    const textBeforeCursor =
      type === 'password'
        ? '\u2022'.repeat(selStart)
        : inputValue.slice(0, selStart);

    const computedStyle = window.getComputedStyle(inputRef.current);
    // The marker must use the input's resolved typography. A surrounding form
    // may override the input's weight, spacing, or font variation settings.
    measureRef.current.style.font = computedStyle.font;
    measureRef.current.style.fontKerning = computedStyle.fontKerning;
    measureRef.current.style.fontFeatureSettings =
      computedStyle.fontFeatureSettings;
    measureRef.current.style.fontVariationSettings =
      computedStyle.fontVariationSettings;
    measureRef.current.style.letterSpacing = computedStyle.letterSpacing;
    measureRef.current.style.wordSpacing = computedStyle.wordSpacing;
    measureRef.current.textContent = textBeforeCursor || '';
    const textBeforeCursorWidth = measureRef.current.offsetWidth;

    const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(computedStyle.paddingRight) || 0;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
    const borderLeft = parseFloat(computedStyle.borderLeftWidth) || 0;
    const borderTop = parseFloat(computedStyle.borderTopWidth) || 0;
    let fullTextWidth = 0;

    if (computedStyle.textAlign === 'center') {
      const fullText =
        type === 'password' ? '\u2022'.repeat(inputValue.length) : inputValue;
      measureRef.current.textContent = fullText;
      fullTextWidth = measureRef.current.offsetWidth;
    }

    const cursor = getTuiCursorGeometry({
      borderLeft,
      borderTop,
      paddingLeft,
      paddingRight,
      paddingTop,
      paddingBottom,
      clientHeight: inputRef.current.clientHeight,
      clientWidth: inputRef.current.clientWidth,
      scrollLeft: inputRef.current.scrollLeft,
      textBeforeCursorWidth,
      fullTextWidth,
      textAlign: computedStyle.textAlign,
    });

    setCursorLeft(cursor.left);
    setCursorTop(cursor.top);
    setCursorHeight(cursor.height);
  }, [type]);

  useEffect(() => {
    updateCursorPosition();
  }, [value, updateCursorPosition]);

  useEffect(() => {
    return () => {
      if (idleTimeoutRef.current !== undefined) {
        clearTimeout(idleTimeoutRef.current);
      }
    };
  }, []);

  const handleInput = (e: React.FormEvent<HTMLInputElement>) => {
    const newValue = (e.target as HTMLInputElement).value;

    if (onChange) {
      onChange(newValue);
    }

    setIsIdle(false);
    if (idleTimeoutRef.current !== undefined) {
      clearTimeout(idleTimeoutRef.current);
    }
    idleTimeoutRef.current = setTimeout(() => {
      setIsIdle(true);
    }, 530);

    updateCursorPosition();

    if (onInput) {
      onInput(e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setIsIdle(false);
    if (idleTimeoutRef.current !== undefined) {
      clearTimeout(idleTimeoutRef.current);
    }
    idleTimeoutRef.current = setTimeout(() => {
      setIsIdle(true);
    }, 530);

    requestAnimationFrame(updateCursorPosition);

    if (onKeyDown) {
      onKeyDown(e);
    }
  };

  const handleFocus = () => {
    setIsFocused(true);
    updateCursorPosition();
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (idleTimeoutRef.current !== undefined) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = undefined;
    }
    setIsIdle(true);
  };

  const handleClick = () => {
    requestAnimationFrame(updateCursorPosition);
  };

  const handleScroll = (event: React.UIEvent<HTMLInputElement>) => {
    updateCursorPosition();
    onScroll?.(event);
  };

  const wrapperClasses = ['tui-input-wrapper', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClasses}>
      <input
        ref={inputRef}
        type={type}
        value={value}
        disabled={disabled}
        id={id}
        placeholder={placeholder}
        className="tui-input"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onClick={handleClick}
        onScroll={handleScroll}
        autoFocus={autoFocus}
        {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
      />
      {/* Hidden span for text width measurement */}
      <span ref={measureRef} className="tui-measure" aria-hidden="true" />
      {/* Block cursor overlay */}
      {isFocused && !disabled && (
        <span
          className={`tui-cursor${isIdle && !prefersReducedMotion ? ' blinking' : ''}`}
          style={{
            left: `${cursorLeft}px`,
            top: `${cursorTop}px`,
            height: `${cursorHeight}px`,
            lineHeight: `${cursorHeight}px`,
          }}
          aria-hidden="true"
        >
          {'\u2588'}
        </span>
      )}
    </div>
  );
};

export default TuiInput;
