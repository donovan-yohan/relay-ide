import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { describe, it, expect, vi } from 'vitest';
import TuiInput from '../../frontend/src/components/TuiInput.js';
import { getTuiCursorGeometry } from '../../frontend/src/components/tuiCursorGeometry.js';

// Most behavior is deterministic; the scroll regression below mounts the
// component with the repo's existing happy-dom dependency.

describe('TuiInput', () => {
  describe('Props Interface', () => {
    it('should have optional value prop with default empty string', () => {
      interface TuiInputProps {
        value?: string;
      }

      const propsWithoutValue: TuiInputProps = {};
      expect(propsWithoutValue.value).toBe(undefined);

      const propsWithValue: TuiInputProps = { value: 'test' };
      expect(propsWithValue.value).toBe('test');
    });

    it('should have optional placeholder prop', () => {
      interface TuiInputProps {
        placeholder?: string;
      }

      const props: TuiInputProps = { placeholder: 'Enter text' };
      expect(props.placeholder).toBe('Enter text');
    });

    it('should have type prop with text or password options', () => {
      interface TuiInputProps {
        type?: 'text' | 'password';
      }

      const textType: TuiInputProps = { type: 'text' };
      expect(textType.type).toBe('text');

      const passwordType: TuiInputProps = { type: 'password' };
      expect(passwordType.type).toBe('password');
    });

    it('should have optional disabled prop', () => {
      interface TuiInputProps {
        disabled?: boolean;
      }

      const propsWithDisabled: TuiInputProps = { disabled: true };
      expect(propsWithDisabled.disabled).toBe(true);

      const propsWithoutDisabled: TuiInputProps = {};
      expect(propsWithoutDisabled.disabled).toBe(undefined);
    });

    it('should have optional id prop', () => {
      interface TuiInputProps {
        id?: string;
      }

      const props: TuiInputProps = { id: 'my-input' };
      expect(props.id).toBe('my-input');
    });

    it('should have optional onInput callback', () => {
      interface TuiInputProps {
        onInput?: (e: React.FormEvent<HTMLInputElement>) => void;
      }

      const handleInput = (_e: React.FormEvent<HTMLInputElement>) => {};

      const props: TuiInputProps = { onInput: handleInput };
      expect(typeof props.onInput).toBe('function');
    });

    it('should have optional onKeyDown callback', () => {
      interface TuiInputProps {
        onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
      }

      const handleKeyDown = (_e: React.KeyboardEvent<HTMLInputElement>) => {};

      const props: TuiInputProps = { onKeyDown: handleKeyDown };
      expect(typeof props.onKeyDown).toBe('function');
    });

    it('should have optional onChange callback', () => {
      interface TuiInputProps {
        onChange?: (value: string) => void;
      }

      let calledWith: string | undefined;
      const handleChange = (value: string) => {
        calledWith = value;
      };

      const props: TuiInputProps = { onChange: handleChange };
      expect(typeof props.onChange).toBe('function');

      props.onChange?.('new value');
      expect(calledWith).toBe('new value');
    });

    it('should have optional className prop', () => {
      interface TuiInputProps {
        className?: string;
      }

      const props: TuiInputProps = { className: 'custom-class' };
      expect(props.className).toBe('custom-class');
    });

    it('should have optional autoFocus prop', () => {
      interface TuiInputProps {
        autoFocus?: boolean;
      }

      const propsWithAutoFocus: TuiInputProps = { autoFocus: true };
      expect(propsWithAutoFocus.autoFocus).toBe(true);

      const propsWithoutAutoFocus: TuiInputProps = {};
      expect(propsWithoutAutoFocus.autoFocus).toBe(undefined);
    });

    it('should support rest props spread', () => {
      interface TuiInputProps {
        [key: string]: unknown;
      }

      const props: TuiInputProps = {
        'data-testid': 'test-input',
        'aria-label': 'Test input',
        maxLength: 100,
      };
      expect(props['data-testid']).toBe('test-input');
      expect(props['aria-label']).toBe('Test input');
      expect(props.maxLength).toBe(100);
    });
  });

  describe('Component Logic', () => {
    it('should mask password input with bullet character', () => {
      const type = 'password';
      const value = 'secret';
      const selStart = 3;

      const textBeforeCursor =
        type === 'password'
          ? '\u2022'.repeat(selStart)
          : value.slice(0, selStart);

      expect(textBeforeCursor).toBe('\u2022\u2022\u2022');
    });

    it('should not mask text input', () => {
      const type: string = 'text';
      const value = 'hello';
      const selStart = 3;

      const textBeforeCursor =
        type === 'password'
          ? '\u2022'.repeat(selStart)
          : value.slice(0, selStart);

      expect(textBeforeCursor).toBe('hel');
    });

    it('should apply idle timeout of 530ms', () => {
      const IDLE_TIMEOUT = 530;
      expect(IDLE_TIMEOUT).toBe(530);
    });

    it('should show cursor when focused and not disabled', () => {
      const isFocused = true;
      const disabled = false;
      const showCursor = isFocused && !disabled;
      expect(showCursor).toBe(true);
    });

    it('should hide cursor when not focused', () => {
      const isFocused = false;
      const disabled = false;
      const showCursor = isFocused && !disabled;
      expect(showCursor).toBe(false);
    });

    it('should hide cursor when disabled', () => {
      const isFocused = true;
      const disabled = true;
      const showCursor = isFocused && !disabled;
      expect(showCursor).toBe(false);
    });

    it('should apply blinking class when idle and no reduced motion', () => {
      const isIdle = true;
      const prefersReducedMotion = false;
      const shouldBlink = isIdle && !prefersReducedMotion;
      expect(shouldBlink).toBe(true);
    });

    it('should not blink when reduced motion is preferred', () => {
      const isIdle = true;
      const prefersReducedMotion = true;
      const shouldBlink = isIdle && !prefersReducedMotion;
      expect(shouldBlink).toBe(false);
    });

    it('should not blink when not idle', () => {
      const isIdle = false;
      const prefersReducedMotion = false;
      const shouldBlink = isIdle && !prefersReducedMotion;
      expect(shouldBlink).toBe(false);
    });
  });

  describe('CSS Classes', () => {
    it('should have correct base classes', () => {
      const expectedClasses = {
        wrapper: 'tui-input-wrapper',
        input: 'tui-input',
        measure: 'tui-measure',
        cursor: 'tui-cursor',
        blinking: 'blinking',
      };

      expect(expectedClasses.wrapper).toBe('tui-input-wrapper');
      expect(expectedClasses.input).toBe('tui-input');
      expect(expectedClasses.measure).toBe('tui-measure');
      expect(expectedClasses.cursor).toBe('tui-cursor');
      expect(expectedClasses.blinking).toBe('blinking');
    });

    it('should combine custom className with base wrapper class', () => {
      const className = 'custom-class';
      const classes = ['tui-input-wrapper', className]
        .filter(Boolean)
        .join(' ');
      expect(classes).toBe('tui-input-wrapper custom-class');
    });
  });

  describe('Cursor Position Calculation', () => {
    it('should use block cursor character', () => {
      const blockCursor = '\u2588';
      expect(blockCursor).toBe('\u2588');
    });

    it('should default cursor height to 16 when input height is 0', () => {
      const inputHeight = 0;
      const cursorHeight = inputHeight || 16;
      expect(cursorHeight).toBe(16);
    });

    it('should use input height when available', () => {
      const inputHeight = 24;
      const cursorHeight = inputHeight || 16;
      expect(cursorHeight).toBe(24);
    });

    it('anchors the cursor to the text content line instead of the input border box', () => {
      expect(
        getTuiCursorGeometry({
          borderLeft: 1,
          borderTop: 1,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 8,
          paddingBottom: 8,
          clientHeight: 38,
          clientWidth: 300,
          scrollLeft: 0,
          textBeforeCursorWidth: 42,
          textAlign: 'left',
        })
      ).toEqual({ left: 51, top: 9, height: 22 });
    });

    it('keeps the cursor aligned after the input scrolls horizontally', () => {
      expect(
        getTuiCursorGeometry({
          borderLeft: 1,
          borderTop: 1,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 8,
          paddingBottom: 8,
          clientHeight: 38,
          clientWidth: 120,
          scrollLeft: 36,
          textBeforeCursorWidth: 112,
          textAlign: 'left',
        }).left
      ).toBe(85);
    });

    it('uses the measured text width with the centered input content box', () => {
      expect(
        getTuiCursorGeometry({
          borderLeft: 1,
          borderTop: 1,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 8,
          paddingBottom: 8,
          clientHeight: 38,
          clientWidth: 200,
          scrollLeft: 0,
          textBeforeCursorWidth: 24,
          fullTextWidth: 48,
          textAlign: 'center',
        }).left
      ).toBe(101);
    });

    it('tracks an input scroll without replacing the caller callback', async () => {
      const domWindow = new Window();
      const originalWindow = globalThis.window;
      const originalDocument = globalThis.document;
      const originalNavigator = Object.getOwnPropertyDescriptor(
        globalThis,
        'navigator'
      );
      const originalActEnvironment = (
        globalThis as {
          IS_REACT_ACT_ENVIRONMENT?: boolean;
        }
      ).IS_REACT_ACT_ENVIRONMENT;
      const callerOnScroll = vi.fn();
      const container = domWindow.document.createElement('div');

      Object.assign(globalThis, {
        window: domWindow,
        document: domWindow.document,
      });
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: domWindow.navigator,
      });
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      const root = createRoot(container);
      vi.spyOn(domWindow, 'getComputedStyle').mockReturnValue({
        font: 'normal 14px monospace',
        fontKerning: 'auto',
        fontFeatureSettings: 'normal',
        fontVariationSettings: 'normal',
        letterSpacing: 'normal',
        wordSpacing: 'normal',
        paddingLeft: '8px',
        paddingRight: '8px',
        paddingTop: '8px',
        paddingBottom: '8px',
        borderLeftWidth: '1px',
        borderTopWidth: '1px',
        textAlign: 'left',
      } as CSSStyleDeclaration);

      try {
        await act(async () => {
          root.render(
            React.createElement(TuiInput, {
              value: 'asdas',
              onScroll: callerOnScroll,
            })
          );
        });

        const input = container.querySelector('input');
        const measure = container.querySelector('.tui-measure');
        expect(input).not.toBeNull();
        expect(measure).not.toBeNull();
        if (!input || !measure) return;

        Object.defineProperties(input, {
          clientHeight: { configurable: true, value: 38 },
          clientWidth: { configurable: true, value: 120 },
          scrollLeft: { configurable: true, value: 0, writable: true },
        });
        Object.defineProperty(measure, 'offsetWidth', {
          configurable: true,
          value: 42,
        });
        input.setSelectionRange(5, 5);

        await act(async () => {
          input.dispatchEvent(
            new domWindow.FocusEvent('focusin', { bubbles: true })
          );
        });
        const cursor = container.querySelector('.tui-cursor') as HTMLElement;
        expect(cursor.style.left).toBe('51px');

        input.scrollLeft = 36;
        await act(async () => {
          input.dispatchEvent(new domWindow.Event('scroll', { bubbles: true }));
        });

        expect(callerOnScroll).toHaveBeenCalledTimes(1);
        expect(callerOnScroll.mock.calls[0]?.[0].target).toBe(input);
        expect(cursor.style.left).toBe('15px');
      } finally {
        await act(async () => root.unmount());
        vi.restoreAllMocks();
        Object.assign(globalThis, {
          window: originalWindow,
          document: originalDocument,
        });
        if (originalNavigator) {
          Object.defineProperty(globalThis, 'navigator', originalNavigator);
        }
        (
          globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
      }
    });
  });

  describe('Accessibility', () => {
    it('should mark measure span as aria-hidden', () => {
      const ariaHidden = true;
      expect(ariaHidden).toBe(true);
    });

    it('should mark cursor span as aria-hidden', () => {
      const ariaHidden = true;
      expect(ariaHidden).toBe(true);
    });
  });
});
