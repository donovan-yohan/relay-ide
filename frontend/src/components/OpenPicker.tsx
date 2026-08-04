import React, { useEffect, useMemo, useRef, useState } from 'react';
import './OpenPicker.css';

export interface PickerItem {
  id: string;
  label: string;
  hint?: string;
}

export interface OpenPickerProps {
  items: PickerItem[];
  placeholder?: string;
  onSelect: (item: PickerItem) => void;
  onClose: () => void;
}

function fuzzyFilter(items: PickerItem[], query: string): PickerItem[] {
  if (!query.trim()) return items;
  const lower = query.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().includes(lower));
}

export function OpenPicker({ items, placeholder = 'Search...', onSelect, onClose }: OpenPickerProps) {
  const [filterText, setFilterText] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredItems = useMemo(() => fuzzyFilter(items, filterText), [items, filterText]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [filterText]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [onClose]);

  function scrollFocusedIntoView(index: number) {
    queueMicrotask(() => {
      const el = listRef.current?.querySelector(`[data-picker-index="${index}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    });
  }

  function handleInputKeydown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(focusedIndex + 1, filteredItems.length - 1);
      setFocusedIndex(next);
      scrollFocusedIntoView(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(focusedIndex - 1, 0);
      setFocusedIndex(next);
      scrollFocusedIntoView(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredItems[focusedIndex];
      if (selected) onSelect(selected);
    }
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="open-picker" onClick={handleBackdropClick} role="dialog" aria-modal="true" aria-label="Item picker">
      <div className="open-picker__panel">
        <div className="open-picker__input-row">
          <span className="open-picker__prompt">&gt;</span>
          <input
            ref={inputRef}
            type="text"
            className="open-picker__input"
            placeholder={placeholder}
            value={filterText}
            onChange={(e) => setFilterText(e.currentTarget.value)}
            onKeyDown={handleInputKeydown}
            aria-label={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-autocomplete="list"
          />
        </div>
        <div className="open-picker__list" ref={listRef} role="listbox">
          {filteredItems.length === 0 ? (
            <div className="open-picker__empty">No results</div>
          ) : (
            filteredItems.map((item, i) => (
              <div
                key={item.id}
                className={['open-picker__item', focusedIndex === i && 'open-picker__item--focused'].filter(Boolean).join(' ')}
                role="option"
                aria-selected={focusedIndex === i}
                data-picker-index={i}
                onClick={() => onSelect(item)}
                onMouseEnter={() => setFocusedIndex(i)}
                tabIndex={-1}
              >
                <span className="open-picker__cursor" aria-hidden="true">&gt;</span>
                <span className="open-picker__label">{item.label}</span>
                {item.hint ? <span className="open-picker__hint">{item.hint}</span> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default OpenPicker;
