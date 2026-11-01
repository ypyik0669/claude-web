// One import for "which section is in front": pulling the page stores in first makes sure they have registered
// before a component subscribes (features/sections/pages.ts).
import '@/features/automation/state';
import '@/features/background/state';
import '@/features/extensions/state';

export { closePages, currentSection, openPage, usePageOpen, useSection, type PageId, type Section } from './pages';
