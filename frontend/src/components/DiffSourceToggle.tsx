import type { DiffSource } from '../lib/types.js';
import './DiffSourceToggle.css';

export interface DiffSourceToggleProps {
  value?: DiffSource;
  onchange: (source: DiffSource) => void;
  defaultBranch?: string;
}

const options: Array<{ value: DiffSource; label: string }> = [
  { value: 'working', label: 'working tree' },
  { value: 'staged', label: 'staged' },
  { value: 'branch', label: 'branch' },
];

export function DiffSourceToggle({ value = 'working', onchange, defaultBranch = 'main' }: DiffSourceToggleProps) {
  return (
    <div className="diff-source-toggle" role="radiogroup" aria-label="diff source">
      {options.map((option) => (
        <button
          key={option.value}
          className={`toggle-option${value === option.value ? ' active' : ''}`}
          role="radio"
          aria-checked={value === option.value}
          type="button"
          onClick={() => onchange(option.value)}
        >
          {option.value === 'branch' ? `vs ${defaultBranch}` : option.label}
        </button>
      ))}
    </div>
  );
}

export default DiffSourceToggle;
