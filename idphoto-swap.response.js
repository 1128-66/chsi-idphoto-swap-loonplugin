/**
 * 学信网 idphoto 换图 —— 回执校验脚本（Loon / Surge 通用）
 *
 * 脚本类型：http-response（requires-body 不需要，只看响应头）
 *
 * 作用：上传成功后 OSS 返回 201 + ETag（= 服务端实际存储字节的 MD5）。
 * 与注入照片的 MD5（PHOTO_MD5）比对，一致则弹通知确认
 * 「服务端存的就是本地图」——和 Mac 版的 🔒 校验等价。
 */

// ==================== 配置区 ====================
// 注入照片的 MD5（小写十六进制）。注入照片.py 会自动写入已注入副本；
// 手动配置时粘贴注入时输出的 MD5。留空 = 只提示上传结果，不比对。
var PHOTO_MD5 = "";
// ================================================

function header(headers, name) {
  if (!headers) return null;
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (String(k).toLowerCase() === lower) return headers[k];
  }
  return null;
}

function main() {
  var url = $request.url || "";
  if (url.indexOf("chsi-idphotosrv.oss-cn-shanghai.aliyuncs.com") < 0) { $done({}); return; }

  var status = $response.status;
  var etag = header($response.headers, "ETag");
  if (etag) etag = String(etag).replace(/"/g, "").trim().toLowerCase();

  if (status !== 201) {
    $notification.post("学信网换图", "上传响应 " + status + " ❌",
      "上传未成功（HTTP " + status + "），检查照片大小/格式。");
    $done({});
    return;
  }

  // MD5 取值：脚本内配置优先；云端注入（URL 模式）时由请求脚本写入持久化存储
  var md5 = PHOTO_MD5;
  if (!md5) {
    // 存储读取（$persistentStore 大写 S；$prefs 兜底 —— 详见换图脚本 LS 层注释）
    try { if (typeof $persistentStore !== "undefined" && $persistentStore.read) md5 = $persistentStore.read("idphoto_md5") || ""; } catch (e) {}
    if (!md5) { try { if (typeof $prefs !== "undefined" && $prefs.valueForKey) md5 = $prefs.valueForKey("idphoto_md5") || ""; } catch (e) {} }
  }

  if (!md5) {
    $notification.post("学信网换图", "上传成功 ✅（未校验）",
      "HTTP 201，ETag=" + (etag || "无") + "。配置 MD5 后可自动比对。");
    $done({});
    return;
  }

  if (etag && etag === md5) {
    $notification.post("学信网换图", "🔒 服务端存的就是本地图",
      "ETag == 注入照片 MD5（" + md5 + "），密码学意义上等价。");
  } else {
    $notification.post("学信网换图", "❌ ETag 不匹配",
      "服务端 MD5=" + (etag || "无") + "，注入照片 MD5=" + md5 +
      "。替换可能未生效，原图可能已上传！");
  }
  $done({});
}

if (typeof $response !== "undefined" && typeof $done === "function") {
  try { main(); } catch (e) { console.log("[idphoto] 校验脚本异常: " + e); $done({}); }
}
