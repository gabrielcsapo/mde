import { createRoot } from 'react-dom/client';

// Order matters, and it is the same order the hand-written page used. `theme.css` is
// the editor library's own stylesheet — unlayered, imported from `web/src` rather than
// copied — and unlayered CSS outranks every cascade layer Tailwind emits, so it
// survives Preflight intact. `site.css` has to come second so *its* unlayered editor
// rules at the bottom win against it on source order.
import '../../web/src/theme.css';
// The showcase extensions' own styling. After theme.css on purpose: a role class and a
// built-in class are both single-class selectors, so source order is what lets a focus
// dim actually dim a heading. See the note at the top of the file.
import '../../web/extensions/extensions.css';
import './site.css';

import App from './App.jsx';

// Deliberately not wrapped in <StrictMode>. The live editor is an imperative object
// that attaches a document-level `selectionchange` listener and has no teardown, so
// StrictMode's development double-mount would leave a second orphaned editor listening
// and would fetch the wasm core twice. The page has one imperative island; paying for
// it here is cheaper than pretending it is not there.
createRoot(document.getElementById('root')).render(<App />);
