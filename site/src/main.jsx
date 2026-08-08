import { createRoot } from 'react-dom/client';

// Order matters, and it is the same order the hand-written page used. `theme.css` is
// the editor library's own stylesheet — unlayered, imported from `web/src` rather than
// copied — and unlayered CSS outranks every cascade layer Tailwind emits, so it
// survives Preflight intact. `site.css` has to come second so *its* unlayered editor
// rules at the bottom win against it on source order.
import '@mde/web/theme.css';
// The showcase extensions' own styling. After theme.css on purpose: a role class and a
// built-in class are both single-class selectors, so source order is what lets a focus
// dim actually dim a heading. See the note at the top of the file.
import '@mde/web/extensions.css';
import './site.css';

import App from './App.jsx';

// Deliberately not wrapped in <StrictMode>. The live demo's slow reference resolver can
// outlive a route, so its engine remains allocated until those promises settle; a
// development-only double mount would intentionally build and fetch that island twice.
// The editor itself still tears down every listener on unmount.
createRoot(document.getElementById('root')).render(<App />);
