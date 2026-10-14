/**
 * 本机选图页 —— Loon / Surge 脚本
 *
 * 脚本类型：http-request
 * 必需参数：requires-body=true（文本模式，不要开 binary-body-mode）
 * 匹配：   ^https?:\/\/example\.com\/idphoto
 * MITM：   hostname 需包含 example.com（证书已信任，与 OSS 主机共用）
 *
 * 端点（浏览器访问 example.com/idphoto 即可）：
 *   GET  /idphoto        → 返回选图页（$done({response}) 伪造响应，Loon 官方支持）
 *   POST /idphoto-set    → 页面把压缩后的照片 POST 回来 → 存 $persistentStore
 *   POST /idphoto-set    → 页面把压缩后的照片 POST 回来 → 存 $persistentStore
 *   GET  /idphoto-get    → 查看当前已存照片的摘要
 *   POST /idphoto-clear  → 清除已存照片（换回 PHOTO_B64 / PHOTO_URL 模式）
 *
 * 数据流：页面 canvas 压图 → FileReader 转 Base64 → POST 同域 /idphoto-set
 *         → 本脚本算 MD5 → $persistentstore 写入 idphoto_b64 / idphoto_md5
 *         → 换图请求脚本（idphoto-swap.request.js）优先从存储读取
 *
 * ⚠️ 存储层说明：使用 LS 适配层（$persistentStore 大写 S / $prefs，参数顺序
 *    写后读回自动探测）。之前真机报"存储不可用"系 $persistentstore（全小写）
 *    笔误所致的误诊，存储本身大概率一直可用。
 */

// ==================== 配置区 ====================
var HOST_PATH = "/idphoto";          // 匹配前缀
var MIN_SIZE = 1024, MAX_SIZE = 1048576;   // 与 OSS policy 一致

// 照片去向：存进 $persistentStore，照片不离机
// ================================================

function log(m) { console.log("[idphoto-picker] " + m); }

// ==================== 通用存储层（根因修复版） ====================
// ⚠️ 历史教训：之前所有"存储不可用"都是误诊 —— 用了 $persistentstore（全小写），
// 而 Surge/Loon 的 API 是 $persistentStore（Store 大写 S），变量根本不存在。
// 另外 Surge 系写入签名是 write(值, 键)（值在前）。本层两个坑都自适应：
// 后端依次探测 $persistentStore / $prefs，写入后读回校验确定参数顺序。
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
          wr(be, order, "idphoto_probe", "");   // 清理探测残留
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
      return rd(be, k) === v;              // 写后读回，签名/容量问题都逃不掉
    },
    del: function (k) { return detect() ? wr(be, order, k, "") !== false : false; }
  };
})();

function sGet(k) { return LS.get(k); }
function sPut(k, v) { return LS.put(k, v); }
function sDel(k) { return LS.del(k); }

// 自适应分片写入：从 200KB（整张一次写）逐档对半下探，找到存储能接受的最大片长。
// 返回 {ok:true, chunk:片长} 或 {ok:false, err:原因, min:试过的最小片长}
var CHUNK_SIZES = [200000, 60000, 30000, 15000, 8000, 4000, 2000, 1000, 500];
function sPutBig(key, val) {
  val = String(val);
  var lastErr = "", minTried = CHUNK_SIZES[CHUNK_SIZES.length - 1];
  for (var si = 0; si < CHUNK_SIZES.length; si++) {
    var size = CHUNK_SIZES[si], n = Math.ceil(val.length / size), failed = -1;
    for (var i = 0; i < n; i++) {
      if (!sPut(key + "_" + i, val.substr(i * size, size))) { failed = i; lastErr = "分片 " + i + "/" + n + "（" + size + "B/片）写入失败"; break; }
    }
    if (failed < 0) {
      // 清理换档/上次残留的多余分片
      for (var j = n; j < n + 600; j++) { if (sGet(key + "_" + j)) sDel(key + "_" + j); else break; }
      if (sPut(key + "_c", String(n))) return { ok: true, chunk: size };
      lastErr = "计数 key 写入失败";
    } else {
      for (var k2 = 0; k2 <= failed; k2++) sDel(key + "_" + k2);   // 清掉本档已写的片
    }
  }
  return { ok: false, err: lastErr, min: minTried };
}
function sDelBig(key) {
  var cnt = parseInt(sGet(key + "_c") || "0", 10);
  sDel(key + "_c");
  for (var i = 0; i < cnt + 600; i++) { if (sGet(key + "_" + i)) sDel(key + "_" + i); else break; }
  sDel(key);   // 兼容旧单 key
}

function notify(t, b) {
  try { if (typeof $notification !== "undefined") $notification.post("学信网换图", t, b); } catch (e) {}
}
function respHtml(html) {
  $done({ response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: html } });
}
function respJson(status, obj) {
  $done({ response: { status: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) } });
}
function bytesToText(u8) {
  var s = "", CHUNK = 8192;
  for (var i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
  }
  return decodeURIComponent(escape(s));   // 按 UTF-8 还原
}

// ==================== MD5（RFC 1321，全生成式实现，Node 对拍验证） ====================
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
  words[total - 2] = n << 3;      // 比特长度低 32 位（照片 < 512MB，高位恒 0）
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

// ==================== Base64 解码（与换图脚本同源） ====================
var B64TAB = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64ToBytes(b64) {
  var s = String(b64).replace(/\s+/g, "").replace(/=+$/, "");
  var out = new Uint8Array(Math.floor(s.length * 3 / 4));
  var o = 0, buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64TAB.indexOf(s.charAt(i));
    if (v < 0) return null;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

// ==================== 选图页（自包含 HTML，无外部资源） ====================
var PAGE_HTML = [
'<!doctype html><html><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>证件照 · 本机注入</title>',
'<style>',
'  :root{color-scheme:light dark}',
'  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
'       font-family:-apple-system,sans-serif;background:#f2f3f5;color:#1a1a1a}',
'  @media (prefers-color-scheme:dark){body{background:#101214;color:#eee}}',
'  .card{width:min(92vw,420px);background:#fff;border-radius:18px;padding:28px 24px;',
'        box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}',
'  @media (prefers-color-scheme:dark){.card{background:#1c1e22;box-shadow:none}}',
'  h1{font-size:20px;margin:0 0 6px}',
'  .sub{font-size:13px;opacity:.6;line-height:1.6;margin:0 0 20px}',
'  input{display:none}',
'  .btn{display:block;padding:14px;border-radius:12px;background:#0a84ff;color:#fff;',
'       font-size:16px;font-weight:600;cursor:pointer}',
'  .btn:active{opacity:.8}',
'  #st{margin-top:16px;font-size:14px;line-height:1.6;min-height:20px;word-break:break-all}',
'  #cur{margin-top:14px;font-size:12px;opacity:.55;word-break:break-all}',
'  .ghost{margin-top:18px;background:none;border:1px solid rgba(128,128,128,.4);color:inherit;',
'         padding:9px 16px;border-radius:10px;font-size:13px;cursor:pointer}',
'  .ghost.wide{display:block;width:100%;margin-top:12px;font-size:14px}',
'</style></head><body>',
'<div class="card">',
'  <h1>证件照注入</h1>',
'  <p class="sub">选照片 → 自动压缩 → 存入本机<br>长期有效，照片不离机</p>',
'  <input type="file" id="f" accept="image/*">',
'  <label class="btn" for="f">选择照片（存本机）</label>',
'  <div id="st"></div>',
'  <div id="cur">加载中…</div>',
'  <button class="ghost" id="clr">清除已存照片</button>',
'</div>',
'<script>',
'  var st = document.getElementById("st"), cur = document.getElementById("cur");',
'  function loadCur(){',
'    fetch("/idphoto-get").then(function(r){return r.json();}).then(function(m){',
'      var txt = "存储" + (m.storage || "未知");',
'      if (m && m.md5) {',
'        txt = "当前：本机 " + Math.round(m.size/1024) + "KB · " + m.md5.slice(0,8) + "… · " + txt;',
'      } else { txt = "当前：未设置 · " + txt; }',
'      cur.textContent = txt;',
'    }).catch(function(){ cur.textContent = "当前：未知"; });',
'  }',
'  loadCur();',
'  function postJSON(path, obj){',
'    return fetch(path, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(obj)}).then(function(r){ return r.json(); });',
'  }',
'  document.getElementById("f").addEventListener("change", function(){',
'    var file = this.files[0]; if (!file) return;',
'    st.textContent = "处理中…";',
'    compress(file).then(function(blob){',
'      return new Promise(function(res, rej){',
'        var r = new FileReader();',
'        r.onload = function(){ res({b64: r.result.split(",")[1], size: blob.size, blob: blob}); };',
'        r.onerror = function(){ rej(new Error("读取失败")); };',
'        r.readAsDataURL(blob);',
'      });',
'    }).then(function(p){',
'      return postJSON("/idphoto-md5", {b64:p.b64, size:p.size, name:file.name}).then(function(m){',
'        if (!m.ok) throw new Error(m.err || "校验失败");',
'        p.md5 = m.md5;',
'        // 直接 POST 回 /idphoto-set 存进 $persistentStore',
'        return postJSON("/idphoto-set", {b64:p.b64, size:p.size, name:file.name});',
'      });',
'    }).then(function(m){',
'      var tail = " · MD5 " + m.md5.slice(0,8) + "…";',
'      st.textContent = m.ok ? ("✅ 已存入本机：" + m.size + "B" + tail)',
'                            : ("❌ " + (m.err || "失败"));',
'      loadCur();',
'    }).catch(function(e){ st.textContent = "❌ " + e; });',
'  });',
'  function compress(file){',
'    return new Promise(function(res, rej){',
'      var img = new Image();',
'      img.onload = function(){ res(img); };',
'      img.onerror = function(){ rej(new Error("图片解码失败")); };',
'      img.src = URL.createObjectURL(file);',
'    }).then(function(img){',
'      var W = [1600,1200,1000,900,800], Q = [92,85,75,60,45];',
'      var canvas = document.createElement("canvas");',
'      var p = Promise.resolve(null);',
'      for (var wi = 0; wi < W.length; wi++){',
'        (function(wi){',
'          p = p.then(function(found){',
'            if (found) return found;',
'            var s = Math.min(1, W[wi] / Math.max(img.naturalWidth, img.naturalHeight));',
'            canvas.width = Math.round(img.naturalWidth * s);',
'            canvas.height = Math.round(img.naturalHeight * s);',
'            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);',
'            var q = Promise.resolve(null);',
'            for (var qi = 0; qi < Q.length; qi++){',
'              (function(qi){',
'                q = q.then(function(f){',
'                  if (f) return f;',
'                  return new Promise(function(res){',
'                    canvas.toBlob(function(b){',
'                      if (b && b.size <= 950000 && b.size >= 2000) res(b); else res(null);',
'                    }, "image/jpeg", Q[qi] / 100);',
'                  });',
'                });',
'              })(qi);',
'            }',
'            return q;',
'          });',
'        })(wi);',
'      }',
'      return p.then(function(found){',
'        if (!found) throw new Error("压不到 1MB 内，请换照片");',
'        return found;',
'      });',
'    });',
'  }',
'  document.getElementById("clr").addEventListener("click", function(){',
'    fetch("/idphoto-clear", {method:"POST"}).then(function(){',
'      st.textContent = "已清除，回到 PHOTO_B64 / PHOTO_URL 模式";',
'      cur.textContent = "当前：未设置";',
'    });',
'  });',
'<\/script></body></html>'
].join("\n");

// ==================== 请求处理 ====================
function parseSetBody(text) {
  var obj = JSON.parse(String(text));
  if (!obj || !obj.b64) throw new Error("载荷里没有 b64");
  return obj;
}

// 校验上传载荷并计算 MD5（-set / -md5 共用）；不通过时返回 {error:respObj}
function validateUpload(text) {
  var body = $request.body;
  if (!body) return { error: { code: 400, obj: { ok: false, err: "没有请求体（requires-body 没开？）" } } };
  var raw = (typeof body === "string") ? body : bytesToText(body);
  var p;
  try { p = parseSetBody(raw); }
  catch (e) { return { error: { code: 400, obj: { ok: false, err: "载荷解析失败: " + e } } }; }

  var bytes = b64ToBytes(p.b64);
  if (!bytes || !bytes.length) return { error: { code: 400, obj: { ok: false, err: "Base64 解码失败" } } };
  if (bytes.length < MIN_SIZE) return { error: { code: 400, obj: { ok: false, err: "照片 " + bytes.length + "B 小于 1KB 下限" } } };
  if (bytes.length > MAX_SIZE) return { error: { code: 400, obj: { ok: false, err: "照片 " + bytes.length + "B 超过 1MB 上限" } } };

  return { p: p, bytes: bytes, md5: md5Hex(bytes) };
}

function main() {
  var url = $request.url || "";
  var path = url.replace(/^https?:\/\/[^\/]+/i, "");
  if (path.indexOf(HOST_PATH) !== 0) { $done({}); return; }

  // --- 选图页 ---
  if (path === HOST_PATH || path === HOST_PATH + "/") {
    log("选图页被访问");
    respHtml(PAGE_HTML);
    return;
  }

  // --- 校验 + 算 MD5（存图前先校验，坏照片进不了库） ---
  if (path.indexOf(HOST_PATH + "-md5") === 0) {
    var v5 = validateUpload($request.body || "");
    if (v5.error) { respJson(v5.error.code, v5.error.obj); return; }
    log("校验通过：" + v5.bytes.length + "B, MD5=" + v5.md5);
    respJson(200, { ok: true, md5: v5.md5, size: v5.bytes.length, name: String(v5.p.name || "photo") });
    return;
  }

  // --- 存照片 ---
  if (path === HOST_PATH + "-set") {
    var v = validateUpload($request.body || "");
    if (v.error) { respJson(v.error.code, v.error.obj); return; }
    var p = v.p, bytes = v.bytes, md5 = v.md5;
    var r = sPutBig("idphoto_b64", p.b64);
    if (!r.ok) {
      respJson(500, { ok: false, err: "分片写入仍失败（试到 " + r.min + "B/片）：" + r.err + " —— 本机存储不可用，请走 GitHub 云端注入模式" });
      return;
    }
    log("✅ 照片已存入（" + r.chunk + "B/片 × " + Math.ceil(p.b64.length / r.chunk) + " 片）：" + bytes.length + "B, MD5=" + md5);
    sPut("idphoto_md5", md5);
    var meta = { md5: md5, size: bytes.length, name: String(p.name || "photo"), time: new Date().toISOString() };
    sPut("idphoto_meta", JSON.stringify(meta));

    log("✅ 照片已存入：" + bytes.length + "B, MD5=" + md5);
    notify("照片已存入 ✅", meta.name + " · " + bytes.length + "B · " + md5.slice(0, 8) + "…");
    respJson(200, { ok: true, md5: md5, size: bytes.length, chunk: r.chunk });
    return;
  }

  // --- 查询 ---
  if (path.indexOf(HOST_PATH + "-get") === 0) {
    var raw = sGet("idphoto_meta");
    var m = raw ? JSON.parse(raw) : { ok: false };
    // 存储自检：写读一个测试 key，判断该上下文里存储是否可用
    var stOk = sPut("idphoto_selftest", "ok") && sGet("idphoto_selftest") === "ok";
    sDel("idphoto_selftest");
    m.storage = stOk ? ("可用（" + LS.backend() + "）") : "不可用（此上下文读写失败）";
    respJson(200, m);
    return;
  }

  // --- 清除 ---
  if (path.indexOf(HOST_PATH + "-clear") === 0) {
    sDelBig("idphoto_b64"); sDel("idphoto_md5"); sDel("idphoto_meta"); sDel("idphoto_url");
    log("已清除存储的照片");
    notify("已清除", "回到 PHOTO_B64 / PHOTO_URL 模式");
    respJson(200, { ok: true });
    return;
  }

  $done({});
}

// ---------- 引擎入口 / Node 测试入口 ----------
if (typeof $request !== "undefined" && typeof $done === "function") {
  try { main(); }
  catch (e) { log("异常: " + e); respJson(500, { ok: false, err: String(e) }); }
} else if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    md5Hex: md5Hex,
    b64ToBytes: b64ToBytes,
    parseSetBody: parseSetBody,
    bytesToText: bytesToText,
    PAGE_HTML: PAGE_HTML
  };
}
