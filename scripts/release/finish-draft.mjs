// The release workflow's last job (release.yml `finish`), on GitHub's side of the line: from the build jobs'
// artifacts, one latest-mac.yml listing BOTH architectures' zip + dmg (each mac job uploads its own to the draft and
// the later one replaces the other — a Mac whose architecture is missing falls back to a manual download), and the
// release notes = the English CHANGELOG section of the version.
//   node scripts/release/finish-draft.mjs <artifactsDir> <version>   → ./latest-mac.yml, ./notes.md
// Before 2026-11-17 this was done on the author's machine: three drafts (one per job) whose installers had to be
// downloaded and uploaded again over a slow line — two hours for 0.5.12. release.yml now creates the draft first.
import fs from 'node:fs';
import path from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !version) { console.error('usage: finish-draft.mjs <artifactsDir> <version>'); process.exit(2); }

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'latest-mac.yml' ? [path.join(d, e.name)] : []));

/** `- url / sha512 / size` entries of electron-builder's update files, by url (the later file wins on a repeat). */
export function macFiles(ymls) {
  const by = new Map();
  for (const s of ymls) for (const m of s.matchAll(/- url: (\S+)\r?\n\s+sha512: (\S+)\r?\n\s+size: (\d+)/g)) by.set(m[1], { url: m[1], sha512: m[2], size: Number(m[3]) });
  return [...by.values()];
}

const ymls = walk(dir).map((f) => fs.readFileSync(f, 'utf8'));
const files = macFiles(ymls).filter((f) => f.url.includes(`-${version}-`));
const order = ['mac-x64.zip', 'mac-x64.dmg', 'mac-arm64.zip', 'mac-arm64.dmg'];
files.sort((a, b) => order.findIndex((o) => a.url.endsWith(o)) - order.findIndex((o) => b.url.endsWith(o)));
const zips = files.filter((f) => f.url.endsWith('.zip'));
if (zips.length < 2) { console.error(`latest-mac.yml: ${zips.length} zip(s) for ${version} in ${ymls.length} file(s) — want both architectures`); process.exit(1); }
const yml = `version: ${version}\nfiles:\n${files.map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: ${f.size}\n`).join('')}path: ${zips[0].url}\nsha512: ${zips[0].sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
fs.writeFileSync('latest-mac.yml', yml);

const log = fs.readFileSync('CHANGELOG.md', 'utf8');
const at = log.indexOf(`## [${version}]`);
if (at < 0) { console.error(`CHANGELOG.md has no section for ${version}`); process.exit(1); }
const rest = log.slice(at).split('\n').slice(1);
const end = rest.findIndex((l) => l.startsWith('## ['));
fs.writeFileSync('notes.md', `${rest.slice(0, end < 0 ? undefined : end).join('\n').trim()}\n`);
console.log(yml);
