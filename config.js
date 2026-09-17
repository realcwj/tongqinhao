// 数据同步日期
const DATA_SYNC_DATE = "2026-09-18";

// 数据文件地址
const DATA_SYNC_URL = "https://github.com/realcwj/tongqinhao/blob/main/processed.json";

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-sync-pill]").forEach((pill) => {
    pill.href = DATA_SYNC_URL;
    const label = pill.querySelector("[data-sync-label]");
    if (label) label.textContent = `数据同步：${DATA_SYNC_DATE}`;
  });
});
