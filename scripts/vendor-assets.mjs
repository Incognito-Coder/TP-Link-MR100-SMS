import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free');
const destination = path.join(root, 'public', 'vendor', 'fontawesome');
const files = [
  'css/fontawesome.min.css', 'css/solid.min.css', 'css/regular.min.css',
  'webfonts/fa-solid-900.woff2', 'webfonts/fa-solid-900.ttf',
  'webfonts/fa-regular-400.woff2', 'webfonts/fa-regular-400.ttf',
  'LICENSE.txt',
];

export async function vendorAssets() {
  for (const file of files) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, file), target);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await vendorAssets();
  console.log('Copied Font Awesome CSS, fonts, and license into public/vendor.');
}
