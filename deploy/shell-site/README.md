# 手机页面的站点

手机扫「在哪都能用」二维码打开的页面（源码 `web/src/shell/`，构建产物 `web/dist-shell/`）放在一个只给它用的 GitHub 组织的网站上：`https://<组织>.github.io/`，在网站根目录。

为什么单独一个组织：一个账号（或组织）的所有 GitHub Pages 共用 `<名字>.github.io` 这一个网站源（origin）。手机页面在浏览器里存着设备令牌（IndexedDB）、界面缓存和 Service Worker，和别的页面放在一个源下就会混在一起。专门的组织只有这一个站点，没有别的页面和它共用。

这个目录里的 `.github/workflows/deploy.yml` 是给那个站点仓库用的，在本仓库里不会运行。它：

- 按发布的 tag 拉公开的 `ypyik0669/claude-web`，`npm ci --ignore-scripts` 后 `npm run build:shell -w web`，用 GitHub Pages 发布 `web/dist-shell`；
- 手动运行时可以填 tag（留空 = 最新的正式发布），每天还会自动检查一次有没有新发布；
- 线上的 `version.txt` 已经是这个 tag 就跳过，不重复发布（手动运行时可以勾「force」强制发布）；
- 不需要任何令牌或密钥。

本仓库自己的 `.github/workflows/pages.yml` 只在打 tag 时构建同一份页面、上传成 artifact，用来确认它能构建，不发布。

## 一次性步骤

1. 在 GitHub 上新建一个组织（免费版就够），下面记作 `<组织>`。只放这个站点，成员越少越好，都开两步验证：谁能往站点仓库推代码，谁就能换掉手机页面、偷到手机上的设备令牌。
2. 在组织里新建公开仓库 `<组织>.github.io`。
3. 把这里的 `.github/workflows/deploy.yml` 原样复制到那个仓库的 `.github/workflows/deploy.yml`，提交。
4. 那个仓库的 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
5. **Actions → Deploy the phone page → Run workflow** 运行一次（tag 留空 = 最新的正式发布）。只有带 `build:shell` 的发布才能构建（手机页面是在那之后加的），更早的 tag 会在构建这一步失败。
6. 打开 `https://<组织>.github.io/`，能看到「你的电脑」页面就好了。然后把 `server/src/remote/anywhere/service.ts` 的 `DEFAULT_SHELL_URL` 改成这个地址（标着 `TODO(org)` 的那一行），跟下一个版本发布。在那之前，用户可以在 **设置 → 手机与其它电脑 → 更多选项 → 手机页面地址** 里手动填。

已经配对的手机继续用它们配对时的那个页面地址；改了缺省地址之后，新配对的手机才用新的。
