import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import useClickOutside from '../lib/hooks/useClickOutside.js';
import TuiMenuItem from './TuiMenuItem.js';
import TuiMenuPanel from './TuiMenuPanel.js';
import './SearchableSelect.css';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SearchableSelectProps {
  options: SelectOption[];
  value?: string;
  placeholder?: string;
  onchange?: (value: string) => void;
}

export function SearchableSelect({
  options,
  value = '',
  placeholder = 'Select...',
  onchange,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? '',
    [options, value]
  );

  const filteredOptions = useMemo(() => {
    if (!searchText.trim()) return options;
    const lower = searchText.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(lower));
  }, [options, searchText]);

  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  const handleClickOutside = useCallback(() => {
    close();
  }, []);
  useClickOutside(wrapperRef, handleClickOutside, open);

  function openDropdown() {
    setOpen(true);
    setSearchText('');
  }

  function close() {
    setOpen(false);
    setSearchText('');
  }

  function select(val: string) {
    close();
    onchange?.(val);
  }

  function onKeydown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      close();
      e.stopPropagation();
    }
  }

  return (
    <div className="searchable-select" ref={wrapperRef}>
      {open ? (
        <>
          <input
            ref={inputRef}
            type="text"
            className="ss-input"
            placeholder={selectedLabel || placeholder}
            value={searchText}
            onChange={(e) => setSearchText(e.currentTarget.value)}
            onKeyDown={onKeydown}
          />
          <div className="ss-dropdown" role="listbox">
            <TuiMenuPanel>
              <TuiMenuItem
                role="option"
                ariaSelected={!value}
                onmousedown={() => select('')}
              >
                <span
                  className={['ss-option--reset', !value && 'ss-selected']
                    .filter(Boolean)
                    .join(' ')}
                >
                  {placeholder}
                </span>
              </TuiMenuItem>
              {filteredOptions.map((opt) => (
                <TuiMenuItem
                  key={opt.value}
                  role="option"
                  ariaSelected={opt.value === value}
                  onmousedown={() => select(opt.value)}
                >
                  <span
                    className={opt.value === value ? 'ss-selected' : undefined}
                  >
                    {opt.label}
                  </span>
                </TuiMenuItem>
              ))}
              {filteredOptions.length === 0 ? (
                <TuiMenuItem role="option" disabled>
                  <span className="ss-no-results">No matches</span>
                </TuiMenuItem>
              ) : null}
            </TuiMenuPanel>
          </div>
        </>
      ) : (
        <button type="button" className="ss-trigger" onClick={openDropdown}>
          <span
            className={['ss-trigger-text', !value && 'ss-placeholder']
              .filter(Boolean)
              .join(' ')}
          >
            {selectedLabel || placeholder}
          </span>
          <svg className="ss-arrow" width="12" height="8" viewBox="0 0 12 8">
            <path
              d="M1 1l5 5 5-5"
              stroke="currentColor"
              fill="none"
              strokeWidth="1.5"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

export default SearchableSelect;
