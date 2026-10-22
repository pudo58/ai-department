import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, readTheme } from './ui';
// Self-hosted fonts (bundled into dist, so the app stays offline-capable). Both ship a Vietnamese subset.
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './styles.css';

// Apply the saved theme before React renders, so there is no flash of the wrong palette.
applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
