import { cp, mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let electronRoot;
try { electronRoot = dirname(require.resolve('electron/package.json')); }
catch { if (!process.env.MIRA_ELECTRON_DIR) throw new Error('Run npm ci first, or set MIRA_ELECTRON_DIR to an installed Electron package directory.'); electronRoot = process.env.MIRA_ELECTRON_DIR; }
await access(join(electronRoot, 'dist/electron.exe'));
const pkg = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'));
const out = join(root, 'releases', 'NoteMark-Windows');
await mkdir(out, { recursive: true });
await cp(join(electronRoot, 'dist'), out, { recursive: true });
try { await rename(join(out, 'electron.exe'), join(out, 'NoteMark.exe')); } catch (e) { throw new Error('Close NoteMark before rebuilding. ' + e.message); }
const app = join(out, 'resources/app'); await mkdir(app, { recursive: true });
for (const dir of ['web', 'desktop', 'server']) await cp(join(root, dir), join(app, dir), { recursive: true });
const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); delete info.devDependencies;
// The portable executable and the installer payload share the same branded PE resources.
const { editWindowsResources } = require('app-builder-lib/out/util/resEdit.js');
await editWindowsResources({ file: join(out, 'NoteMark.exe'), iconPath: join(root, 'web/icon.ico'),
  versionStrings: { FileDescription: 'NoteMark', ProductName: 'NoteMark', InternalName: 'NoteMark', OriginalFilename: 'NoteMark.exe' },
  fileVersion: info.version, productVersion: info.version + '.0' });
await writeFile(join(app, 'package.json'), JSON.stringify(info, null, 2));
await writeFile(join(out, 'START-HERE.txt'), `NoteMark ${info.version}\r\n\r\nRun NoteMark.exe. Keep every file in this folder together.\r\nFor Android + Windows pairing and internet sync, see the included QUICK-START.md.\r\n`);
for (const name of ['QUICK-START.md', 'README.md', 'VERIFICATION.md']) { try { await cp(join(root, name), join(out, name)); } catch {} }
await writeFile(join(root, 'releases', 'windows-build.json'), JSON.stringify({ builtAt: new Date().toISOString(), electronVersion: pkg.version, source: electronRoot, executable: join(out, 'NoteMark.exe'), signed: false }, null, 2));
console.log(`Built ${out} with Electron ${pkg.version}. No signing certificate configured.`);
