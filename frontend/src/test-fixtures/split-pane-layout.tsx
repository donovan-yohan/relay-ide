import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SplitPaneLayout } from '../components/SplitPaneLayout.js';

function App() {
  const [mobileOpen, setMobileOpen] = useState(true);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <SplitPaneLayout
        fileViewerOpen
        rightSidebarCollapsed={false}
        rightSidebarWidth={220}
        fileViewerRatio={0.35}
        terminal={<div style={{ padding: 16 }}>terminal pane</div>}
        fileViewer={<div style={{ padding: 16 }}>file viewer pane</div>}
        rightSidebar={<div style={{ padding: 16 }}>right sidebar pane</div>}
      />
      <SplitPaneLayout
        fileViewerOpen={false}
        rightSidebarCollapsed
        terminal={<div style={{ padding: 16 }}>terminal only</div>}
      />
      <SplitPaneLayout
        fileViewerOpen
        rightSidebarCollapsed={false}
        rightSidebarMobileOpen={mobileOpen}
        onRightSidebarMobileClose={() => setMobileOpen(false)}
        rightSidebarWidth={220}
        fileViewerRatio={0.35}
        terminal={<div style={{ padding: 16 }}>terminal pane</div>}
        fileViewer={<div style={{ padding: 16 }}>file viewer pane</div>}
        rightSidebar={<div style={{ padding: 16 }}>right sidebar pane</div>}
      />
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
