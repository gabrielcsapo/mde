import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const web = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    // Both packages are linked from the local pnpm workspace while this example is developed.
    fs: { allow: [web] },
  },
});
