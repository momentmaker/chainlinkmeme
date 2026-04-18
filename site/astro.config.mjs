import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';

const memesDir = path.resolve('../memes');

const serveMemesInDev = {
  name: 'serve-memes-in-dev',
  hooks: {
    'astro:config:setup': ({ updateConfig }) => {
      updateConfig({
        vite: {
          plugins: [
            {
              name: 'chainlinkmeme:memes-dev-middleware',
              configureServer(server) {
                server.middlewares.use('/memes', (req, res, next) => {
                  const url = (req.url ?? '/').split('?')[0];
                  const filePath = path.join(memesDir, decodeURIComponent(url));
                  if (!filePath.startsWith(memesDir)) { res.statusCode = 403; res.end(); return; }
                  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { next(); return; }
                  const ext = path.extname(filePath).toLowerCase();
                  const mime =
                    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                    ext === '.png' ? 'image/png' :
                    ext === '.gif' ? 'image/gif' :
                    ext === '.webp' ? 'image/webp' :
                    'application/octet-stream';
                  res.setHeader('Content-Type', mime);
                  res.setHeader('Cache-Control', 'public, max-age=60');
                  fs.createReadStream(filePath).pipe(res);
                });
              },
            },
          ],
        },
      });
    },
  },
};

export default defineConfig({
  site: 'https://chainlinkme.me',
  output: 'static',
  integrations: [react(), sitemap(), serveMemesInDev],
  build: {
    assets: '_astro',
  },
  vite: {
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
  },
});
