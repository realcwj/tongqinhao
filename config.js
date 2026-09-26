// ===== 数据源 =====
// 数据同步日期（顶部「数据同步」胶囊文案）
const DATA_SYNC_DATE = "2026-09-27";

// 数据文件地址（顶部「数据同步」胶囊跳转目标）
const DATA_SYNC_URL = "https://github.com/realcwj/tongqinhao/blob/main/processed.json";

// 页面使用的唯一业务数据源（由 get_all_route.py 生成）
const DATA_URL = "processed.json";

// ===== 查询参数 =====
// 附近站点的最大距离（公里）
const MAX_DISTANCE_KM = 1;

// 附近站点列表、「附近」快速选择最多取用的站点数
const MAX_NEARBY_STATIONS = 5;

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-sync-pill]").forEach((pill) => {
    pill.href = DATA_SYNC_URL;
    const label = pill.querySelector("[data-sync-label]");
    if (label) label.textContent = `数据同步：${DATA_SYNC_DATE}`;
  });

  // 页面静态文案中用 {KM} / {MAX} 占位，由上面的常量填充（只改文本节点，不影响子元素）
  document.querySelectorAll("[data-config-text]").forEach((element) => {
    element.childNodes.forEach((node) => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      node.nodeValue = node.nodeValue
        .replace(/\{KM\}/g, MAX_DISTANCE_KM)
        .replace(/\{MAX\}/g, MAX_NEARBY_STATIONS);
    });
  });
});
