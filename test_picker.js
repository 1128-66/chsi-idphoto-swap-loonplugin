/**
 * Node 测试：本机选图页脚本（idphoto-picker.js）
 * 运行：node test_picker.js
 */
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const { md5Hex, b64ToBytes, parseSetBody, bytesToText, PAGE_HTML } =
  require("./idphoto-picker.js");

let pass = 0;
function t(name, fn) { fn(); pass++; console.log("  ✓ " + name); }

// ---- 1. MD5 对拍（含全部填充边界长度）----
t("md5Hex 与 crypto 对拍：边界长度 0/1/55/56/63/64/65/128/129 B", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 128, 129]) {
    const data = crypto.randomBytes(len);
    assert.strictEqual(md5Hex(new Uint8Array(data)),
                       crypto.createHash("md5").update(data).digest("hex"),
                       "len=" + len + " 不一致");
  }
});

t("md5Hex 与 crypto 对拍：200KB 随机数据（模拟压缩后照片）", () => {
  const data = crypto.randomBytes(200000);
  assert.strictEqual(md5Hex(new Uint8Array(data)),
                     crypto.createHash("md5").update(data).digest("hex"));
});

t("md5Hex 已知向量：md5('abc') = 900150983cd24fb0d6963f7d28e17f72", () => {
  assert.strictEqual(md5Hex(new Uint8Array(Buffer.from("abc"))),
                     "900150983cd24fb0d6963f7d28e17f72");
});

// ---- 2. Base64 往返 ----
t("b64ToBytes 往返一致", () => {
  const data = crypto.randomBytes(96785);
  const mine = b64ToBytes(data.toString("base64"));
  assert.strictEqual(Buffer.from(mine).toString("hex"), data.toString("hex"));
});

// ---- 3. 选图页 POST 载荷解析 ----
t("parseSetBody：合法载荷 / 缺 b64 报错 / 非 JSON 报错", () => {
  const p = parseSetBody(JSON.stringify({ b64: "AAAA", size: 3, name: "photo.jpg" }));
  assert.strictEqual(p.name, "photo.jpg");
  assert.throws(() => parseSetBody(JSON.stringify({ size: 3 })));
  assert.throws(() => parseSetBody("garbage"));
});

// ---- 4. bytesToText（UTF-8 还原，page 名可能带中文）----
t("bytesToText 处理 UTF-8（含中文文件名）", () => {
  const raw = Buffer.from(JSON.stringify({ b64: "AAAA", name: "证件照.jpg" }), "utf8");
  const text = bytesToText(new Uint8Array(raw));
  assert.strictEqual(JSON.parse(text).name, "证件照.jpg");
});

// ---- 5. 选图页 HTML 自检 ----
t("PAGE_HTML：含表单/上传端点/清除端点/白名单外部资源", () => {
  assert.ok(PAGE_HTML.includes('type="file"'), "没有文件选择器");
  assert.ok(PAGE_HTML.includes('"/idphoto-set"'), "没有上传端点");
  assert.ok(PAGE_HTML.includes('"/idphoto-get"'), "没有查询端点");
  assert.ok(PAGE_HTML.includes('"/idphoto-clear"'), "没有清除端点");
  assert.ok(PAGE_HTML.includes('"/idphoto-md5"'), "没有校验端点");
  assert.ok(PAGE_HTML.includes('"/idphoto-seturl"'), "没有直链端点");
  assert.ok(PAGE_HTML.includes('litterbox.catbox.moe'), "没有图床上传域名");
  // 外部资源白名单：example.com（本机）+ api.github.com（云端直推）+ litterbox/litter.catbox.moe（图床）
  const WHITELIST = ["example\\.com", "api\\.github\\.com", "litterbox\\.catbox\\.moe", "litter\\.catbox\\.moe"];
  let cleaned = PAGE_HTML;
  for (const w of WHITELIST) cleaned = cleaned.replace(new RegExp("https?://" + w, "g"), "");
  assert.ok(!/https?:\/\//.test(cleaned), "页面引用了白名单外的外部资源");
  // 无嵌套 </script> 破坏结构
  assert.strictEqual(PAGE_HTML.split("<script").length, 2, "script 标签数量异常");
  assert.ok(PAGE_HTML.trimEnd().endsWith("</body></html>"));
});

// ---- 6. 端到端模拟：页面压缩图 → set 载荷 → md5 落库值 = 服务端未来 ETag 期望 ----
t("端到端：页面载荷 → b64 → MD5（模拟 12MP→96KB 流程的最终一致）", () => {
  const photo = crypto.randomBytes(96785);
  const b64 = photo.toString("base64");
  const p = parseSetBody(JSON.stringify({ b64: b64, size: photo.length, name: "img.heic" }));
  const decoded = b64ToBytes(p.b64);
  assert.strictEqual(md5Hex(decoded),
                     crypto.createHash("md5").update(photo).digest("hex"));
  assert.ok(decoded.length >= 1024 && decoded.length <= 1048576);
});

console.log("\n✅ 全部 " + pass + " 组测试通过");
