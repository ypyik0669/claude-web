// One import for "which section is in front": pulling the page stores in first makes sure they have registered
// before a component subscribes (features/sections/pages.ts).
import '@/features/automation/state';
import '@/features/background/state';
import '@/features/bots/state';
import '@/features/extensions/state';
import '@/features/gateway/state';

export { closePages, currentSection, openPage, usePageOpen, useSection, type PageId, type Section } from './pages';
