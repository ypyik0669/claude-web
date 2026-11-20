// 自定义 › Artifact 类型 (界面改版 2026-11 阶段 2, spec #pages 「自定义」 notes 1 / 5): the types the user put in
// ~/.agents/artifact-types — open-artifact's user type root, where a folder is one type. This round only lists them
// (open-artifact is not wired in yet): a folder with an `artifact-type.json` reads its name / summary / version from
// it, one with a SKILL.md its front matter, an `index.html` is claude.ai's own format. Nothing here runs, installs or
// writes anything; there is no built-in list (that comes with open-artifact).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactTypeInfo } from '../protocol.js';

/** The user type root open-artifact reads (its research notes: project root, user root, extra roots, built-in). */
export function artifactTypesRoot(home = os.homedir()): string {
  return path.join(home, '.agents', 'artifact-types');
}

const MAX_TYPES = 200;
const MAX_JSON = 256 * 1024;

const str = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** `name:` / `description:` of a SKILL.md's front matter (the `---` block on top), nothing else. */
export function skillFrontMatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2].replace(/^["']|["']$/g, '').trim() || undefined;
  }
  return out;
}

function readSmall(p: string): string | undefined {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_JSON) return undefined;
    return fs.readFileSync(p, 'utf8');
  } catch { return undefined; }
}

/** One folder as a type, or undefined when it holds nothing a type has. */
export function readArtifactType(dir: string): ArtifactTypeInfo | undefined {
  const id = path.basename(dir);
  const manifest = readSmall(path.join(dir, 'artifact-type.json'));
  if (manifest !== undefined) {
    let j: Record<string, unknown> = {};
    try { const v = JSON.parse(manifest); if (v && typeof v === 'object' && !Array.isArray(v)) j = v; } catch { /* a broken manifest still names the folder */ }
    return {
      id,
      name: str(j.title, 80) ?? str(j.name, 80) ?? id,
      summary: str(j.summary) ?? str(j.description),
      version: str(j.version, 40),
      path: dir,
      format: 'manifest',
    };
  }
  const skill = readSmall(path.join(dir, 'SKILL.md'));
  if (skill !== undefined) {
    const fm = skillFrontMatter(skill);
    return { id, name: str(fm.name, 80) ?? id, summary: str(fm.description), path: dir, format: 'skill' };
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) return { id, name: id, path: dir, format: 'frame' };
  return undefined;
}

/** Every type folder under `root`, by name; `exists` says whether the root is there at all. */
export function listArtifactTypes(root = artifactTypesRoot()): { root: string; exists: boolean; types: ArtifactTypeInfo[] } {
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return { root, exists: false, types: [] }; }
  const types: ArtifactTypeInfo[] = [];
  for (const d of names.filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (types.length >= MAX_TYPES) break;
    const t = readArtifactType(path.join(root, d.name));
    if (t) types.push(t);
  }
  return { root, exists: true, types };
}
