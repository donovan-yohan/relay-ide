import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MobileHeader from '../components/MobileHeader.js';

function VisibleHeader() {
  const [menuCount, setMenuCount] = useState(0);
  const [commandCount, setCommandCount] = useState(0);
  const [filesCount, setFilesCount] = useState(0);

  return (
    <MobileHeader
      title="Active Session"
      onMenuClick={() => {
        setMenuCount((c) => c + 1);
        document.getElementById('menu-count')!.textContent = `menu: ${menuCount + 1}`;
      }}
      onRightSidebarClick={() => {
        setFilesCount((c) => c + 1);
        document.getElementById('files-count')!.textContent = `files: ${filesCount + 1}`;
      }}
      onCommandClick={() => {
        setCommandCount((c) => c + 1);
        document.getElementById('command-count')!.textContent = `command: ${commandCount + 1}`;
      }}
    />
  );
}

const visibleRoot = createRoot(document.getElementById('visible-container')!);
visibleRoot.render(<VisibleHeader />);

const hiddenRoot = createRoot(document.getElementById('hidden-container')!);
hiddenRoot.render(
  <MobileHeader
    title="Hidden"
    onMenuClick={() => {}}
    onCommandClick={() => {}}
    hidden
  />
);
