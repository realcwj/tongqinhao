const DATA_URL = "processed.json";

const state = {
  routes: [],
  query: "",
  filter: "all",
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  els.search = document.querySelector("#routeSearch");
  els.filters = [...document.querySelectorAll("[data-filter]")];
  els.count = document.querySelector("#routeCount");
  els.directory = document.querySelector("#routeDirectory");
  els.empty = document.querySelector("#routeEmpty");

  els.search.addEventListener("input", () => {
    state.query = els.search.value.trim().toLocaleLowerCase("zh-CN");
    renderRoutes();
  });
  els.filters.forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    els.filters.forEach((item) => item.classList.toggle("is-selected", item === button));
    renderRoutes();
  }));
  els.directory.addEventListener("click", onDirectoryClick);

  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.routes = (data.routes || []).map(normalizeRoute);
    renderRoutes();
  } catch (error) {
    els.count.textContent = "加载失败";
    els.directory.innerHTML = `<div class="empty-state"><div class="empty-state__icon">!</div><h3>线路数据加载失败</h3><p>请通过 GitHub Pages 或静态服务器访问。</p></div>`;
  }
}

function normalizeRoute(route) {
  const stops = route.stops || [];
  const firstRegion = stops.length ? inferRegion(stops[0]) : "1";
  const lastRegion = stops.length ? inferRegion(stops[stops.length - 1]) : firstRegion;
  return {
    ...route,
    stops,
    direction: `${firstRegion}-${lastRegion}`,
    firstRegion,
    lastRegion,
    searchText: `${route.route_name || ""} ${stops.map((stop) => stop.name).join(" ")}`.toLocaleLowerCase("zh-CN"),
  };
}

function renderRoutes() {
  const routes = state.routes.filter((route) => {
    const matchesFilter = state.filter === "all" || route.direction === state.filter;
    const matchesSearch = !state.query || route.searchText.includes(state.query);
    return matchesFilter && matchesSearch;
  });
  els.count.textContent = `${routes.length} / ${state.routes.length} 条`;
  els.empty.hidden = routes.length > 0;
  els.directory.innerHTML = routes.map(routeCardHtml).join("");
}

function routeCardHtml(route) {
  const detailsId = `route-${route.id}-${route.firstRegion}-${route.lastRegion}`;
  const status = vehicleStatus(route.stops, new Date());
  const first = route.stops[0];
  const last = route.stops[route.stops.length - 1];
  const directionText = route.firstRegion === route.lastRegion
    ? `${regionLabel(route.firstRegion)}区域线路`
    : `${regionLabel(route.firstRegion)} → ${regionLabel(route.lastRegion)}`;
  return `<article class="directory-card">
    <button type="button" class="directory-card__summary" data-route-id="${route.id}" aria-expanded="false" aria-controls="${detailsId}">
      <span class="directory-card__time"><strong>${escapeHtml(first?.time || "--:--")}</strong><small>始发</small></span>
      <span class="directory-card__main"><strong>${escapeHtml(route.route_name)}</strong><small>${escapeHtml(first?.name || "未知站点")} → ${escapeHtml(last?.name || "未知站点")}</small></span>
      <span class="direction-chip direction-chip--${route.firstRegion}">${directionText}</span>
      <span class="vehicle-chip ${status.tone}"><strong>${escapeHtml(status.label)}</strong><small>${escapeHtml(status.detail)}</small></span>
      <span class="directory-card__meta"><strong>${route.stops.length}</strong><small>站</small></span>
      <span class="directory-card__expand" aria-hidden="true">+</span>
    </button>
    <div class="directory-card__details" id="${detailsId}" hidden>
      <div class="directory-route-head"><span>线路编号 ${route.id}</span><strong>${escapeHtml(first?.time || "--:--")} - ${escapeHtml(last?.time || "--:--")}</strong></div>
      <ol class="directory-timeline">${route.stops.map((stop, index) => stopHtml(stop, index, route.stops.length)).join("")}</ol>
    </div>
  </article>`;
}

function stopHtml(stop, index, total) {
  const region = inferRegion(stop);
  const edgeLabel = index === 0 ? "始发" : index === total - 1 ? "终点" : "";
  return `<li class="directory-stop directory-stop--${region}">
    <time>${escapeHtml(stop.time || "--:--")}</time>
    <span class="directory-stop__line"></span>
    <span class="directory-stop__name"><strong>${escapeHtml(stop.name)}</strong><small>${regionLabel(region)}${edgeLabel ? ` · ${edgeLabel}` : ""}</small></span>
  </li>`;
}

function onDirectoryClick(event) {
  const button = event.target.closest("[data-route-id]");
  if (!button) return;
  const details = document.querySelector(`#${CSS.escape(button.getAttribute("aria-controls"))}`);
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  button.querySelector(".directory-card__expand").textContent = expanded ? "+" : "−";
  if (details) details.hidden = expanded;
}

function vehicleStatus(stops, now) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const timed = stops.map((stop) => ({ stop, minutes: parseTime(stop.time) })).filter((item) => item.minutes != null);
  if (!timed.length) return { label: "待确认", detail: "暂无时刻", tone: "is-idle" };
  if (nowMinutes < timed[0].minutes) return { label: "未发车", detail: `${minutesText(timed[0].minutes - nowMinutes)}后`, tone: "is-waiting" };
  if (nowMinutes >= timed[timed.length - 1].minutes) return { label: "已到终点", detail: timed[timed.length - 1].stop.name, tone: "is-finished" };
  for (let index = 0; index < timed.length - 1; index += 1) {
    const current = timed[index];
    const next = timed[index + 1];
    if (nowMinutes === current.minutes) return { label: `在 ${current.stop.name}`, detail: `下一站 ${next.stop.name}`, tone: "is-running" };
    if (nowMinutes > current.minutes && nowMinutes < next.minutes) return { label: `前往 ${next.stop.name}`, detail: `离站 ${nowMinutes - current.minutes} 分钟`, tone: "is-running" };
  }
  return { label: "运行中", detail: "车辆行驶中", tone: "is-running" };
}

function inferRegion(stop) {
  const name = String(stop?.name || "");
  const lng = Number(stop?.x);
  const hengqin = /横琴|中医药产业园|琴海|金融岛|汇通|市民中心|人才公寓|华发首府|保利国际|中海名钻|K2荔枝湾|上村|下村|琴政|琴朗|十字门|环岛北路|科创中心|洋环路|中葡经贸|中央汇|横琴医院|伯牙|金汇国际|澳门新街坊/;
  const macau = /澳门|澳大|澳旅|澳理|新濠|银河|威尼斯人|葡京|氹仔|关闸|亚马喇|筷子基|望德|林茂|赛马会|友谊马路|海上居|东北大马路|二龙喉|观音|鮑思高|巴波沙|沙梨头|海擎天|泉悦花园|连贯公路|机场大马路|排角/;
  if (hengqin.test(name)) return "1";
  if (macau.test(name)) return "2";
  return Number.isFinite(lng) && lng >= 113.55 ? "2" : "1";
}

function parseTime(value) {
  const match = typeof value === "string" ? value.match(/^(\d{1,2}):(\d{2})$/) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function regionLabel(region) { return String(region) === "2" ? "澳门" : "横琴"; }
function minutesText(minutes) { return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}` : `${minutes}分钟`; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
