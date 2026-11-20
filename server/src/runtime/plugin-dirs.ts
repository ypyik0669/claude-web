import { webMcpEnabled } from '../web/launcher.js';
import { cafePluginDir } from '../characters/tools.js';
import { asciiPluginDir } from '../themes/tools.js';
import { openingPluginDir } from '../openings/tools.js';
import { desktopSkillsPlugin } from './desktop-skills.js';

/**
 * The local plugins a Claude conversation is started with (`plugins: [{ type: 'local', path }]`): 网吧's cafe-character,
 * the ascii-theme and the opening-pack skills while the `web` server that answers their tools is handed out, and the
 * official app's download of Anthropic's skills (desktop-skills.ts). One list for the runner and the / menu's disk scan
 * (slash-disk.ts).
 */
export function localPluginDirs(): string[] {
  const web = webMcpEnabled();
  return [web ? cafePluginDir() : null, web ? asciiPluginDir() : null, web ? openingPluginDir() : null, desktopSkillsPlugin()].filter((d): d is string => !!d);
}
