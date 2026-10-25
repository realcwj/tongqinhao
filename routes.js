// 数据源（DATA_URL）见 config.js
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
    els.filters.forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-selected", active);
      item.setAttribute("aria-pressed", String(active));
    });
    renderRoutes();
    animateDirectory();
  }));
  els.directory.addEventListener("click", onDirectoryClick);

  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.routes = extractAllRoutes(data).map(normalizeRoute);
    renderRoutes();
  } catch (error) {
    els.count.textContent = "加载失败";
    els.directory.innerHTML = `<div class="empty-state"><div class="empty-state__icon">!</div><h3>线路数据加载失败</h3><p>请通过 GitHub Pages 或静态服务器访问。</p></div>`;
  }
}

// processed.json 把跨境线与境内线分两个大类存储；两类线路都要展示（兼容旧格式）
function extractAllRoutes(data) {
  const collect = (labels, lineType) => (Array.isArray(labels)
    ? labels.flatMap((label) => (label.routes || []).map((route) => annotateRoute(route, lineType, label)))
    : []);
  const routes = [
    ...collect(data?.cross_border?.labels, "cross_border"),
    ...collect(data?.domestic?.labels, "domestic"),
  ];
  if (routes.length) return routes;
  return (data?.routes || []).map((route) => annotateRoute(route, "cross_border"));
}

// kind 只区分上/下车，不表示区域：先按站点特征判断横琴，再按线路类型补齐（跨境→澳门，境内→珠海）
function annotateRoute(route, lineType, label) {
  const stops = (route.stops || []).map((stop) => ({ ...stop, region: inferStopRegion(stop, lineType) }));
  return {
    ...route,
    lineType,
    labelId: label?.label_id ?? null,
    labelName: label?.label_name || "",
    stops,
  };
}

function normalizeRoute(route) {
  const stops = route.stops || [];
  const firstRegion = stops[0]?.region || "1";
  const lastRegion = stops[stops.length - 1]?.region || firstRegion;
  return {
    ...route,
    stops,
    direction: `${firstRegion}-${lastRegion}`,
    firstRegion,
    lastRegion,
    searchText: `${route.route_name || ""} ${route.labelName || ""} ${stops.map((stop) => stop.name).join(" ")}`.toLocaleLowerCase("zh-CN"),
  };
}

// 同一线路可能有多个发车班次，用 uid（线路 ID + 发车时间）保证卡片与 DOM id 唯一
function routeKey(route) {
  return route?.uid || String(route?.id);
}

function renderRoutes() {
  const now = new Date();
  const routes = state.routes
    .filter((route) => {
      const matchesFilter = state.filter === "all" || route.direction === state.filter;
      const matchesSearch = !state.query || route.searchText.includes(state.query);
      return matchesFilter && matchesSearch;
    })
    .sort((a, b) => minutesUntilDeparture(a, now) - minutesUntilDeparture(b, now));
  els.count.textContent = `${routes.length} / ${state.routes.length} 条`;
  els.empty.hidden = routes.length > 0;
  els.directory.innerHTML = routes.map((route) => routeCardHtml(route, now)).join("");
}

function animateDirectory() {
  els.directory.classList.remove("is-refreshing");
  void els.directory.offsetWidth;
  els.directory.classList.add("is-refreshing");
}

// 距当前时间最近的实际发车排在最前；暂无发车计划的排最后
function minutesUntilDeparture(route, now) {
  if (route.has_schedule === false) return Number.POSITIVE_INFINITY;
  const info = nextDepartureInfo(route, route.stops[0]?.time, now);
  return info ? info.minutesUntil : Number.POSITIVE_INFINITY;
}

// 解析 YYYY-MM-DD（按本地日期构造，避免 new Date("YYYY-MM-DD") 被当成 UTC）
function parseDateKey(value) {
  const match = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function startOfDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthDayLabel(dateText) {
  const date = parseDateKey(dateText);
  return date ? `${date.getMonth() + 1}/${date.getDate()}` : "";
}

// 该班次在当前时间之后的下一次实际开行（dates 为该班次的开行日期，由接口提供）
function nextDepartureInfo(route, timeText, now = new Date()) {
  const departureMinutes = parseTime(timeText);
  if (departureMinutes == null) return null;
  const dates = Array.isArray(route?.dates) ? route.dates : [];
  if (!dates.length) return null;
  const today = startOfDay(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const dateText of [...dates].sort()) {
    const date = parseDateKey(dateText);
    if (!date) continue;
    const dayOffset = Math.round((date - today) / 86400000);
    if (dayOffset < 0) continue;
    // 当天的发车时间已过，则看下一个开行日期
    if (dayOffset === 0 && departureMinutes < nowMinutes) continue;
    return { dateText, dayOffset, minutesUntil: dayOffset * 1440 + departureMinutes - nowMinutes };
  }
  return null;
}

function routeCardHtml(route, now) {
  const detailsId = `route-${routeKey(route)}-${route.firstRegion}-${route.lastRegion}`;
  const first = route.stops[0];
  const last = route.stops[route.stops.length - 1];
  const dates = Array.isArray(route.dates) ? route.dates : [];
  const operatesToday = route.has_schedule !== false && dates.includes(todayKey(now));
  const status = route.has_schedule === false ? null : vehicleStatus(route.stops, now);
  const info = route.has_schedule === false ? null : nextDepartureInfo(route, first?.time, now);
  // 今天正在运行/未发车时显示实时状态；否则显示下一次实际发车的日期
  const liveToday = operatesToday && status && status.tone !== "is-finished";
  const chip = liveToday
    ? status
    : info
      ? {
          label: "未发车",
          detail: info.dayOffset === 1 ? "次日发车" : `${monthDayLabel(info.dateText)} 发车`,
          tone: "is-waiting",
        }
      : operatesToday && status
        ? { label: "今日已结束", detail: "无后续班次", tone: "is-finished" }
        : { label: "暂无发车计划", detail: "未来几天无班次", tone: "is-idle" };
  const startLabel = !info
    ? operatesToday && status
      ? "今日已结束"
      : "暂无发车计划"
    : info.dayOffset === 1
      ? "次日始发"
      : info.dayOffset > 1
        ? `${monthDayLabel(info.dateText)} 始发`
        : "始发";
  const showTime = Boolean(info) || operatesToday;
  const timeText = showTime ? first?.time || "--:--" : "--:--";
  const rangeText = info
    ? `${info.dayOffset > 0 ? `${monthDayLabel(info.dateText)} ` : ""}${first?.time || "--:--"} - ${last?.time || "--:--"}`
    : showTime
      ? `${first?.time || "--:--"} - ${last?.time || "--:--"}`
      : "暂无发车计划";
  const directionText = route.firstRegion === route.lastRegion
    ? `${regionLabel(route.firstRegion)}区域线路`
    : `${regionLabel(route.firstRegion)} → ${regionLabel(route.lastRegion)}`;
  return `<article class="directory-card" data-region="${route.firstRegion}">
    <button type="button" class="directory-card__summary" data-route-id="${routeKey(route)}" aria-expanded="false" aria-controls="${detailsId}">
      <span class="directory-card__time"><strong>${escapeHtml(timeText)}</strong><small>${escapeHtml(startLabel)}</small></span>
      <span class="directory-card__main">${route.labelName ? `<small class="directory-card__label">${escapeHtml(route.labelName)}</small>` : ""}<strong>${escapeHtml(route.route_name)}</strong><small>${escapeHtml(first?.name || "未知站点")} → ${escapeHtml(last?.name || "未知站点")}</small></span>
      <span class="direction-chip direction-chip--${route.firstRegion}">${directionText}</span>
      <span class="vehicle-chip ${chip.tone}"><strong>${escapeHtml(chip.label)}</strong><small>${escapeHtml(chip.detail)}</small></span>
      <span class="directory-card__meta"><strong>${route.stops.length}</strong><small>站</small></span>
      <span class="directory-card__expand" aria-hidden="true"></span>
    </button>
    <div class="directory-card__details" id="${detailsId}" data-range="${escapeHtml(rangeText)}" aria-hidden="true" inert>
      <div class="directory-card__details-inner">
        <div class="directory-card__details-body"></div>
      </div>
    </div>
  </article>`;
}

function stopHtml(stop, index, total) {
  const region = stop.region;
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
  const card = button.closest(".directory-card");
  const details = document.querySelector(`#${CSS.escape(button.getAttribute("aria-controls"))}`);
  const expanded = button.getAttribute("aria-expanded") === "true";
  const nextExpanded = !expanded;
  if (nextExpanded) renderDirectoryDetails(details, button.dataset.routeId);
  button.setAttribute("aria-expanded", String(nextExpanded));
  if (!details) return;
  details.inert = !nextExpanded;
  details.setAttribute("aria-hidden", String(!nextExpanded));
  if (nextExpanded) void details.offsetHeight;
  card?.classList.toggle("is-open", nextExpanded);
}

function renderDirectoryDetails(details, routeId) {
  if (!details || details.dataset.rendered === "1") return;
  const route = state.routes.find((item) => routeKey(item) === routeId);
  const body = details.querySelector(".directory-card__details-body");
  if (!route || !body) return;
  body.innerHTML = `<div class="directory-route-head"><span>线路编号 ${route.id}</span><strong>${escapeHtml(details.dataset.range || "")}</strong></div>
    <ol class="directory-timeline">${route.stops.map((stop, index) => stopHtml(stop, index, route.stops.length)).join("")}</ol>`;
  details.dataset.rendered = "1";
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

// 横琴岛大致范围：南端长隆、北端十字门、西端中医药产业园、东端横琴口岸
const HENGQIN_BBOX = { minLng: 113.43, maxLng: 113.562, minLat: 22.08, maxLat: 22.168 };
// 横琴特征名（只放明确属于横琴、且不会在珠海/澳门重名的地点）
const HENGQIN_NAME = /横琴|中医药产业园|琴海|金融岛|汇通|IFC|HFC|澳门新街坊|创新方|濠江路口|桂风道路口|开新三道|颂琴|富城道|海鸣桥|长隆|石山村|国际网球中心|粗沙环|中葡经贸|金汇国际|厚朴道|环岛|洋环|荔枝湾|华发首府|保利国际|中海名钻|琴朗|琴政/;
// 澳门特征名：跨境线中不属于横琴的站点都归入澳门
const MACAU_NAME = /澳门|澳大|澳旅|澳理|新濠|银河|威尼斯人|葡京|氹仔|关闸|亚马喇|筷子基|望德|林茂|赛马会|友谊马路|海上居|东北大马路|二龙喉|观音|鮑思高|巴波沙|沙梨头|海擎天|泉悦花园|连贯公路|机场大马路|排角|莲花|霍英东/;

function isWithinHengqin(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lng >= HENGQIN_BBOX.minLng && lng <= HENGQIN_BBOX.maxLng
    && lat >= HENGQIN_BBOX.minLat && lat <= HENGQIN_BBOX.maxLat;
}

function isHengqinStop(stop) {
  const name = String(stop?.name || "");
  if (name.includes("澳门新街坊")) return true;
  // “往横琴…”是行车方向描述（如珠海连屏），不代表站点在横琴境内
  if (name.includes("往横琴")) return false;
  if (HENGQIN_NAME.test(name)) return true;
  if (MACAU_NAME.test(name)) return false;
  return isWithinHengqin(Number(stop?.y), Number(stop?.x));
}

// 跨境线只往返横琴与澳门，境内线只往返横琴与珠海
function inferStopRegion(stop, lineType) {
  if (isHengqinStop(stop)) return "1";
  return lineType === "domestic" ? "3" : "2";
}

function regionLabel(region) {
  return { 1: "横琴", 2: "澳门", 3: "珠海" }[String(region)] || "未知";
}

function parseTime(value) {
  const match = typeof value === "string" ? value.match(/^(\d{1,2}):(\d{2})$/) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function minutesText(minutes) { return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}` : `${minutes}分钟`; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
