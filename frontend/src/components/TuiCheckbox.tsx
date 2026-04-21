import React from 'react';
import './TuiCheckbox.css';

export interface TuiCheckboxProps {
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  children?: React.ReactNode;
  className?: string;
  [key: string]: unknown;
}

export const TuiCheckbox: React.FC<TuiCheckboxProps> = ({
  checked = false,
  disabled = false,
  onChange,
  children,
  className = '',
  ...rest
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!disabled && onChange) {
      onChange(e.target.checked);
    }
  };

  const labelClasses = [
    'tui-checkbox',
    disabled && 'disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label className={labelClasses}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
      />
      <span className="tui-check">{checked ? '[x]' : '[ ]'}</span>
      {children}
    </label>
  );
};

export default TuiCheckbox;