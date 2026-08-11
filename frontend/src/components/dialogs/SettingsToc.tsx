import React from 'react';
import './SettingsToc.css';

interface Section {
  id: string;
  label: string;
  children?: Array<{ id: string; label: string }>;
}

interface Props {
  sections: Section[];
  /** The explicit Settings content scroll owner. Do not use scrollIntoView:
   * it may mutate clipping-only modal ancestors as well as this pane. */
  sectionsEl?: HTMLElement;
  open: boolean;
  onclose: () => void;
}

function scrollSectionIntoView(container: HTMLElement, section: HTMLElement) {
  const top =
    section.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

export default function SettingsToc({
  sections,
  sectionsEl,
  open,
  onclose,
}: Props) {
  function scrollToSection(id: string) {
    const section = sectionsEl?.querySelector<HTMLElement>(`#${id}`);
    if (section && sectionsEl) {
      scrollSectionIntoView(sectionsEl, section);
    }
    onclose();
  }

  return (
    <>
      {open && <div className="toc-backdrop" onClick={onclose} />}
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
