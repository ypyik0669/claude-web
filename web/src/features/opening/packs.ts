// 开场动画包 as the server lists them (openings.list), loaded once and again whenever one is added / removed in any
// window (`openings.changed`). The backdrop needs the chosen pack's loop, the settings page every card.
import { create } from 'zustand';
import type { OpeningInfo } from '@shared';
import { ws } from '@/ws/client';

interface PacksState {
  /** null: not asked yet / an older server */
  list: OpeningInfo[] | null;
  load(): Promise<void>;
}

let listening = false;

export const useOpeningPacks = create<PacksState>((set) => ({
  list: null,
  async load() {
    if (!listening) {
      listening = true;
      ws.on((e) => { if (e.kind === 'openings.changed') void useOpeningPacks.getState().load(); });
    }
    try {
      const list = await ws.request<OpeningInfo[]>({ kind: 'openings.list' });
      set({ list: Array.isArray(list) ? list : [] });
    } catch {
      // an older server has no packs: the backdrop falls back to 火星, the settings show 点火
      set({ list: [] });
    }
  },
}));
