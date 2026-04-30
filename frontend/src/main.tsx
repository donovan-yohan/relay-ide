import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import WorkspaceLayoutDemo from './components/WorkspaceLayoutDemo';
import './App.css';

const isWorkspaceDemo =
  new URLSearchParams(window.location.search).get('workspaceDemo') === '1';

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    {isWorkspaceDemo ? <WorkspaceLayoutDemo /> : <App />}
  </React.StrictMode>
);
