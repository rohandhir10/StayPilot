import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        login: resolve(rootDir, 'login.html'),
        inquiry: resolve(rootDir, 'inquiry.html')
      }
    }
  }
});
