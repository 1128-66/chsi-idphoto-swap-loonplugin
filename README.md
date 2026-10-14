# 学信网证件照换图 · Loon 纯 iPhone 插件

> 把学信网 App「大学生图像信息采集」的现场拍照上传，替换为本机选定的证件照。
> 全程只需一台 iPhone，无需电脑配合。

姊妹仓库：[chsi-idphoto-swap](https://github.com/1128-66/chsi-idphoto-swap)（Mac + mitmproxy + WireGuard 方案，含完整逆向分析）

---

## ⚠️ 免责声明

本项目仅供**学习与技术研究**（HTTPS MITM 原理、multipart 表单解析、Loon 脚本能力探索）。
请自行确认图像采集的相关合规要求，使用本项目产生的一切后果由使用者本人承担。

---

## 工作原理（一句话版）

App 把现场照片通过 OSS PostObject 直传；Loon 在请求发出前拦截该请求，
把 multipart 里 `name="file"` 的照片段替换为预先注入的本机证件照，其余字段（签名/policy 等）逐字节保留，
Content-Length 显式重算。**替换条件不满足时直接掐断请求（fail-closed），原图不会流出。**

详细分析见 [实现指南.md](实现指南.md)。

---

## 使用前提

- 一台 iPhone（iOS 15+）
- [Loon](https://apps.apple.com/app/loon/id1373569448)（需非中国区 Apple ID 下载，付费 App）

## 快速开始

### 第 1 步 · 安装 Loon

从 App Store 安装并打开，首次启动授予 VPN 权限。

> <img width="300" alt="IMG_3257" src="https://github.com/user-attachments/assets/de96e0d6-2881-4479-8df3-752876644dad" />

### 第 2 步 · 生成并信任 MITM 证书（一次性）

1. Loon → **配置** → **MITM** → **生成证书** → **安装证书**（会跳到 Safari 描述文件下载）
2. 系统设置 → **已下载的描述文件** → 安装
3. 系统设置 → **通用** → **关于本机** → **证书信任设置** → 把 Loon 根证书打开**完全信任**

><img width="300" alt="IMG_3256" src="https://github.com/user-attachments/assets/8c41b40d-4761-4b11-bc22-ae64a5d561f2" />

### 第 3 步 · 导入插件

复制下面的插件链接，在 Loon → **配置** → **插件** → 右上角 ➜ 粘贴导入：

```
https://raw.githubusercontent.com/1128-66/chsi-idphoto-swap-loonplugin/main/idphoto.plugin
```

国内网络拉不动 GitHub raw 时，用 jsDelivr 镜像（内容相同）：

```
https://cdn.jsdelivr.net/gh/1128-66/chsi-idphoto-swap-loonplugin@main/idphoto.plugin
```

> <img width="300" alt="IMG_3258" src="https://github.com/user-attachments/assets/6bfcd619-2a2c-46c7-b12c-2ae99afc8ed3" />


> **Loon 新版本提示**：新版 Loon 会提示"旧版语法"，用 App 内的语法转换器迁移即可，参数不变。

### 第 4 步 · 启动 Loon 并选好证件照

1. Loon 主页点**启动**
2. Safari 打开 `example.com/idphoto` —— 这是插件伪造的**本机选图页**，不是真实网站
3. 点 **选择照片（存本机）**，从相册选证件照，页面自动压缩到 1MB 内并存入手机
4. 看到「✅ 已存入本机：xxx B · MD5 …」即成功

> <img width="300" alt="IMG_3259" src="https://github.com/user-attachments/assets/0a4ea187-d60d-476e-90bb-13757c7ab2a9" />


两种注入方式：

| 按钮 | 行为 | 有效期 | 适用 |
|---|---|---|---|
| **选择照片（存本机）** | 照片只存进手机（$persistentStore），不出本机 | 长期，直到清除 | 日常主力 |
| **☁️ 云端直链上传（72 小时）** | 直传 litterbox 图床，脚本只拉一次直链 | 72 小时 | 临时换图 / 换机测试 |

### 第 5 步 · 实测采集

正常打开学信网 App 走图像采集流程，扫描人脸后点击使用原图确定，现场拍照上传的瞬间会被替换：

- 通知栏弹「**已替换 ✅**」→ 上传的是你注入的证件照
- 通知栏弹「**🔒 服务端存的就是本地图**」→ ETag 与注入照片 MD5 一致，铁证
- 通知栏弹「**已掐断请求 ⛔**」→ 替换条件不满足（fail-closed），**原图未上传**，检查插件是否启用/照片是否已注入后重试

> <img width="300" alt="IMG_3255" src="https://github.com/user-attachments/assets/dbf8cd4e-db25-43de-bbe7-74793a0c5a17" />


---

## 换照片 / 清除

- **换照片**：重新打开 `example.com/idphoto` 再选一次即可，覆盖旧照片
- **清除**：选图页底部「清除已存照片」，回到未注入状态

## 常见问题

<details>
<summary>导入插件后没有反应？</summary>

确认 Loon 已**启动**（主页大按钮），且插件列表里本插件为**启用**状态。
</details>

<details>
<summary>采集时只弹「已掐断请求 ⛔」？</summary>

说明 fail-closed 生效、原图没泄出去。依次检查：① 是否已在选图页注入照片；② 插件里三个脚本是否启用；③ MITM 是否开启且包含 `chsi-idphotosrv.oss-cn-shanghai.aliyuncs.com`。
</details>

<details>
<summary>照片压缩后多大？会不会超限？</summary>

页面自动压缩到 OSS policy 的 1KB ~ 1MB 区间内，超限会被选图页直接拦下并提示，不会进入上传链路。
</details>

<details>
<summary>隐私：照片会传到别处吗？</summary>

「存本机」模式照片只存在你手机的 Loon 持久化存储里，不上传任何服务器；
「云端直链」模式会把照片传到 litterbox 图床（公开可访问、72 小时后自动删除），介意请用存本机模式。
</details>

## 安卓能不能用？

理论可行，方向与关键坑见 [安卓实现方向.md](安卓实现方向.md)——只提供思路，欢迎社区 PR。

## 技术文档

- [实现指南.md](实现指南.md)：MITM 拦截点、multipart 替换算法、MD5 校验链路、Loon/Surge 适配细节
- [chsi-idphoto-swap](https://github.com/1128-66/chsi-idphoto-swap)：Mac 端同源方案与完整抓包逆向记录
