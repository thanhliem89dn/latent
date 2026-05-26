import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Display serif. Loading 400/500 roman and 400 italic; that's all we need.
import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/500.css';
import '@fontsource/newsreader/400-italic.css';

// Mono for metadata, slider labels, frame numbers, edge codes.
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import { App } from './App';
import './App.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
