/**
 * 学信网 idphoto 换图 —— 请求改写脚本（Loon / Surge 通用）
 *
 * 脚本类型：http-request
 * 必需参数：requires-body=true, binary-body-mode=true
 *
 * 原理：App 把现场照片通过 OSS PostObject 直传，multipart 里最后一个
 * 段是 name="file"。本脚本把该段整体替换为注入的本地证件照，其余段
 * （key/policy/签名等）逐字节保留，Content-Length 显式重算。
 *
 * ⚠️ 设计取向：fail-closed —— 替换条件不满足时直接掐断请求（Loon 支持
 * $done() 无参中断），绝不放行原图。不需要此行为时把 ABORT_ON_ERROR
 * 改为 false（此时改为放行 + 弹通知警告，即 fail-open）。
 */

// ==================== 配置区 ====================
// 照片来源（按优先级自动选择，iPhone 全程自用，无需电脑）：
//   ① 本机选图页"存本机"：Safari 打开 example.com/idphoto 选照片 → 存 $persistentStore，
//      照片只存在自己手机里，无需任何配置（主力模式）
//   ② 本机选图页"云端直链"：页面直传 litterbox 图床（72h 有效），直链存进存储，
//      适合临时换图/多设备同步场景
//   ③ PHOTO_URL : 照片载荷 URL（一般留空；自用已不需要 Gist 云端注入）
//   ④ PHOTO_B64 : 照片 Base64 兜底（用 注入照片.py 生成后粘贴，仅在没 iPhone 时用）
var PHOTO_B64 = "";
var PHOTO_URL = "";

// 服务端存储校验：注入照片的 MD5（小写十六进制，注入照片.py 会输出）。
// 留空则跳过 ETag 校验。
var PHOTO_MD5 = "";

// 替换后文件段的名字（Content-Type 固定按 jpeg 处理，OSS 只存字节不看真格式）
var FILENAME = "idphoto.jpg";

// OSS policy 约束：content-length-range 1024 ~ 1048576
var MIN_SIZE = 1024;
var MAX_SIZE = 1048576;

// fail 行为：true = 出问题直接掐断请求（Loon，fail-closed，推荐）
//           false = 出问题放行原图并弹警告（Surge 兜底，fail-open）
var ABORT_ON_ERROR = true;

// 目标主机（App 的 OSS 直传地址）
var TARGET_HOST = "chsi-idphotosrv.oss-cn-shanghai.aliyuncs.com";
// ================================================

function log(msg) {
  console.log("[idphoto] " + msg);
}

function notify(title, body) {
  try {
    if (typeof $notification !== "undefined" && $notification.post) {
      $notification.post("学信网换图", title, body);
    }
  } catch (e) {}
}

// 大小写不敏感地取 header
function header(headers, name) {
  if (!headers) return null;
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (String(k).toLowerCase() === lower) return headers[k];
  }
  return null;
}

// ---------- 字节工具（全部按 ASCII 处理，multipart 结构与照片字节都安全） ----------
function strBytes(s) {
  var a = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c > 127) return null;
    a.push(c);
  }
  return a;
}

function indexOfBytes(hay, needle, from) {
  outer: for (var i = from || 0; i <= hay.length - needle.length; i++) {
    for (var j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOfBytes(hay, needle, before) {
  var limit = Math.min(before === undefined ? hay.length - needle.length : before,
                       hay.length - needle.length);
  outer: for (var i = limit; i >= 0; i--) {
    for (var j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concatBytes(parts) {
  var total = 0, i;
  for (i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total), o = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
  return out;
}

var B64TAB = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64ToBytes(b64) {
  var s = String(b64).replace(/\s+/g, "").replace(/=+$/, "");
  var out = new Uint8Array(Math.floor(s.length * 3 / 4));
  var o = 0, buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64TAB.indexOf(s.charAt(i));
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

function b64FromBytes(u8) {
  var out = "", i;
  for (i = 0; i < u8.length; i += 3) {
    var b0 = u8[i], b1 = i + 1 < u8.length ? u8[i + 1] : 0, b2 = i + 2 < u8.length ? u8[i + 2] : 0;
    out += B64TAB.charAt(b0 >> 2) + B64TAB.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += (i + 1 < u8.length) ? B64TAB.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
    out += (i + 2 < u8.length) ? B64TAB.charAt(b2 & 63) : "=";
  }
  return out;
}

// ---------- MD5（与选图页同源的全生成式实现） ----------
var MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
var MD5_K = (function () {
  var k = new Array(64);
  for (var i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  return k;
})();
function md5Hex(u8) {
  var n = u8.length, words = [], i;
  for (i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] || 0) | (u8[i] << ((i & 3) << 3));
  words[n >> 2] = (words[n >> 2] || 0) | (0x80 << ((n & 3) << 3));
  var total = (((n + 8) >> 6) + 1) << 4;
  for (i = (n >> 2) + 1; i < total; i++) words[i] = 0;
  words[total - 2] = n << 3;
  words[total - 1] = 0;
  var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (i = 0; i < total; i += 16) {
    var A = a, B = b, C = c, D = d, f, g, s, rot, j;
    for (j = 0; j < 64; j++) {
      if (j < 16)      { f = (b & c) | (~b & d);      g = j; }
      else if (j < 32) { f = (d & b) | (~d & c);      g = (5 * j + 1) & 15; }
      else if (j < 48) { f = b ^ c ^ d;               g = (3 * j + 5) & 15; }
      else             { f = c ^ (b | ~d);            g = (7 * j) & 15; }
      f = (f + a + MD5_K[j] + words[i + g]) | 0;
      s = MD5_S[j];
      rot = ((f << s) | (f >>> (32 - s))) | 0;
      var nb = (b + rot) | 0;
      a = d; d = c; c = b; b = nb;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  var out = "", w = [a, b, c, d], k;
  for (i = 0; i < 4; i++) {
    for (k = 0; k < 4; k++) {
      var byte = (w[i] >>> (k * 8)) & 255;
      out += (byte < 16 ? "0" : "") + byte.toString(16);
    }
  }
  return out;
}

// ==================== 通用存储层（根因修复版） ====================
// ⚠️ 历史教训：$persistentstore（全小写）不存在 —— 正确 API 是 $persistentStore
// （Store 大写 S），且 Surge 系写入签名是 write(值, 键)。本层自适应探测。
var LS = (function () {
  var be = null, order = null, name = "";
  function cands() {
    var a = [];
    try { if (typeof $persistentStore !== "undefined" && $persistentStore) a.push(["$persistentStore", $persistentStore]); } catch (e) {}
    try { if (typeof $prefs !== "undefined" && $prefs) a.push(["$prefs", $prefs]); } catch (e) {}
    return a;
  }
  function rd(b, k) {
    try { if (typeof b.read === "function") { var v = b.read(k); return v == null ? "" : String(v); } } catch (e) {}
    try { if (typeof b.valueForKey === "function") { var v2 = b.valueForKey(k); return v2 == null ? "" : String(v2); } } catch (e) {}
    return null;
  }
  function wr(b, o, k, v) {
    try {
      if (typeof b.write === "function") return (o === "vk") ? b.write(v, k) : b.write(k, v);
      if (typeof b.setValueForKey === "function") return (o === "vk") ? b.setValueForKey(v, k) : b.setValueForKey(k, v);
    } catch (e) { return false; }
    return false;
  }
  function detect() {
    if (be) return true;
    var cs = cands(), ORDERS = ["vk", "kv"];
    for (var i = 0; i < cs.length; i++) {
      for (var j = 0; j < ORDERS.length; j++) {
        if (wr(cs[i][1], ORDERS[j], "idphoto_probe", "1") === false) continue;
        if (rd(cs[i][1], "idphoto_probe") === "1") {
          be = cs[i][1]; order = ORDERS[j]; name = cs[i][0];
          wr(be, order, "idphoto_probe", "");
          return true;
        }
      }
    }
    return false;
  }
  return {
    ok: detect,
    backend: function () { return detect() ? name : "无"; },
    get: function (k) { return detect() ? (rd(be, k) || "") : ""; },
    put: function (k, v) {
      if (!detect()) return false;
      v = String(v);
      if (wr(be, order, k, v) === false) return false;
      return rd(be, k) === v;
    },
    del: function (k) { return detect() ? wr(be, order, k, "") !== false : false; }
  };
})();

function getBoundary(contentType) {
  var m = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType || "");
  return m ? (m[1] || m[2]) : null;
}

// ---------- 核心：替换 multipart 中的 name="file" 段 ----------
// bodyBytes: Uint8Array 原始请求体；photoBytes: Uint8Array 替换照片
// 返回 { body } 或 { error }
function swapFilePart(bodyBytes, photoBytes, boundary, filename) {
  var delim = strBytes("--" + boundary);
  // 带 "；" 结尾的标记，避免误匹配 filename="file..."
  var marker = strBytes('name="file";');
  if (!delim || !marker) return { error: "构造查找串失败（boundary 含非 ASCII？）" };

  var mi = indexOfBytes(bodyBytes, marker, 0);
  if (mi < 0) return { error: '未找到 name="file" 段（不是 PostObject 直传？）' };

  // 文件段起始 = 向前找最近的 --boundary
  var start = lastIndexOfBytes(bodyBytes, delim, mi);
  if (start < 0) return { error: "未找到文件段的起始边界" };

  // 文件段结束 = 向后找下一个 --boundary（不含其前面的 \r\n，那两个字节由新段补回）
  var end = indexOfBytes(bodyBytes, delim, mi + marker.length);
  if (end < 0) return { error: "未找到文件段的结束边界" };

  var head = strBytes(
    "--" + boundary + "\r\n" +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
    "Content-Type: image/jpeg\r\n\r\n"
  );
  if (!head) return { error: "构造文件段失败" };

  var body = concatBytes([
    bodyBytes.subarray(0, start),   // 其余表单段，逐字节保留
    head,
    photoBytes,
    strBytes("\r\n"),
    bodyBytes.subarray(end)         // 收尾边界（--boundary-- 等），逐字节保留
  ]);
  return { body: body };
}

// ---------- 载荷解析 ----------
// 支持三种形态：
//   1. 纯 Base64 文本（手工注入 / 简单托管）
//   2. {"md5":"...","b64":"..."}                    ← inject.py 产出的 photo.json
//   3. Gist API 响应 {"files":{"photo.json":{...}}}  ← PHOTO_URL 指向 api.github.com/gists/<id>
// 返回 {b64, md5}；解析失败抛异常（由调用方 fail-closed 掐断）
function parsePhotoPayload(text) {
  var s = String(text).trim();
  if (s.charAt(0) === "{") {
    var outer = JSON.parse(s);
    var inner = outer;
    if (outer && outer.files) {                      // Gist API 包装层
      var k = Object.keys(outer.files)[0];
      inner = JSON.parse(outer.files[k].content);
    }
    if (!inner || !inner.b64) throw new Error("JSON 载荷里没有 b64 字段");
    return { b64: String(inner.b64).replace(/\s+/g, ""),
             md5: inner.md5 ? String(inner.md5).toLowerCase() : "" };
  }
  return { b64: s.replace(/\s+/g, ""), md5: "" };
}

// ---------- 取照片 ----------
// 优先级：① 本机选图页存的照片（$persistentStore 里的 idphoto_b64，支持分片）
//         ② 本机选图页存的图床直链（idphoto_url，litterbox 72h）
//         ③ PHOTO_URL（GitHub 云端注入 / 自托管）
//         ④ PHOTO_B64（手工注入）
function storeReadBig(key) {
  // 分片格式：idphoto_b64_c = 分片数，idphoto_b64_0..N-1 = 各分片
  var cnt = parseInt(LS.get(key + "_c") || "0", 10);
  if (cnt > 0 && cnt < 1000) {
    var parts = [];
    for (var i = 0; i < cnt; i++) parts.push(LS.get(key + "_" + i) || "");
    return parts.join("");
  }
  return LS.get(key) || "";   // 兼容旧的单 key 写法
}

// 直链模式：拉原始字节 → 按 latin1 还原 → MD5 校验 → 编回 Base64 走统一管线。
// 若引擎把响应体按 UTF-8 解码过（二进制损坏），MD5 校验会拦下并 fail-closed。
function fetchFromUrl(url, md5, callback, label) {
  log("从" + label + "拉取照片字节 ...");
  $httpClient.get({ url: url, headers: {} }, function (status, respHeaders, respBody) {
    if (status !== 200 || !respBody) {
      callback(null, label + "拉取失败 HTTP " + status);
      return;
    }
    var bytes = new Uint8Array(respBody.length);
    for (var i = 0; i < respBody.length; i++) bytes[i] = respBody.charCodeAt(i) & 0xff;
    if (md5) {
      var got = md5Hex(bytes);
      if (got !== md5) {
        callback(null, label + "内容校验失败（MD5 " + got.slice(0, 8) + "… ≠ 期望 " + md5.slice(0, 8) +
          "…，直链过期/内容被改/引擎按 UTF-8 解码了二进制？）");
        return;
      }
    }
    log("✅ " + label + "拉取成功：" + bytes.length + "B" + (md5 ? "，MD5 校验通过" : "，无期望 MD5，跳过校验"));
    callback({ b64: b64FromBytes(bytes), md5: md5 }, null);
  });
}

function withPhoto(callback) {
  var sb64 = "", smd5 = "";
  try {
    sb64 = storeReadBig("idphoto_b64");
    smd5 = LS.get("idphoto_md5") || "";
  } catch (e) {}
  if (sb64) {
    log("照片来源：本机选图页（" + LS.backend() + "）");
    callback({ b64: sb64, md5: smd5 }, null);
    return;
  }

  var surl = LS.get("idphoto_url");
  if (surl) {
    log("照片来源：本机云端直链（" + LS.backend() + "）");
    fetchFromUrl(surl, smd5, callback, "本机直链");
    return;
  }

  if (PHOTO_URL) {
    log("从 URL 拉取照片载荷 ...");
    $httpClient.get({ url: PHOTO_URL, headers: {} }, function (status, respHeaders, respBody) {
      if (status !== 200 || !respBody) {
        callback(null, "PHOTO_URL 拉取失败 HTTP " + status);
        return;
      }
      try {
        callback(parsePhotoPayload(respBody), null);
      } catch (e) {
        callback(null, "载荷解析失败: " + e);
      }
    });
    return;
  }
  if (PHOTO_B64) { callback({ b64: PHOTO_B64, md5: PHOTO_MD5 }, null); return; }
  callback(null, "没有配置照片（本机存储/直链/PHOTO_URL/PHOTO_B64 都为空）");
}

// ---------- 主流程 ----------
function main() {
  var url = $request.url || "";
  var host = header($request.headers, "Host") || "";
  if (url.indexOf(TARGET_HOST) < 0 && host.indexOf(TARGET_HOST) < 0) { $done({}); return; }

  if (($request.method || "").toUpperCase() !== "POST") { $done({}); return; }

  var ct = header($request.headers, "Content-Type") || "";
  var boundary = getBoundary(ct);
  var body = $request.body;

  if (!boundary) return fail('Content-Type 里没有 boundary');
  if (!body) return fail("请求体为空（requires-body / binary-body-mode 没开？）");
  if (typeof body === "string") return fail("拿到的是文本 body —— binary-body-mode 未生效，请检查脚本参数");

  log("命中 OSS 直传：" + url.slice(0, 80) + "  body=" + body.length + "B");

  withPhoto(function (payload, err) {
    if (err || !payload) return fail(err || "照片载荷为空");
    var photo = b64ToBytes(payload.b64);
    if (!photo || !photo.length) return fail("照片 Base64 解码失败");

    // URL 模式下把 MD5 存进持久化存储，供回执脚本比对（请求先于响应执行，顺序有保证）
    if (payload.md5) {
      try { LS.put("idphoto_md5", payload.md5); } catch (e) {}
    }

    if (photo.length < MIN_SIZE) return fail("照片 " + photo.length + "B < policy 下限 1024B，必被 OSS 拒绝");
    if (photo.length > MAX_SIZE) return fail("照片 " + photo.length + "B > policy 上限 1MB，必被 OSS 拒绝");

    var r = swapFilePart(body, photo, boundary, FILENAME);
    if (r.error) return fail(r.error);

    // Content-Length 显式重算（不依赖引擎是否自动处理）
    var headers = $request.headers || {};
    headers["Content-Length"] = String(r.body.length);

    log("✅ 已替换：原图段 → 本地照片 " + photo.length + "B，新 body=" + r.body.length + "B" +
        (payload.md5 ? "，MD5=" + payload.md5 : ""));
    notify("已替换 ✅", "本地图 " + photo.length + "B 已注入上传请求");
    $done({ body: r.body, headers: headers });
  });
}

function fail(reason) {
  log("❌ " + reason);
  if (ABORT_ON_ERROR) {
    notify("已掐断请求 ⛔", reason);
    try { $done(); }                 // Loon：无参中断（fail-closed）
    catch (e) { $done({}); }         // 引擎不支持无参时退回放行
  } else {
    notify("⚠️ 原图放行", reason);
    $done({});
  }
}

// ---------- 引擎入口 / Node 测试入口 ----------
if (typeof $request !== "undefined" && typeof $done === "function") {
  try { main(); }
  catch (e) {
    log("脚本异常: " + e);
    fail("脚本异常 " + e);
  }
} else if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    swapFilePart: swapFilePart,
    b64ToBytes: b64ToBytes,
    getBoundary: getBoundary,
    indexOfBytes: indexOfBytes,
    parsePhotoPayload: parsePhotoPayload
  };
}
