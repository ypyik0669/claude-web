import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactTypesRoot, listArtifactTypes, readArtifactType, skillFrontMatter } from './artifact-types.js';

describe('自定义 › Artifact 类型: the folders in ~/.agents/artifact-types', () => {
  it('the user type root sits under the home folder', () => {
    expect(artifactTypesRoot('/h')).toBe(path.join('/h', '.agents', 'artifact-types'));
  });

  it('no root folder: nothing listed, and it says the folder is not there (no built-in list)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-atypes-'));
    const root = path.join(dir, 'missing');
    expect(listArtifactTypes(root)).toEqual({ root, exists: false, types: [] });
  });

  it('a manifest, a SKILL.md and an index.html each make a type; other folders, files and dot folders do not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-atypes-'));
    const mk = (name: string, file?: string, text = '') => {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      if (file) fs.writeFileSync(path.join(root, name, file), text);
    };
    mk('poster', 'artifact-type.json', JSON.stringify({ title: '品牌海报', summary: 'A poster', version: '1.2.0' }));
    mk('broken', 'artifact-type.json', '{ not json');
    mk('deck', 'SKILL.md', '---\nname: "Pitch deck"\ndescription: Slides for a pitch\n---\n# body');
    mk('frame', 'index.html', '<!doctype html>');
    mk('empty');
    mk('.hidden', 'artifact-type.json', '{}');
    fs.writeFileSync(path.join(root, 'loose.json'), '{}');

    const out = listArtifactTypes(root);
    expect(out.exists).toBe(true);
    expect(out.types.map((t) => [t.id, t.name, t.format])).toEqual([
      ['broken', 'broken', 'manifest'], // a broken manifest still names the folder
      ['deck', 'Pitch deck', 'skill'],
      ['frame', 'frame', 'frame'],
      ['poster', '品牌海报', 'manifest'],
    ]);
    const poster = out.types.find((t) => t.id === 'poster')!;
    expect(poster).toMatchObject({ summary: 'A poster', version: '1.2.0', path: path.join(root, 'poster') });
    expect(out.types.find((t) => t.id === 'deck')!.summary).toBe('Slides for a pitch');
    expect(readArtifactType(path.join(root, 'empty'))).toBeUndefined();
  });

  it('front matter: only name and description, quotes taken off; no block → nothing', () => {
    expect(skillFrontMatter("---\r\nname: 'x'\r\nother: y\r\ndescription: d\r\n---\r\n")).toEqual({ name: 'x', description: 'd' });
    expect(skillFrontMatter('# no front matter')).toEqual({});
  });
});
