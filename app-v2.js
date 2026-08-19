const DATA_URL = "processed.json";
const MAX_DISTANCE_KM = 1;
const MAX_NEARBY_STATIONS = 5;
const MAX_DEPARTURES = 12;

const state = {
  data: null,
  stops: [],
  userPosition: null,
  currentRegion: null,
  selectedStops: [],
  destinationRegion: null,
  nearbyStops: [],
  availableStops: [],
  locationRequested: false,
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  updateClock();
  window.setInterval(() => {
    updateClock();
    renderDepartures();
  }, 30_000);

  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`数据加载失败（HTTP ${response.status}）`);
    state.data = await response.json();
    state.stops = buildStationCatalog(state.data.routes || []);
    els.locationHint.textContent = `共收录 ${state.stops.length} 个站点，定位后自动判断所在区域`;
    setLocationState("等待获取位置，也可以先手动选择所在区域", false);
    if (state.currentRegion) setCurrentRegion(state.currentRegion, false);
    requestLocation();
  } catch (error) {
    showFatalError(error);
  }
}

function cacheElements() {
  els.locateButton = document.querySelector("#locateButton");
  els.locationHint = document.querySelector("#locationHint");
  els.locationState = document.querySelector("#locationState");
  els.locationStateText = document.querySelector("#locationStateText");
  els.regionReason = document.querySelector("#regionReason");
  els.regionButtons = [...document.querySelectorAll("[data-region]")];
  els.stationGrid = document.querySelector("#stationGrid");
  els.nearbyEmpty = document.querySelector("#nearbyEmpty");
  els.retryLocationButton = document.querySelector("#retryLocationButton");
  els.stationPicker = document.querySelector("#stationPicker");
  els.stationPickerButton = document.querySelector("#stationPickerButton");
  els.stationPickerValue = document.querySelector("#stationPickerValue");
  els.stationPickerMenu = document.querySelector("#stationPickerMenu");
  els.stationPickerSearch = document.querySelector("#stationPickerSearch");
  els.stationPickerOptions = document.querySelector("#stationPickerOptions");
  els.selectedContext = document.querySelector("#selectedContext");
  els.departureDirectionNote = document.querySelector("#departureDirectionNote");
  els.departureList = document.querySelector("#departureList");
  els.departureEmpty = document.querySelector("#departureEmpty");
  els.currentTime = document.querySelector("#currentTime");
}

function bindEvents() {
  els.locateButton.addEventListener("click", () => requestLocation(true));
  els.retryLocationButton.addEventListener("click", () => requestLocation(true));
  els.regionButtons.forEach((button) => {
    button.addEventListener("click", () => setCurrentRegion(button.dataset.region, false));
  });
  els.stationPickerButton.addEventListener("click", toggleStationPicker);
  els.stationPickerSearch.addEventListener("input", () => renderStationPickerOptions(els.stationPickerSearch.value));
  els.stationPickerOptions.addEventListener("click", (event) => {
    const option = event.target.closest("[data-picker-stop]");
    if (!option) return;
    const stop = state.availableStops.find((item) => item.key === option.dataset.pickerStop);
    if (stop) toggleSelectedStop(stop);
  });
  document.addEventListener("click", (event) => {
    if (!els.stationPicker.contains(event.target)) closeStationPicker();
  });
  els.departureList.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-route-toggle]");
    if (!toggle) return;
    const details = document.querySelector(`#${CSS.escape(toggle.getAttribute("aria-controls"))}`);
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.querySelector("span:last-child").textContent = expanded ? "+" : "−";
    if (details) details.hidden = expanded;
  });
}

function buildStationCatalog(routes) {
  const map = new Map();
  routes.forEach((route) => {
    const direction = getRouteDirection(route);
    (route.stops || []).forEach((stop) => {
      const stopId = Number(stop.stop_id);
      const lat = Number(stop.y);
      const lng = Number(stop.x);
      if (!Number.isFinite(stopId) || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (!map.has(stopId)) {
        map.set(stopId, {
          stopId,
          name: cleanStopName(stop.name),
          stopIds: new Set([stopId]),
          lat,
          lng,
          region: inferRegion(stop),
          boardingDirections: new Set(),
        });
      }
      const station = map.get(stopId);
      station.stopIds.add(stopId);
      const cleanedName = cleanStopName(stop.name);
      if (cleanedName.length < station.name.length) station.name = cleanedName;
      if (direction && String(stop.kind) === "1") {
        map.get(stopId).boardingDirections.add(direction);
      }
    });
  });
  const merged = new Map();
  for (const stop of map.values()) {
    const key = `${stop.region}|${stop.name}`;
    if (!merged.has(key)) {
      merged.set(key, { ...stop, key, stopIds: new Set(stop.stopIds) });
    } else {
      const target = merged.get(key);
      stop.stopIds.forEach((id) => target.stopIds.add(id));
      stop.boardingDirections.forEach((direction) => target.boardingDirections.add(direction));
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function cleanStopName(name) {
  return String(name || "未命名站点").trim().replace(/[\s]*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]+[\s]*$/u, "").trim();
}

function getRouteDirection(route) {
  const stops = route.stops || [];
  if (stops.length < 2) return null;
  const boardingStops = stops.filter((stop) => String(stop.kind) === "1");
  const dropOffStops = stops.filter((stop) => String(stop.kind) === "2");
  const origin = inferRegion(boardingStops[0] || stops[0]);
  const destination = inferRegion(dropOffStops[dropOffStops.length - 1] || stops[stops.length - 1]);
  return origin !== destination ? `${origin}-${destination}` : null;
}

function requestLocation(force = false) {
  if (force) state.locationRequested = false;
  if (state.locationRequested) return;
  state.locationRequested = true;
  if (!navigator.geolocation) {
    showLocationError("当前浏览器不支持定位，请手动选择所在区域和站点。", true);
    return;
  }
  els.locateButton.disabled = true;
  els.locateButton.querySelector("strong").textContent = "正在获取位置…";
  setLocationState("正在获取你的位置信息", true);
  navigator.geolocation.getCurrentPosition(onLocationSuccess, onLocationError, {
    enableHighAccuracy: true,
    timeout: 12_000,
    maximumAge: 60_000,
  });
}

function onLocationSuccess(position) {
  state.locationRequested = false;
  state.userPosition = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
  };
  const nearest = state.stops
    .map((stop) => ({ ...stop, distanceKm: haversineKm(state.userPosition.lat, state.userPosition.lng, stop.lat, stop.lng) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  const inferredRegion = nearest?.region || inferRegionFromCoordinates(state.userPosition.lng);
  setCurrentRegion(inferredRegion, true);
  els.locateButton.disabled = false;
  els.locateButton.querySelector("strong").textContent = "刷新我的位置";
  setLocationState(`已定位 · ${state.userPosition.lat.toFixed(4)}, ${state.userPosition.lng.toFixed(4)}`, false);
  els.locationHint.textContent = `已判断你在${regionLabel(inferredRegion)}，附近站点按距离排序`;
}

function onLocationError(error) {
  state.locationRequested = false;
  const message = {
    1: "你拒绝了定位权限，请手动选择所在区域和站点。",
    2: "暂时无法确定位置，请稍后重试或手动选择。",
    3: "定位请求超时，请稍后重试或手动选择。",
  }[error.code] || "定位失败，请手动选择所在区域和站点。";
  showLocationError(message, true);
}

function showLocationError(message, keepManual) {
  els.locateButton.disabled = false;
  els.locateButton.querySelector("strong").textContent = "重新获取位置";
  els.locationHint.textContent = message;
  setLocationState(message, false);
  if (keepManual && state.currentRegion) refreshStationsForRegion();
}

function setCurrentRegion(region, automatic) {
  state.currentRegion = String(region);
  els.regionButtons.forEach((button) => button.classList.toggle("is-selected", button.dataset.region === state.currentRegion));
  els.regionReason.innerHTML = automatic
    ? `根据定位自动判断你当前在 <strong>${regionLabel(state.currentRegion)}</strong>，也可以手动切换`
    : `已手动选择当前在 <strong>${regionLabel(state.currentRegion)}</strong>`;
  state.destinationRegion = oppositeRegion(state.currentRegion);
  refreshStationsForRegion();
}

function refreshStationsForRegion() {
  if (!state.currentRegion) return;
  const direction = `${state.currentRegion}-${state.destinationRegion}`;
  const available = state.stops.filter((stop) => stop.region === state.currentRegion && stop.boardingDirections.has(direction));
  state.availableStops = available;
  renderStationPickerOptions();

  if (state.userPosition) {
    state.nearbyStops = available
      .map((stop) => ({ ...stop, distanceKm: haversineKm(state.userPosition.lat, state.userPosition.lng, stop.lat, stop.lng) }))
      .filter((stop) => stop.distanceKm <= MAX_DISTANCE_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_NEARBY_STATIONS);
  } else {
    state.nearbyStops = [];
  }
  renderNearbyStations();

  const selectedStillValid = state.selectedStops.filter((stop) => stop.region === state.currentRegion && stop.boardingDirections.has(direction));
  state.selectedStops = selectedStillValid;
  if (!state.selectedStops.length && state.nearbyStops.length) selectStop(state.nearbyStops[0], false);
  else {
    updateStationPickerValue();
    renderNearbyStations();
    renderDepartures();
  }
}

function renderNearbyStations() {
  els.stationGrid.innerHTML = state.nearbyStops.map((stop, index) => stationCardHtml(stop, index === 0)).join("");
  els.nearbyEmpty.hidden = !state.userPosition || state.nearbyStops.length > 0;
  els.nearbyEmpty.querySelector("h3").textContent = `${regionLabel(state.currentRegion)}附近暂无站点`;
  state.nearbyStops.forEach((stop) => {
    document.querySelector(`[data-nearby-stop="${CSS.escape(stop.key)}"]`)?.addEventListener("click", () => selectStop(stop, false));
  });
}

function stationCardHtml(stop, closest) {
  return `<button class="station-card${state.selectedStops.some((item) => item.key === stop.key) ? " is-selected" : ""}" type="button" data-nearby-stop="${stop.key}">
    <div class="station-card__top"><span class="station-kind ${stop.region === "2" ? "station-kind--macau" : ""}">${regionLabel(stop.region)}站点</span><span class="distance">${closest ? "最近 · " : ""}${formatDistance(stop.distanceKm)}</span></div>
    <h3>${escapeHtml(stop.name)}</h3>
    <div class="station-card__bottom"><span>可查询该站点班次</span><span class="station-card__check">✓</span></div>
  </button>`;
}

function selectStop(stop, scroll) {
  state.selectedStops = [stop];
  updateStationPickerValue();
  renderNearbyStations();
  renderDepartures();
  if (scroll) document.querySelector(".departures-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearSelectedStop() {
  state.selectedStops = [];
  updateStationPickerValue();
  els.selectedContext.textContent = "请选择上车站点";
  els.departureList.innerHTML = "";
  els.departureEmpty.hidden = false;
}

function toggleStationPicker() {
  const isOpen = els.stationPickerButton.getAttribute("aria-expanded") === "true";
  if (isOpen) closeStationPicker();
  else {
    els.stationPicker.classList.add("is-open");
    els.stationPickerButton.setAttribute("aria-expanded", "true");
    els.stationPickerMenu.hidden = false;
    els.stationPickerSearch.focus();
  }
}

function closeStationPicker() {
  els.stationPicker.classList.remove("is-open");
  els.stationPickerButton.setAttribute("aria-expanded", "false");
  els.stationPickerMenu.hidden = true;
}

function toggleSelectedStop(stop) {
  const exists = state.selectedStops.some((item) => item.key === stop.key);
  state.selectedStops = exists
    ? state.selectedStops.filter((item) => item.key !== stop.key)
    : [...state.selectedStops, stop];
  updateStationPickerValue();
  renderStationPickerOptions(els.stationPickerSearch.value);
  renderNearbyStations();
  renderDepartures();
}

function updateStationPickerValue() {
  if (!state.selectedStops.length) {
    els.stationPickerValue.textContent = "选择站点…";
    return;
  }
  els.stationPickerValue.textContent = state.selectedStops.length === 1
    ? state.selectedStops[0].name
    : `已选择 ${state.selectedStops.length} 个站点`;
}

function renderStationPickerOptions(query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const options = state.availableStops.filter((stop) => !normalizedQuery || stop.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  els.stationPickerOptions.innerHTML = options.length
    ? options.map((stop) => `<button class="station-picker__option${state.selectedStops.some((item) => item.key === stop.key) ? " is-selected" : ""}" type="button" data-picker-stop="${escapeHtml(stop.key)}"><span class="station-picker__check">✓</span><span>${escapeHtml(stop.name)}</span></button>`).join("")
    : `<div class="station-picker__empty">没有匹配的站点</div>`;
}

function renderDepartures() {
  if (state.currentRegion && els.departureDirectionNote) {
    els.departureDirectionNote.innerHTML = `${regionLabel(state.currentRegion)}上车 · 前往 <strong>${regionLabel(state.destinationRegion)}</strong>`;
  }
  if (!state.data || !state.selectedStops.length || !state.currentRegion || !state.destinationRegion) {
    els.selectedContext.textContent = state.currentRegion ? "请选择上车站点" : "请选择当前所在区域和上车站点";
    els.departureList.innerHTML = "";
    els.departureEmpty.hidden = false;
    return;
  }

  const nowMinutes = currentMinutes();
  const departures = [];
  const seenDepartures = new Set();
  (state.data.routes || []).forEach((route) => {
    if (getRouteDirection(route) !== `${state.currentRegion}-${state.destinationRegion}`) return;
    (route.stops || []).forEach((boardingStop, boardingIndex) => {
      const selectedStop = state.selectedStops.find((stop) => stop.stopIds.has(Number(boardingStop.stop_id)));
      if (!selectedStop) return;
      if (String(boardingStop.kind) !== "1") return;
      if (inferRegion(boardingStop) !== state.currentRegion) return;
      const departureMinutes = parseTime(boardingStop.time);
      if (departureMinutes == null) return;
      const departureKey = `${route.id}-${boardingStop.time}`;
      if (seenDepartures.has(departureKey)) return;
      const allowedStops = allowedDropOffStops(route.stops, boardingIndex, state.currentRegion, state.destinationRegion);
      if (!allowedStops.length) return;
      const isNextDay = departureMinutes < nowMinutes;
      const minutesUntil = isNextDay ? departureMinutes + 1440 - nowMinutes : departureMinutes - nowMinutes;
      seenDepartures.add(departureKey);
      departures.push({ route, boardingStop, boardingIndex, allowedStops, isNextDay, minutesUntil, selectedStop });
    });
  });
  departures.sort((a, b) => a.minutesUntil - b.minutesUntil);

  const selectedNames = state.selectedStops.map((stop) => escapeHtml(stop.name)).join("、");
  els.selectedContext.innerHTML = `从 <strong>${selectedNames}</strong> 出发 · ${regionLabel(state.currentRegion)} → ${regionLabel(state.destinationRegion)} · ${departures.length} 个班次`;
  els.departureEmpty.hidden = departures.length > 0;
  els.departureList.innerHTML = departures.slice(0, MAX_DEPARTURES).map(departureHtml).join("");
}

function allowedDropOffStops(stops, boardingIndex, currentRegion, destinationRegion) {
  let lastCurrentRegionIndex = boardingIndex;
  for (let index = boardingIndex; index < stops.length; index += 1) {
    if (inferRegion(stops[index]) === currentRegion) lastCurrentRegionIndex = index;
  }
  const destinationStops = stops.slice(lastCurrentRegionIndex + 1).filter((stop) => inferRegion(stop) === destinationRegion);
  return destinationStops;
}

function departureHtml(item, index) {
  const detailsId = `route-details-${item.route.id}-${item.boardingStop.stop_id}-${index}`;
  const status = vehicleStatus(item.route.stops, new Date(), item.isNextDay);
  const departureText = item.minutesUntil === 0 ? "即将发车" : `${item.minutesUntil} 分钟后`;
  const timeLabel = `${item.isNextDay ? "次日 " : ""}${item.boardingStop.time || "--:--"}`;
  return `<article class="departure-card departure-card--expanded${index === 0 ? " is-next" : ""}">
    <div class="departure-card__summary">
      <div class="departure-card__time"><strong>${escapeHtml(timeLabel)}</strong><small>${escapeHtml(item.route.route_name)}</small></div>
      <div class="departure-card__route"><strong>${escapeHtml(status.label)}</strong><span>${escapeHtml(status.detail)}</span></div>
      <div class="departure-card__countdown"><strong>${departureText}</strong><small>本站发车</small></div>
      <button class="route-toggle" type="button" data-route-toggle aria-expanded="${index === 0}" aria-controls="${detailsId}"><span>站点列表</span><span>${index === 0 ? "−" : "+"}</span></button>
    </div>
    <div class="route-details" id="${detailsId}" ${index === 0 ? "" : "hidden"}>
      <ol class="route-timeline">${routeTimelineHtml(item.route.stops, item.boardingIndex, item.allowedStops)}</ol>
    </div>
  </article>`;
}

function routeTimelineHtml(stops, boardingIndex, allowedStops) {
  const allowedIds = new Set(allowedStops.map((stop) => `${stop.stop_id}-${stop.time}`));
  return stops.map((stop, index) => {
    const isBoarding = index === boardingIndex;
    const canDropOff = allowedIds.has(`${stop.stop_id}-${stop.time}`);
    const region = inferRegion(stop);
    return `<li class="timeline-stop${isBoarding ? " is-boarding" : ""}${canDropOff ? " is-allowed" : ""}">
      <time>${escapeHtml(stop.time || "--:--")}</time><span class="timeline-dot"></span><div><strong>${escapeHtml(stop.name)}</strong><small>${regionLabel(region)}${isBoarding ? " · 上车" : canDropOff ? " · 可下车" : ""}</small></div>
    </li>`;
  }).join("");
}

function vehicleStatus(stops, now, isNextDay = false) {
  const nowValue = now.getHours() * 60 + now.getMinutes();
  const timed = stops.map((stop) => ({ stop, minutes: parseTime(stop.time) })).filter((item) => item.minutes != null);
  if (!timed.length) return { label: "时间待确认", detail: "线路时刻暂不可用" };
  if (isNextDay) return { label: "未发车", detail: `次日 ${timed[0].stop.name} 始发` };
  if (nowValue < timed[0].minutes) return { label: "未发车", detail: `${timed[0].stop.name} 始发` };
  if (nowValue >= timed[timed.length - 1].minutes) return { label: "已结束", detail: `已抵达 ${timed[timed.length - 1].stop.name}` };
  for (let index = 0; index < timed.length - 1; index += 1) {
    const current = timed[index];
    const next = timed[index + 1];
    if (nowValue === current.minutes) return { label: `在 ${current.stop.name}`, detail: `下一站 ${next.stop.name}` };
    if (nowValue > current.minutes && nowValue < next.minutes) return { label: `前往 ${next.stop.name}`, detail: `在 ${current.stop.name} 和 ${next.stop.name} 之间` };
  }
  return { label: "运行中", detail: "车辆正在行驶" };
}

function inferRegion(stop) {
  const name = String(stop?.name || "");
  const lng = Number(stop?.x);
  const hengqin = /横琴|中医药产业园|琴海|金融岛|汇通|市民中心|人才公寓|华发首府|保利国际|中海名钻|K2荔枝湾|上村|下村|琴政|琴朗|十字门|环岛北路|科创中心|洋环路|中葡经贸|中央汇|横琴医院|伯牙|金汇国际|澳门新街坊/;
  const macau = /澳门|澳大|澳旅|澳理|新濠|银河|威尼斯人|葡京|氹仔|关闸|亚马喇|筷子基|望德|林茂|赛马会|友谊马路|海上居|东北大马路|二龙喉|观音|鮑思高|巴波沙|沙梨头|海擎天|泉悦花园|连贯公路|机场大马路|排角/;
  if (hengqin.test(name)) return "1";
  if (macau.test(name)) return "2";
  return inferRegionFromCoordinates(lng);
}

function inferRegionFromCoordinates(lng) {
  return Number.isFinite(lng) && lng >= 113.55 ? "2" : "1";
}

function regionLabel(region) { return String(region) === "2" ? "澳门" : "横琴"; }
function oppositeRegion(region) { return String(region) === "1" ? "2" : "1"; }
function currentMinutes() { const now = new Date(); return now.getHours() * 60 + now.getMinutes(); }
function parseTime(value) {
  const match = typeof value === "string" ? value.match(/^(\d{1,2}):(\d{2})$/) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function updateClock() {
  if (els.currentTime) els.currentTime.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function setLocationState(message, loading) {
  els.locationState.hidden = false;
  els.locationStateText.textContent = message;
  els.locationState.querySelector(".location-state__icon").textContent = loading ? "◌" : "⌖";
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistance(km) { return km < 1 ? `${Math.round(km * 1000)} M` : `${km.toFixed(2)} KM`; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
function showFatalError(error) {
  els.locationHint.textContent = error.message || "页面数据加载失败";
  els.stationGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state__icon">!</div><h3>数据加载失败</h3><p>请通过 GitHub Pages 或静态服务器访问。</p></div>`;
}
