// The settings' ways into the model board (模型看板, features/model-hub): 设置 › 模型 opens it full-page with 「打开看板」
// (spec #pages 「设置弹窗」 note 1), 设置 › 隐私与密钥 on its 隐私 page. The settings dialog closes first — the board is a
// page over the main area, not something inside the dialog.
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { openHub } from '@/features/model-hub/state';
import type { HubPageId } from '@/features/model-hub/page';
import { tr } from '@/i18n';

function go(page?: HubPageId) {
  useStore.setState({ settingsOpen: null });
  openHub(page);
}

/** 设置 › 模型, on every tab: the live board of sources, accounts, routing and usage, one click away. */
export function ModelHubLink() {
  return (
    <div className="sp-hub-link" data-act="open-hub">
      <Icon name="gateway" size={16} />
      <span className="t">{tr('账号额度、每一轮去了哪个模型、用量和费用，在模型看板里看')}</span>
      <button className="btn sm" onClick={() => go()}>{tr('打开看板')}</button>
    </div>
  );
}

/** 设置 › 隐私与密钥: what vendors see and what stays here is the board's 隐私 page. */
export function PrivacyLink() {
  return (
    <div className="sp-hub-link" data-act="open-privacy">
      <Icon name="shield" size={16} />
      <span className="t">{tr('厂商能看到你的哪些东西、哪些只留在这台电脑上，还有请求记录，在模型看板的「隐私」里。')}</span>
      <button className="btn sm" onClick={() => go('privacy')}>{tr('打开隐私')}</button>
    </div>
  );
}
