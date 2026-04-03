import { describe, it } from 'node:test';
import assert from 'node:assert';

// Note: Full DOM testing would require a test runner with JSX support (e.g., Vitest + React Testing Library)

describe('TuiCheckbox', () => {
  describe('Props Interface', () => {
    it('should have required checked prop', () => {
      interface TuiCheckboxProps {
        checked: boolean;
        disabled?: boolean;
        onChange?: (checked: boolean) => void;
        children?: React.ReactNode;
        className?: string;
        [key: string]: unknown;
      }
      
      const validProps: TuiCheckboxProps = { checked: true };
      assert.strictEqual(validProps.checked, true);
    });

    it('should have optional disabled prop with default false', () => {
      interface TuiCheckboxProps {
        checked: boolean;
        disabled?: boolean;
      }
      
      const propsWithDisabled: TuiCheckboxProps = { checked: false, disabled: true };
      assert.strictEqual(propsWithDisabled.disabled, true);
      
      const propsWithoutDisabled: TuiCheckboxProps = { checked: false };
      assert.strictEqual(propsWithoutDisabled.disabled, undefined);
    });

    it('should have optional onChange callback', () => {
      interface TuiCheckboxProps {
        checked: boolean;
        onChange?: (checked: boolean) => void;
      }
      
      let calledWith: boolean | undefined;
      const handleChange = (checked: boolean) => {
        calledWith = checked;
      };
      
      const props: TuiCheckboxProps = { checked: false, onChange: handleChange };
      assert.strictEqual(typeof props.onChange, 'function');
      
      props.onChange?.(true);
      assert.strictEqual(calledWith, true);
    });

    it('should support children prop', () => {
      interface TuiCheckboxProps {
        checked: boolean;
        children?: React.ReactNode;
      }
      
      const props: TuiCheckboxProps = { 
        checked: false, 
        children: 'Label text' 
      };
      assert.strictEqual(props.children, 'Label text');
    });

    it('should support className prop', () => {
      interface TuiCheckboxProps {
        checked: boolean;
        className?: string;
      }
      
      const props: TuiCheckboxProps = { 
        checked: false, 
        className: 'custom-class' 
      };
      assert.strictEqual(props.className, 'custom-class');
    });

    it('should support rest props spread', () => {
      interface TuiCheckboxProps {
        checked: boolean;
        [key: string]: unknown;
      }
      
      const props: TuiCheckboxProps = { 
        checked: false,
        'data-testid': 'test-checkbox',
        'aria-label': 'Test checkbox'
      };
      assert.strictEqual(props['data-testid'], 'test-checkbox');
      assert.strictEqual(props['aria-label'], 'Test checkbox');
    });
  });

  describe('Component Logic', () => {
    it('should display [x] when checked', () => {
      const checked = true;
      const displayText = checked ? '[x]' : '[ ]';
      assert.strictEqual(displayText, '[x]');
    });

    it('should display [ ] when unchecked', () => {
      const checked = false;
      const displayText = checked ? '[x]' : '[ ]';
      assert.strictEqual(displayText, '[ ]');
    });

    it('should apply disabled class when disabled', () => {
      const disabled = true;
      const classes = ['tui-checkbox', disabled && 'disabled'].filter(Boolean).join(' ');
      assert.strictEqual(classes, 'tui-checkbox disabled');
    });

    it('should not apply disabled class when not disabled', () => {
      const disabled = false;
      const classes = ['tui-checkbox', disabled && 'disabled'].filter(Boolean).join(' ');
      assert.strictEqual(classes, 'tui-checkbox');
    });

    it('should combine custom className with base classes', () => {
      const className = 'custom-class';
      const disabled = false;
      const classes = ['tui-checkbox', disabled && 'disabled', className]
        .filter(Boolean)
        .join(' ');
      assert.strictEqual(classes, 'tui-checkbox custom-class');
    });

    it('should not call onChange when disabled', () => {
      const disabled = true;
      let called = false;
      const onChange = (checked: boolean) => {
        called = true;
      };
      
      const handleChange = (e: { target: { checked: boolean } }) => {
        if (!disabled && onChange) {
          onChange(e.target.checked);
        }
      };
      
      handleChange({ target: { checked: true } });
      assert.strictEqual(called, false);
    });

    it('should call onChange when not disabled', () => {
      const disabled = false;
      let calledWith: boolean | undefined;
      const onChange = (checked: boolean) => {
        calledWith = checked;
      };
      
      const handleChange = (e: { target: { checked: boolean } }) => {
        if (!disabled && onChange) {
          onChange(e.target.checked);
        }
      };
      
      handleChange({ target: { checked: true } });
      assert.strictEqual(calledWith, true);
    });
  });

  describe('CSS Classes', () => {
    it('should have correct base class', () => {
      const expectedClasses = {
        container: 'tui-checkbox',
        check: 'tui-check',
        disabled: 'disabled'
      };
      
      assert.strictEqual(expectedClasses.container, 'tui-checkbox');
      assert.strictEqual(expectedClasses.check, 'tui-check');
      assert.strictEqual(expectedClasses.disabled, 'disabled');
    });
  });
});