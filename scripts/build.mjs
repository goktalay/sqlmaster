// Uygulamayı dist-app/ altına derler (esbuild).
//   main/preload/dbhost → Node (CommonJS), sürücü paketleri node_modules'ten yüklenir
//   renderer            → tarayıcı (IIFE); HTML/CSS kopyalanır
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-app');
const watch = process.argv.includes('--watch');

const external = ['electron', 'pg', 'pg-cursor', 'pg-native', 'mssql', 'tedious', 'mysql2', '@duckdb/node-api', 'ssh2', 'cpu-features'];

const node = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: 'linked', external, logLevel: 'info',
  entryPoints: {
    'main/main': 'src/main/main.ts',
    'preload/preload': 'src/preload/preload.ts',
    'dbhost/host': 'src/dbhost/host.ts',
  },
  outdir: out,
};

const web = {
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', sourcemap: 'linked', logLevel: 'info',
  entryPoints: {
    'renderer/main/app': 'src/renderer/main/app.ts',
    'renderer/login/login': 'src/renderer/login/login.ts',
    'renderer/conn/conn': 'src/renderer/conn/conn.ts',
  },
  outdir: out,
};

function copyStatic() {
  const copy = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) copy(s, d);
      else if (/\.(html|css|svg|png)$/.test(e.name)) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(s, d); }
    }
  };
  copy(path.join(root, 'src', 'renderer'), path.join(out, 'renderer'));
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(out, 'assets', 'icon.png'));
}

fs.rmSync(out, { recursive: true, force: true });
if (watch) {
  const a = await esbuild.context(node);
  const b = await esbuild.context(web);
  copyStatic();
  await Promise.all([a.watch(), b.watch()]);
} else {
  await Promise.all([esbuild.build(node), esbuild.build(web)]);
  copyStatic();
}
