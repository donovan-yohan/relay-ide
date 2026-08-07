import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import useClickOutside from '../hooks/useClickOutside.js';
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
  disabled?: boolean;
}

export function SearchableSelect({
  options,
  value = '',
  placeholder = 'Select...',
  onchange,
  disabled = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? '',
    [options, value]
  );

  const filteredOptions = useMemo(() => {
    if (!searchText.trim()) return options;
    const lower = searchText.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(lower));
  }, [options, searchText]);
  const selectableOptions = useMemo(
    () => [{ value: '', label: placeholder }, ...filteredOptions],
    [filteredOptions, placeholder]
  );

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, selectableOptions.length - 1)
    );
  }, [selectableOptions.length]);

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
    if (disabled) return;
    setOpen(true);
    setSearchText('');
    const selected = options.findIndex((option) => option.value === value);
    setActiveIndex(selected >= 0 ? selected + 1 : 0);
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
    if (e.key === 'Escape') {
      close();
      e.stopPropagation();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(
        (current) =>
          (current + delta + selectableOptions.length) %
          selectableOptions.length
      );
      return;
    }
    if (e.key === 'Enter' && open) {
      e.preventDefault();
      const option = selectableOptions[activeIndex];
      if (option) select(option.value);
    }
  }

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (
      e.key === 'ArrowDown' ||
      e.key === 'ArrowUp' ||
      e.key === 'Enter' ||
      e.key === ' '
    ) {
      e.preventDefault();
      openDropdown();
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
            onChange={(e) => {
              setSearchText(e.currentTarget.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeydown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={`${listboxId}-option-${activeIndex}`}
            aria-autocomplete="list"
          />
          <div className="ss-dropdown" id={listboxId} role="listbox">
            <TuiMenuPanel>
              {selectableOptions.map((opt, index) => (
                <TuiMenuItem
                  key={opt.value}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  ariaSelected={opt.value === value}
                  tabIndex={-1}
                  onmousedown={() => select(opt.value)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={index === activeIndex ? 'ss-active' : ''}
                >
                  <span
                    className={[
                      opt.value === '' && 'ss-option--reset',
                      opt.value === value && 'ss-selected',
                    ]
                      .filter(Boolean)
                      .join(' ')}
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
        <button
          type="button"
          className="ss-trigger"
          onClick={openDropdown}
          onKeyDown={onTriggerKeyDown}
          disabled={disabled}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded="false"
          aria-controls={listboxId}
        >
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
