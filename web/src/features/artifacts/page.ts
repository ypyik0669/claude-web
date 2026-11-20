// The Artifacts page (redesign 2026-11 stage 1): a first, simple version — what Claude wrote in the recent
// conversations here (pages, documents, pictures, data still on disk, `artifacts.list`), one card each. The real
// Artifacts library is a later release. Pure — ArtifactsPage.tsx draws it, state.ts opens / closes it.
import type { ArtifactRef } from '@shared';
import type { IconName } from '@/ui/icons';
import { tr, trAs } from '@/i18n';

/** The page's title — the same word in both languages (the plan: 中文也叫 Artifacts). Set in the heading face. */
export const ARTIFACTS_TITLE = 'Artifacts';
export const ARTIFACTS_DESC = tr('Claude 在最近的对话里做出来的网页、文档、图片和数据');

export type ArtifactKind = 'page' | 'doc' | 'image' | 'data' | 'pdf' | 'other';

const EXT: Record<string, ArtifactKind> = {
  html: 'page', htm: 'page', svg: 'image',
  md: 'doc', markdown: 'doc', txt: 'doc', rst: 'doc', docx: 'doc', rtf: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image',
  csv: 'data', tsv: 'data', json: 'data', xlsx: 'data', xls: 'data', yaml: 'data', yml: 'data',
  pdf: 'pdf',
};

/** What kind of thing a file is, by its extension. */
export function artifactKind(path: string): ArtifactKind {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && EXT[m[1].toLowerCase()]) || 'other';
}

export const KIND_INFO: Record<ArtifactKind, { label: string; icon: IconName }> = {
  page: { label: trAs('网页', 'Pages'), icon: 'web' },
  doc: { label: tr('文档'), icon: 'read' },
  image: { label: trAs('图片', 'Images'), icon: 'image' },
  data: { label: tr('数据'), icon: 'database' },
  pdf: { label: 'PDF', icon: 'read' },
  other: { label: tr('其它文件'), icon: 'artifact' },
};

/** The page's filter row: everything, or one kind (only kinds that are there are offered). */
export type ArtifactFilter = 'all' | ArtifactKind;

export function kindsOf(items: ArtifactRef[]): ArtifactKind[] {
  const order: ArtifactKind[] = ['page', 'doc', 'image', 'data', 'pdf', 'other'];
  const have = new Set(items.map((a) => artifactKind(a.path)));
  return order.filter((k) => have.has(k));
}

export function filterArtifacts(items: ArtifactRef[], f: ArtifactFilter, query = ''): ArtifactRef[] {
  const q = query.trim().toLowerCase();
  return items.filter((a) => (f === 'all' || artifactKind(a.path) === f) && (!q || a.path.toLowerCase().includes(q) || (a.title ?? '').toLowerCase().includes(q)));
}

/**
 * The kinds the Artifacts page lists (server/src/library/artifacts.ts KINDS — keep the two together): a written file
 * worth looking at again, not source code.
 */
const ARTIFACT_EXTS = new Set(['html', 'htm', 'md', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'csv']);
export function isArtifactPath(p: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return !!m && ARTIFACT_EXTS.has(m[1].toLowerCase());
}
