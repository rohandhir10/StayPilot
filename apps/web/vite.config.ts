import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [{
    name: 'staypilot-friendly-routes',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '/';
        if (url === '/login' || url.startsWith('/login?')) req.url = url.replace(/^\/login(?=\?|$)/, '/login.html');
        if (url === '/inquiry' || url.startsWith('/inquiry?')) req.url = url.replace(/^\/inquiry(?=\?|$)/, '/inquiry.html');
        next();
      });
    }
  }],
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
