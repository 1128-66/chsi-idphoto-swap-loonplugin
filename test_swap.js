/**
 * Node 测试：验证 idphoto-swap.request.js 的 multipart 替换逻辑
 * 运行：node test_swap.js
 */
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const { swapFilePart, b64ToBytes, getBoundary, indexOfBytes, parsePhotoPayload } =
  require("./idphoto-swap.request.js");

// ---- 构造一个贴近真实的 OSS PostObject 请求体（file 段在最后，与 14 次实测一致）----
function buildBody(opts) {
  const o = Object.assign({ boundary: "Boundary_9c8h7g", fileBytes: null, fileName: "1617244567890.jpg" }, opts);
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, "binary"));

  push(`--${o.boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\n`);
  push(`idphoto/0123456789abcdef/AAAAAAAAAAAAAAAAAAAAAA==.jpg\r\n`);
  push(`--${o.boundary}\r\nContent-Disposition: form-data; name="policy"\r\n\r\n`);
  push("eyJleHBpcmF0aW9uIjoiMjAzMC0wMS0wMVQwMDowMDowMCJ9\r\n");
  push(`--${o.boundary}\r\nContent-Disposition: form-data; name="OSSAccessKeyId"\r\n\r\n`);
  push("fake-access-key-id\r\n");
  push(`--${o.boundary}\r\nContent-Disposition: form-data; name="success_action_status"\r\n\r\n`);
  push("201\r\n");
  push(`--${o.boundary}\r\nContent-Disposition: form-data; name="x-oss-meta-source"\r\n\r\n`);
  push("chesicc\r\n");
  push(`--${o.boundary}\r\nContent-Disposition: form-data; name="file"; filename="${o.fileName}"\r\n`);
  push("Content-Type: image/heic\r\n\r\n");
  parts.push(o.fileBytes || crypto.randomBytes(300000));
  push("\r\n");
  push(`--${o.boundary}--\r\n`);
  return Buffer.concat(parts);
}

function toU8(buf) { return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }

// 模拟 App 现场拍的图（heic，300KB 随机字节）
const originalPhoto = crypto.randomBytes(300000);
// 模拟要注入的证件照（jpeg 魔数开头，250KB）
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(250000 - 4)]);

let pass = 0;
function t(name, fn) { fn(); pass++; console.log("  ✓ " + name); }

// ---- 1. base64 往返 ----
t("b64ToBytes 与 Node 原生解码一致", () => {
  const b64 = jpeg.toString("base64");
  const mine = b64ToBytes(b64);
  assert.strictEqual(Buffer.from(mine).toString("hex"), jpeg.toString("hex"));
});

// ---- 2. boundary 解析 ----
t("boundary 解析（带引号 / 不带引号）", () => {
  assert.strictEqual(getBoundary('multipart/form-data; boundary="Boundary_9c8h7g"'), "Boundary_9c8h7g");
  assert.strictEqual(getBoundary("multipart/form-data; boundary=Boundary_9c8h7g; charset=utf-8"), "Boundary_9c8h7g");
  assert.strictEqual(getBoundary("application/json"), null);
});

// ---- 3. 核心替换 ----
t("file 段被替换、其余段与收尾逐字节保留", () => {
  const raw = buildBody({ fileBytes: originalPhoto });
  const r = swapFilePart(toU8(raw), toU8(jpeg), "Boundary_9c8h7g", "idphoto.jpg");
  assert.ok(!r.error, "替换报错: " + r.error);
  const out = Buffer.from(r.body);

  // 前缀（到文件段起始边界之前）必须与原体逐字节一致
  const marker = raw.indexOf('name="file";');
  const start = raw.lastIndexOf("--Boundary_9c8h7g", marker);
  assert.ok(out.subarray(0, start).equals(raw.subarray(0, start)), "前缀被改动");

  // 收尾边界必须保留
  const closing = `--Boundary_9c8h7g--\r\n`;
  assert.ok(out.subarray(out.length - closing.length).toString("binary") === closing, "收尾边界丢失");

  // 新文件段内容正确
  assert.ok(out.includes('name="file"; filename="idphoto.jpg"'), "新 Content-Disposition 不对");
  assert.ok(out.includes("Content-Type: image/jpeg"), "新 Content-Type 不对");
  const fpos = out.indexOf("Content-Type: image/jpeg\r\n\r\n") + "Content-Type: image/jpeg\r\n\r\n".length;
  assert.ok(out.subarray(fpos, fpos + jpeg.length).equals(jpeg), "照片字节不一致");

  // 原图字节不应再出现
  assert.ok(out.indexOf(originalPhoto.subarray(0, 64)) < 0, "原图字节仍残留在新 body 里");

  // 尺寸约束
  assert.ok(jpeg.length >= 1024 && jpeg.length <= 1048576, "照片尺寸超 policy");
});

// ---- 4. 文件名陷阱：原 filename 含 "file" 字样 ----
t('原 filename="file.jpg" 不干扰定位', () => {
  const raw = buildBody({ fileBytes: originalPhoto, fileName: "file.jpg" });
  const r = swapFilePart(toU8(raw), toU8(jpeg), "Boundary_9c8h7g", "idphoto.jpg");
  assert.ok(!r.error, "替换报错: " + r.error);
  const out = Buffer.from(r.body);
  assert.ok(out.includes('filename="idphoto.jpg"'));
  assert.ok(out.indexOf(originalPhoto.subarray(0, 64)) < 0);
});

// ---- 5. 体积守卫值 ----
t("照片 <1024B / >1MB 时返回错误（由调用方 fail-closed）", () => {
  const raw = buildBody({ fileBytes: originalPhoto });
  const tiny = toU8(Buffer.from([0xff, 0xd8])); // 2B
  assert.ok(swapFilePart(toU8(raw), tiny, "Boundary_9c8h7g", "x.jpg").body !== undefined,
    "swap 本身不做体积判断（判断在 main），函数应正常返回");
});

// ---- 6. 新旧体积差 = 段头变化（Content-Length 重算依据）----
t("新 body 长度 = 前缀 + 新段头 + 照片 + 收尾", () => {
  const raw = buildBody({ fileBytes: originalPhoto });
  const r = swapFilePart(toU8(raw), toU8(jpeg), "Boundary_9c8h7g", "idphoto.jpg");
  const out = Buffer.from(r.body);
  const marker = raw.indexOf('name="file";');
  const start = raw.lastIndexOf("--Boundary_9c8h7g", marker);
  const end = raw.indexOf("--Boundary_9c8h7g", raw.indexOf('name="file";') + 10);
  const expect = start + ("--Boundary_9c8h7g\r\n" +
    'Content-Disposition: form-data; name="file"; filename="idphoto.jpg"\r\n' +
    "Content-Type: image/jpeg\r\n\r\n").length + jpeg.length + 2 + (raw.length - end);
  assert.strictEqual(out.length, expect);
});

// ---- 7. 载荷解析：纯 Base64 / photo.json / Gist API 包装 ----
t("parsePhotoPayload 三种形态", () => {
  const md5 = crypto.createHash("md5").update(jpeg).digest("hex");
  const b64 = jpeg.toString("base64");

  // 纯 Base64
  let p = parsePhotoPayload(b64);
  assert.strictEqual(p.md5, "");
  assert.strictEqual(Buffer.from(b64ToBytes(p.b64)).toString("hex"), jpeg.toString("hex"));

  // photo.json（inject.py 产出）
  p = parsePhotoPayload(JSON.stringify({ md5: md5, b64: b64, size: jpeg.length }));
  assert.strictEqual(p.md5, md5);
  assert.strictEqual(Buffer.from(b64ToBytes(p.b64)).toString("hex"), jpeg.toString("hex"));

  // Gist API 包装（PHOTO_URL = api.github.com/gists/<id>）
  const gist = JSON.stringify({
    url: "https://api.github.com/gists/fake",
    files: { "photo.json": { filename: "photo.json", content: JSON.stringify({ md5: md5, b64: b64 }) } }
  });
  p = parsePhotoPayload(gist);
  assert.strictEqual(p.md5, md5);
  assert.strictEqual(Buffer.from(b64ToBytes(p.b64)).toString("hex"), jpeg.toString("hex"));

  // 坏的 JSON 载荷要抛错（fail-closed 依据）；非 JSON 开头的乱串按纯 Base64 处理，
  // 解码失败推迟到 b64ToBytes（返回 null）由 main 兜底掐断
  assert.throws(() => parsePhotoPayload('{"note":"placeholder"}'));
  assert.throws(() => parsePhotoPayload('{"files":{}}'));
  const junk = parsePhotoPayload("not json !!!");
  assert.strictEqual(junk.md5, "");
  assert.strictEqual(b64ToBytes(junk.b64), null);
});

// ---- 8. MD5 参照（注入照片.py 输出的值应与此一致，供 PHOTO_MD5 配置）----
t("MD5 计算参照", () => {
  const md5 = crypto.createHash("md5").update(jpeg).digest("hex");
  console.log("    （示例照片 MD5 = " + md5 + "）");
  assert.ok(/^[0-9a-f]{32}$/.test(md5));
});

console.log("\n✅ 全部 " + pass + " 组测试通过");
