import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The editor's own theme, and the styling the two shipped extensions bring with them.
// They live in `web/src` and `web/extensions`; this package deliberately does not copy
// them. Import order matters — see the note at the top of extensions.css.
import '@mdink/web/theme.css';
import '@mdink/web/extensions.css';
import './app.css';

import App from './App.jsx';

// StrictMode on purpose: every effect runs twice, so a leaked editor or a duplicated
// `selectionchange` listener shows up here rather than in the user's app.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
