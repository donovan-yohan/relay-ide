import React from 'react';
import './SettingsToc.css';

interface Section {
  id: string;
  label: string;
  children?: Array<{ id: string; label: string }>;
}

interface Props {
  sections: Section[];
  contentEl?: HTMLElement;
  open: boolean;
  onclose: () => void;
}

export default function SettingsToc({ sections, contentEl, open, onclose }: Props) {
  function scrollToSection(id: string) {
    const el = contentEl?.querySelector(`#${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
    onclose();
  }

  return (
    <>
      {open && (
        <div className="toc-backdrop" onClick={onclose} />
      )}
      <nav
        className={['toc-drawer', open ? 'open' : ''].filter(Boolean).join(' ')}
        aria-label="Settings navigation"
      >
        <div className="toc-items">
          {sections.map((section) => (
            <React.Fragment key={section.id}>
              <button
                className="toc-item"
                onClick={() => scrollToSection(section.id)}
              >
                {section.label}
              </button>
              {section.children?.map((child) => (
                <button
                  key={child.id}
                  className="toc-item toc-child"
                  onClick={() => scrollToSection(child.id)}
                >
                  {child.label}
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
      </nav>
    </>
  );
}
