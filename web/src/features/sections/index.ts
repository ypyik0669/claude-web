// One import for "which section is in front": pulling the page stores in first makes sure they have registered
// before a component subscribes (features/sections/pages.ts). The automation family registers its pages' frame
// (sections/frame.ts) on import too.
import '@/features/automation/state';
import '@/features/background/state';
import '@/features/bots/state';
import '@/features/extensions/state';
import '@/features/gateway/state';
// the model hub took over the section id `gateway` from the old 上游 page: registered after it, it is the one
import '@/features/model-hub/state';
import '@/features/artifacts/state';
import '@/features/automation/family';

export { closePages, currentSection, openPage, usePageOpen, useSection, type PageId, type Section } from './pages';
