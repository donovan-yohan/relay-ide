import './FilterChipBar.css';

export interface FilterChip {
  id: string;
  label: string;
  count?: number;
}

export interface FilterChipBarProps {
  chips: FilterChip[];
  activeChips: string[];
  onToggle: (id: string) => void;
  onClearAll?: () => void;
  searchQuery?: string;
  onSearch?: (query: string) => void;
}

export function FilterChipBar({
  chips,
  activeChips,
  onToggle,
  onClearAll,
  searchQuery = '',
  onSearch,
}: FilterChipBarProps) {
  const hasActiveFilters = activeChips.length > 0 || searchQuery.length > 0;

  return (
    <div className="filter-chip-bar" role="group" aria-label="Filters">
      <div className="chip-row">
        {chips.map((chip) => {
          const isActive = activeChips.includes(chip.id);

          return (
            <button
              key={chip.id}
              className={`filter-chip${isActive ? ' active' : ''}`}
              type="button"
              onClick={() => onToggle(chip.id)}
              aria-pressed={isActive}
            >
              {chip.label}
              {chip.count !== undefined ? <span className="chip-count">{chip.count}</span> : null}
            </button>
          );
        })}

        {hasActiveFilters && onClearAll ? (
          <button className="filter-chip clear-chip" type="button" onClick={onClearAll}>
            Clear
          </button>
        ) : null}
      </div>

      {onSearch ? (
        <input
          type="text"
          className="filter-search"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => onSearch(e.currentTarget.value)}
          aria-label="Search within filtered results"
        />
      ) : null}
    </div>
  );
}

export default FilterChipBar;
