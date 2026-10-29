const state = {
  data: null,
  allRoutes: [],
  stops: [],
  userPosition: null,
  currentRegion: null,
  selectedOption: null,
  selectedStops: [],
  destinationRegions: [],
  nearbyStops: [],
  availableStops: [],
  selectedDropOffStops: [],
  availableDropOffStops: [],
  locationRequested: false,
  // 已展开的班次（用 uid 标识，跨定时刷新稳定）
  expandedDepartureUids: new Set(),
};

const els = {};
// 当前渲染的班次列表（展开卡片时按需取用站点时刻）
let renderedDepartures = [];
// 上一次渲染的班次 uid 顺序与结构签名，用于判断能否只做增量刷新
let renderedDepartureUids = [];
let renderedStructureKey = "";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  updateClock();
  window.setInterval(() => {
    updateClock();
    // 每 30 秒只刷新倒计时/车辆状态等动态字段，不重建列表
    renderDepartures({ liveOnly: true });
  }, 30_000);

  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`数据加载失败（HTTP ${response.status}）`);
    state.data = await response.json();
    state.allRoutes = extractAllRoutes(state.data);
    state.stops = buildStationCatalog(state.allRoutes);
    if (els.routesButtonHint) els.routesButtonHint.textContent = `${state.allRoutes.length} 条线路总览`;
    els.locationHint.textContent = `共收录 ${state.stops.length} 个站点，定位后自动判断所在区域`;
    setLocationState("等待获取位置，也可以先手动选择所在区域", false);
    if (state.currentRegion) setCurrentOption(state.selectedOption, false);
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
  els.regionButtons = [...document.querySelectorAll("[data-option]")];
  els.stationGrid = document.querySelector("#stationGrid");
  els.nearbyEmpty = document.querySelector("#nearbyEmpty");
  els.retryLocationButton = document.querySelector("#retryLocationButton");
  els.stationPicker = document.querySelector("#stationPicker");
  els.stationPickerButton = document.querySelector("#stationPickerButton");
  els.stationPickerValue = document.querySelector("#stationPickerValue");
  els.stationPickerMenu = document.querySelector("#stationPickerMenu");
  els.stationPickerSearch = document.querySelector("#stationPickerSearch");
  els.stationPickerOptions = document.querySelector("#stationPickerOptions");
  els.manualDropOffWrap = document.querySelector("#manualDropOffWrap");
  els.dropOffPicker = document.querySelector("#dropOffPicker");
  els.dropOffPickerButton = document.querySelector("#dropOffPickerButton");
  els.dropOffPickerValue = document.querySelector("#dropOffPickerValue");
  els.dropOffPickerMenu = document.querySelector("#dropOffPickerMenu");
  els.dropOffPickerSearch = document.querySelector("#dropOffPickerSearch");
  els.dropOffPickerOptions = document.querySelector("#dropOffPickerOptions");
  els.quickButtons = [...document.querySelectorAll("[data-quick]")];
  els.selectedContext = document.querySelector("#selectedContext");
  els.departureDirectionNote = document.querySelector("#departureDirectionNote");
  els.departureList = document.querySelector("#departureList");
  els.departureEmpty = document.querySelector("#departureEmpty");
  els.currentTime = document.querySelector("#currentTime");
  els.routesButtonHint = document.querySelector("#routesButtonHint");
}

function bindEvents() {
  els.locateButton.addEventListener("click", () => requestLocation(true));
  els.retryLocationButton.addEventListener("click", () => requestLocation(true));
  els.regionButtons.forEach((button) => {
    button.addEventListener("click", () => setCurrentOption(button.dataset.option, false));
  });
  els.quickButtons.forEach((button) => {
    button.addEventListener("click", () => quickSelect(button.dataset.quick));
  });
  els.stationPickerButton.addEventListener("click", toggleStationPicker);
  els.stationPickerSearch.addEventListener("input", () => renderStationPickerOptions(els.stationPickerSearch.value));
  els.stationPickerOptions.addEventListener("click", (event) => {
    const option = event.target.closest("[data-picker-stop]");
    if (!option) return;
    const stop = state.availableStops.find((item) => item.key === option.dataset.pickerStop);
    if (!stop) return;
    const clickedCheck = event.target.closest(".station-picker__check") || event.target.closest(".station-picker__option") === option && event.offsetX <= 34;
    if (clickedCheck) event.stopPropagation();
    toggleSelectedStop(stop);
    if (!clickedCheck) closeStationPicker();
  });
  document.addEventListener("click", (event) => {
    if (!els.stationPicker.contains(event.target)) closeStationPicker();
    if (!els.dropOffPicker.contains(event.target)) closeDropOffPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const stationOpen = els.stationPickerButton.getAttribute("aria-expanded") === "true";
    const dropOffOpen = els.dropOffPickerButton.getAttribute("aria-expanded") === "true";
    if (stationOpen) els.stationPickerButton.focus({ preventScroll: true });
    else if (dropOffOpen) els.dropOffPickerButton.focus({ preventScroll: true });
    closeStationPicker();
    closeDropOffPicker();
  });
  els.dropOffPickerButton.addEventListener("click", toggleDropOffPicker);
  els.dropOffPickerSearch.addEventListener("input", () => renderDropOffPickerOptions(els.dropOffPickerSearch.value));
  els.dropOffPickerOptions.addEventListener("click", (event) => {
    const option = event.target.closest("[data-dropoff-stop]");
    if (!option) return;
    const stop = state.availableDropOffStops.find((item) => item.key === option.dataset.dropoffStop);
    if (!stop) return;
    const clickedCheck = event.target.closest(".station-picker__check") || event.target.closest(".station-picker__option") === option && event.offsetX <= 34;
    if (clickedCheck) event.stopPropagation();
    toggleSelectedDropOffStop(stop);
    if (!clickedCheck) closeDropOffPicker();
  });
  els.departureList.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-departure-toggle]");
    if (!toggle) return;
    const card = toggle.closest(".departure-card");
    const details = document.querySelector(`#${CSS.escape(toggle.getAttribute("aria-controls"))}`);
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    const nextExpanded = !expanded;
    toggle.setAttribute("aria-expanded", String(nextExpanded));
    const item = renderedDepartures[Number(card?.dataset.departureIndex)];
    if (item) {
      const uid = departureUid(item);
      if (nextExpanded) state.expandedDepartureUids.add(uid);
      else state.expandedDepartureUids.delete(uid);
    }
    if (!details) return;
    if (nextExpanded) renderTimeline(details);
    details.inert = !nextExpanded;
    details.setAttribute("aria-hidden", String(!nextExpanded));
    if (nextExpanded) void details.offsetHeight;
    card?.classList.toggle("departure-card--expanded", nextExpanded);
    card?.classList.toggle("is-open", nextExpanded);
  });
}

// processed.json 把跨境线与境内线分两个大类存储；两类线路都参与查询（兼容旧格式）
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
  const originRegion = stops[0]?.region || null;
  const destinationRegion = stops[stops.length - 1]?.region || null;
  const direction = originRegion && destinationRegion && originRegion !== destinationRegion
    ? `${originRegion}-${destinationRegion}`
    : null;
  return {
    ...route,
    lineType,
    labelId: label?.label_id ?? null,
    labelName: label?.label_name || "",
    stops,
    originRegion,
    destinationRegion,
    direction,
  };
}

function buildStationCatalog(routeEntries) {
  const map = new Map();
  routeEntries.forEach((route) => {
    // 暂无发车计划的线路不计入站点目录（否则会推荐没有班次可上的站点）
    if (route.has_schedule === false || !route.direction) return;
    const direction = route.direction;
    const originRegion = route.originRegion;
    // 口岸站短途只适用于跨境线；境内线不设口岸站上车
    const entry = route.lineType === "cross_border" ? findEntryPortStop(route) : null;
    (route.stops || []).forEach((stop, stopIndex) => {
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
          region: stop.region,
          boardingDirections: new Set(),
          entryBoardingDirections: new Set(),
        });
      }
      const station = map.get(stopId);
      station.stopIds.add(stopId);
      const cleanedName = cleanStopName(stop.name);
      if (cleanedName.length < station.name.length) station.name = cleanedName;
      if (String(stop.kind) === "1" && stop.region === originRegion) {
        station.boardingDirections.add(direction);
      }
      // 对岸首个站点（口岸站）：按线路自身方向记录，可在对岸区域内短途下车
      if (entry && stopIndex === entry.index) {
        station.entryBoardingDirections.add(direction);
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
      stop.entryBoardingDirections.forEach((direction) => target.entryBoardingDirections.add(direction));
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

// 仅清理接口数据中的平台序号标记与尾部标点（格式差异），不做任何站名映射
function cleanStopName(name) {
  return String(name || "未命名站点")
    .trim()
    .replace(/[\s]*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]+[\s]*$/u, "")
    .replace(/[\s.。．·]+$/u, "")
    .trim();
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
  const inferredRegion = nearest?.region || inferRegionFromCoordinates(state.userPosition.lat, state.userPosition.lng);
  setCurrentOption(defaultOptionForRegion(inferredRegion), true);
  els.locateButton.disabled = false;
  els.locateButton.querySelector("strong").textContent = "刷新当前位置";
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

function setCurrentOption(option, automatic) {
  const [originRegion, destinationRegion] = String(option || "").split("-");
  if (!originRegion || !destinationRegion) return;
  state.selectedOption = `${originRegion}-${destinationRegion}`;
  state.currentRegion = originRegion;
  state.destinationRegions = [destinationRegion];
  els.regionButtons.forEach((button) => {
    const active = button.dataset.option === state.selectedOption;
    button.classList.toggle("is-selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  els.regionReason.innerHTML = automatic
    ? `根据定位自动判断你当前在 <strong>${regionLabel(originRegion)}</strong>，已选择「${regionLabel(originRegion)} → ${regionLabel(destinationRegion)}」，也可以手动切换`
    : `已选择「${regionLabel(originRegion)} → ${regionLabel(destinationRegion)}」`;
  refreshStationsForRegion();
}

function refreshStationsForRegion() {
  if (!state.currentRegion) return;
  const directions = allowedDirections();
  // 可上车站点 = 本区域的普通上车站 + 对岸口岸站（线路进入对岸后的首站）
  const available = state.stops.filter((stop) => (stop.region === state.currentRegion || state.destinationRegions.includes(stop.region)) && canBoardToAny(stop, directions));
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

  const selectedStillValid = state.selectedStops.filter((stop) => (stop.region === state.currentRegion || state.destinationRegions.includes(stop.region)) && canBoardToAny(stop, directions));
  state.selectedStops = selectedStillValid;
  if (!state.selectedStops.length && state.nearbyStops.length) selectStop(state.nearbyStops[0], false);
  else {
    updateStationPickerValue();
    renderNearbyStations();
    computeAvailableDropOffStops();
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
  const selected = state.selectedStops.some((item) => item.key === stop.key);
  return `<button class="station-card${selected ? " is-selected" : ""}" type="button" aria-pressed="${selected}" data-region="${stop.region}" data-nearby-stop="${stop.key}">
    <div class="station-card__top"><span class="station-kind">${regionLabel(stop.region)}站点</span><span class="distance">${closest ? "最近 · " : ""}${formatDistance(stop.distanceKm)}</span></div>
    <h3>${escapeHtml(stop.name)}</h3>
    <span class="station-card__check">✓</span>
  </button>`;
}

function selectStop(stop, scroll) {
  state.selectedStops = [stop];
  updateStationPickerValue();
  syncNearbySelection();
  syncPickerSelection(els.stationPickerOptions, "data-picker-stop", state.selectedStops);
  computeAvailableDropOffStops();
  renderDepartures();
  if (scroll) scrollToDepartures();
}

function scrollToDepartures() {
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  document.querySelector(".departures-section")?.scrollIntoView({ behavior, block: "start" });
}

function toggleStationPicker() {
  const isOpen = els.stationPickerButton.getAttribute("aria-expanded") === "true";
  if (isOpen) closeStationPicker();
  else openPickerMenu(els.stationPicker, els.stationPickerButton, els.stationPickerMenu, els.stationPickerSearch);
}

function closeStationPicker() {
  closePickerMenu(els.stationPicker, els.stationPickerButton, els.stationPickerMenu);
}

const PICKER_CLOSE_DELAY = 240;

function openPickerMenu(picker, button, menu, search) {
  clearTimeout(menu._hideTimer);
  picker.classList.remove("is-closing");
  picker.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  requestAnimationFrame(() => {
    if (button.getAttribute("aria-expanded") !== "true") return;
    menu.classList.add("is-shown");
    search?.focus({ preventScroll: true });
  });
}

function closePickerMenu(picker, button, menu) {
  if (button.getAttribute("aria-expanded") !== "true") return;
  picker.classList.remove("is-open");
  picker.classList.add("is-closing");
  button.setAttribute("aria-expanded", "false");
  menu.classList.remove("is-shown");
  clearTimeout(menu._hideTimer);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  menu._hideTimer = setTimeout(() => {
    menu.hidden = true;
    picker.classList.remove("is-closing");
  }, reduceMotion ? 0 : PICKER_CLOSE_DELAY);
}

function toggleSelectedStop(stop) {
  const exists = state.selectedStops.some((item) => item.key === stop.key);
  state.selectedStops = exists
    ? state.selectedStops.filter((item) => item.key !== stop.key)
    : [...state.selectedStops, stop];
  updateStationPickerValue();
  syncPickerSelection(els.stationPickerOptions, "data-picker-stop", state.selectedStops);
  syncNearbySelection();
  computeAvailableDropOffStops();
  renderDepartures();
}

function syncNearbySelection() {
  document.querySelectorAll(".station-card[data-nearby-stop]").forEach((card) => {
    const selected = state.selectedStops.some((stop) => stop.key === card.dataset.nearbyStop);
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  });
}

function syncPickerSelection(container, attribute, selectedStops) {
  container.querySelectorAll(`[${attribute}]`).forEach((option) => {
    const selected = selectedStops.some((stop) => stop.key === option.getAttribute(attribute));
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-pressed", String(selected));
  });
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
    ? options.map((stop) => `<button class="station-picker__option${state.selectedStops.some((item) => item.key === stop.key) ? " is-selected" : ""}" type="button" aria-pressed="${state.selectedStops.some((item) => item.key === stop.key)}" data-picker-stop="${escapeHtml(stop.key)}"><span class="station-picker__check">✓</span><span>${escapeHtml(stop.name)}</span></button>`).join("")
    : `<div class="station-picker__empty">没有匹配的站点</div>`;
}

function toggleDropOffPicker() {
  const isOpen = els.dropOffPickerButton.getAttribute("aria-expanded") === "true";
  if (isOpen) closeDropOffPicker();
  else openPickerMenu(els.dropOffPicker, els.dropOffPickerButton, els.dropOffPickerMenu, els.dropOffPickerSearch);
}

function closeDropOffPicker() {
  closePickerMenu(els.dropOffPicker, els.dropOffPickerButton, els.dropOffPickerMenu);
}

function computeAvailableDropOffStops() {
  if (!state.selectedStops.length) {
    state.availableDropOffStops = [];
    state.selectedDropOffStops = [];
    if (els.manualDropOffWrap) els.manualDropOffWrap.hidden = true;
    updateDropOffPickerValue();
    renderDropOffPickerOptions();
    return;
  }
  if (els.manualDropOffWrap) els.manualDropOffWrap.hidden = false;
  const reachableKeys = new Set();
  state.allRoutes.forEach((route) => {
    if (route.has_schedule === false || !route.direction) return;
    const [originRegion, destinationRegion] = route.direction.split("-");
    if (originRegion !== state.currentRegion || !state.destinationRegions.includes(destinationRegion)) return;
    // 本区域上车站：下车点为本区域之后的全部对岸站点
    (route.stops || []).forEach((boardingStop, boardingIndex) => {
      if (String(boardingStop.kind) !== "1" || boardingStop.region !== originRegion) return;
      if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(boardingStop.stop_id)))) return;
      allowedDropOffStops(route.stops, boardingIndex, originRegion, destinationRegion).forEach((dropStop) => {
        reachableKeys.add(stopKeyFromRaw(dropStop));
      });
    });
    // 口岸站（跨境线进入对岸后的首个站点）：下车点为该站之后的对岸站点
    if (route.lineType !== "cross_border") return;
    const entry = findEntryPortStop(route);
    if (!entry) return;
    if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(entry.stop.stop_id)))) return;
    entryAllowedStops(route.stops, entry.index, destinationRegion).forEach((dropStop) => {
      reachableKeys.add(stopKeyFromRaw(dropStop));
    });
  });
  state.availableDropOffStops = state.stops.filter((stop) => reachableKeys.has(stop.key));
  const stillValid = state.selectedDropOffStops.filter((stop) => state.availableDropOffStops.some((av) => av.key === stop.key));
  state.selectedDropOffStops = stillValid;
  updateDropOffPickerValue();
  renderDropOffPickerOptions();
}

function toggleSelectedDropOffStop(stop) {
  const exists = state.selectedDropOffStops.some((item) => item.key === stop.key);
  state.selectedDropOffStops = exists
    ? state.selectedDropOffStops.filter((item) => item.key !== stop.key)
    : [...state.selectedDropOffStops, stop];
  updateDropOffPickerValue();
  syncPickerSelection(els.dropOffPickerOptions, "data-dropoff-stop", state.selectedDropOffStops);
  renderDepartures();
}

function updateDropOffPickerValue() {
  if (!state.selectedDropOffStops.length) {
    els.dropOffPickerValue.textContent = "全部站点…";
    return;
  }
  els.dropOffPickerValue.textContent = state.selectedDropOffStops.length === 1
    ? state.selectedDropOffStops[0].name
    : `已选择 ${state.selectedDropOffStops.length} 个下车站`;
}

function renderDropOffPickerOptions(query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const options = state.availableDropOffStops.filter((stop) => !normalizedQuery || stop.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  els.dropOffPickerOptions.innerHTML = options.length
    ? options.map((stop) => `<button class="station-picker__option${state.selectedDropOffStops.some((item) => item.key === stop.key) ? " is-selected" : ""}" type="button" aria-pressed="${state.selectedDropOffStops.some((item) => item.key === stop.key)}" data-dropoff-stop="${escapeHtml(stop.key)}"><span class="station-picker__check">✓</span><span>${escapeHtml(stop.name)}</span>${dropOffRegionTag(stop)}</button>`).join("")
    : `<div class="station-picker__empty">没有匹配的站点</div>`;
}

// 下车点不属于所选目的地区域时（例如跨区短途），用标签标注所在区域
function dropOffRegionTag(stop) {
  return state.destinationRegions.includes(stop.region)
    ? ""
    : `<span class="station-picker__tag station-picker__tag--${stop.region}">${regionLabel(stop.region)}境内</span>`;
}

function stopKeyFromRaw(stop) {
  return `${stop.region}|${cleanStopName(stop.name)}`;
}

// 快速选择预设：option 为出行方向（起点-终点）；boardingPattern 为 null 时上车点取附近站点；portBoarding 表示只选口岸上车站点
const QUICK_PRESETS = {
  "university-to-uma": { option: "1-2", boardingPattern: /澳门新街坊|荔枝湾|横琴检察院（往口岸）/, dropPattern: /澳大/ },
  "uma-to-university": { option: "2-1", boardingPattern: /澳大/, dropPattern: /澳门新街坊|荔枝湾/ },
  "nearby-to-uma": { option: "1-2", boardingPattern: null, dropPattern: /澳大/ },
  "nearby-to-university": { option: "2-1", boardingPattern: null, dropPattern: /澳门新街坊|荔枝湾/ },
  "port-to-macau": { option: "1-2", portBoarding: true },
  "port-to-hengqin": { option: "2-1", portBoarding: true },
};

// 口岸站（跨境线进入对岸后的首站）：按区域与方向结构判定，不依赖站名
function portBoardingStops() {
  const directions = allowedDirections();
  return state.availableStops.filter((stop) => state.destinationRegions.includes(stop.region)
    && directions.some((direction) => stop.entryBoardingDirections.has(direction)));
}

function quickSelect(mode) {
  const preset = QUICK_PRESETS[mode];
  if (!state.data || !preset) return;
  const useNearbyStops = !preset.boardingPattern && !preset.portBoarding;

  if (useNearbyStops && !state.userPosition) {
    els.locationHint.textContent = "「附近」快速选择需要定位：请允许定位权限或点击「刷新当前位置」后重试";
    requestLocation(true);
    return;
  }
  setCurrentOption(preset.option, false);
  if (preset.portBoarding) {
    state.selectedStops = portBoardingStops();
    if (!state.selectedStops.length) {
      els.locationHint.textContent = "当前方向没有可上车的口岸站点，请手动选择上车站点";
      return;
    }
  } else if (useNearbyStops) {
    if (!state.nearbyStops.length) {
      els.locationHint.textContent = `附近 ${MAX_DISTANCE_KM} 公里内没有可上车的站点，请手动选择上车站点`;
      return;
    }
    state.selectedStops = state.nearbyStops.slice(0, MAX_NEARBY_STATIONS);
  } else {
    state.selectedStops = state.availableStops.filter((stop) => preset.boardingPattern.test(stop.name));
  }
  // 下车站：预设了 dropPattern 才预选，否则保持默认全部站点
  state.selectedDropOffStops = preset.dropPattern
    ? state.stops.filter((stop) => state.destinationRegions.includes(stop.region) && preset.dropPattern.test(stop.name))
    : [];
  updateStationPickerValue();
  renderStationPickerOptions();
  syncNearbySelection();
  computeAvailableDropOffStops();
  renderDepartures();
  scrollToDepartures();
}

function renderDepartures({ liveOnly = false } = {}) {
  const directions = state.currentRegion ? allowedDirections() : [];
  const hasDirection = directions.length > 0;
  const hasNormalBoarding = hasDirection && state.selectedStops.some((stop) => directions.some((direction) => stop.boardingDirections.has(direction)));
  const hasEntryBoarding = hasDirection && state.selectedStops.some((stop) => directions.some((direction) => stop.entryBoardingDirections.has(direction)));
  if (hasDirection && els.departureDirectionNote) {
    const forwardNote = `${regionLabel(state.currentRegion)}上车 · 前往 <strong>${destinationLabel()}</strong>`;
    if (!hasEntryBoarding) els.departureDirectionNote.innerHTML = forwardNote;
    else if (hasNormalBoarding) els.departureDirectionNote.innerHTML = `${forwardNote} · 另含口岸站短途班次`;
    else els.departureDirectionNote.innerHTML = `口岸站上车 · 短途前往 <strong>${destinationLabel()}</strong>（限${destinationLabel()}境内下车）`;
  }
  if (!state.data || !state.selectedStops.length || !hasDirection) {
    els.selectedContext.textContent = state.currentRegion ? "请选择上车站点" : "请选择当前所在区域和上车站点";
    els.departureList.innerHTML = "";
    els.departureEmpty.hidden = false;
    renderedDepartures = [];
    renderedDepartureUids = [];
    renderedStructureKey = "";
    return;
  }

  const now = new Date();
  const departures = buildDepartures(now);
  const structureKey = departures.map(departureStructureKey).join("||");

  // 定时刷新：班次结构没变时只更新倒计时/车辆状态，保留展开状态、时间轴与滚动位置
  if (liveOnly && structureKey === renderedStructureKey) {
    renderedDepartures = departures;
    updateDepartureLiveFields(departures, now);
    return;
  }

  const selectedNames = state.selectedStops.map((stop) => escapeHtml(stop.name)).join("、");
  let contextText = `从 <strong>${selectedNames}</strong> 出发`;
  if (state.selectedDropOffStops.length) {
    const dropOffNames = state.selectedDropOffStops.map((stop) => escapeHtml(stop.name)).join("、");
    contextText += ` · 到 <strong>${dropOffNames}</strong> 下车`;
  }
  const entryCount = departures.filter((item) => item.isEntry).length;
  contextText += ` · ${scopeSummary(departures.length - entryCount, entryCount)} · ${departures.length} 个班次`;
  els.selectedContext.innerHTML = contextText;
  els.departureEmpty.hidden = departures.length > 0;

  const uids = departures.map((item) => departureUid(item));
  const sameList = uids.length === renderedDepartureUids.length && uids.every((uid, index) => uid === renderedDepartureUids[index]);
  const keptExpanded = new Set([...state.expandedDepartureUids].filter((uid) => uids.includes(uid)));
  if (!sameList && !liveOnly) {
    // 用户切换了站点/筛选条件：视为新的一批班次，默认展开第一条
    state.expandedDepartureUids = new Set(uids.length ? [uids[0]] : []);
  } else {
    // 定时刷新或同一批班次重绘：保留用户已有的展开状态
    if (!keptExpanded.size && uids.length) keptExpanded.add(uids[0]);
    state.expandedDepartureUids = keptExpanded;
  }

  renderedDepartures = departures;
  renderedDepartureUids = uids;
  renderedStructureKey = structureKey;
  els.departureList.innerHTML = departures
    .map((item, index) => departureHtml(item, index, state.expandedDepartureUids.has(departureUid(item)), now))
    .join("");
}

function buildDepartures(now) {
  const routeDepartures = new Map();
  state.allRoutes.forEach((route) => {
    // 未来几天没有发车计划的线路不参与班次查询
    if (route.has_schedule === false || !route.direction) return;
    const [originRegion, destinationRegion] = route.direction.split("-");
    if (originRegion !== state.currentRegion || !state.destinationRegions.includes(destinationRegion)) return;
    // 本区域上车站：下车点为本区域之后的全部对岸站点
    (route.stops || []).forEach((boardingStop, boardingIndex) => {
      if (String(boardingStop.kind) !== "1" || boardingStop.region !== originRegion) return;
      if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(boardingStop.stop_id)))) return;
      const allowedStops = allowedDropOffStops(route.stops, boardingIndex, originRegion, destinationRegion);
      if (!allowedStops.length || !matchesDropOffFilter(allowedStops)) return;
      addBoardingLeg(routeDepartures, route, boardingStop, boardingIndex, allowedStops, now, false);
    });
    // 口岸站（仅跨境线）：线路进入对岸后的首个站点可上车，限对岸区域内短途下车
    if (route.lineType !== "cross_border") return;
    const entry = findEntryPortStop(route);
    if (!entry) return;
    if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(entry.stop.stop_id)))) return;
    const entryStops = entryAllowedStops(route.stops, entry.index, destinationRegion);
    if (!entryStops.length || !matchesDropOffFilter(entryStops)) return;
    addBoardingLeg(routeDepartures, route, entry.stop, entry.index, entryStops, now, true);
  });
  return [...routeDepartures.values()].sort((a, b) => a.minutesUntil - b.minutesUntil);
}

// 班次卡片的结构签名：签名不变时无需重建 DOM
function departureUid(item) {
  return `${routeKey(item.route)}@${item.dateText}`;
}

function departureStructureKey(item) {
  const legs = item.boardingStops.map((leg) => `${leg.stop.time}@${leg.dateText}`).join(",");
  return `${departureUid(item)}|${legs}|${item.isEntry ? "entry" : "normal"}`;
}

// 只更新随时间变化的文本，不触碰卡片结构
function updateDepartureLiveFields(departures, now) {
  departures.forEach((item, index) => {
    const card = els.departureList.querySelector(`[data-departure-index="${index}"]`);
    if (!card) return;
    const statusEl = card.querySelector('[data-live="status"]');
    if (statusEl) statusEl.textContent = departureStatusLabel(item, now);
    const countdownEl = card.querySelector('[data-live="countdown"]');
    if (countdownEl) countdownEl.textContent = departureCountdownLabel(item);
    const vehicleEl = card.querySelector(".vehicle-chip");
    if (vehicleEl) {
      vehicleEl.classList.remove("is-running", "is-waiting", "is-finished", "is-idle");
      vehicleEl.classList.add(departureVehicleTone(item, now));
    }
    card.classList.toggle("is-next", index === 0);
  });
}

function departureVehicleTone(item, now) {
  const status = departureStatusLabel(item, now);
  if (status === "时间待确认") return "is-idle";
  if (status === "已结束") return "is-finished";
  if (status === "未发车") return "is-waiting";
  return "is-running";
}

function departureStatusLabel(item, now) {
  return item.dayOffset === 0 ? vehicleStatus(item.route.stops, now) : "未发车";
}

// 倒计时统一显示分钟数；item.minutesUntil 已取同卡片多个上车站点中最近的时间
function departureCountdownLabel(item) {
  if (item.dayOffset > 0) return `${item.dayOffset} 天后`;
  return `${item.minutesUntil} 分钟后`;
}

function scopeSummary(forwardCount, entryCount) {
  const current = regionLabel(state.currentRegion);
  if (entryCount && !forwardCount) return `口岸站上车 · ${destinationLabel()}境内`;
  if (entryCount) return `${current} → ${destinationLabel()} · 含 ${entryCount} 个口岸站短途班次`;
  return `${current} → ${destinationLabel()}`;
}

function allowedDropOffStops(stops, boardingIndex, currentRegion, destinationRegion) {
  let lastCurrentRegionIndex = boardingIndex;
  for (let index = boardingIndex; index < stops.length; index += 1) {
    if (stops[index].region === currentRegion) lastCurrentRegionIndex = index;
  }
  return stops.slice(lastCurrentRegionIndex + 1).filter((stop) => stop.region === destinationRegion);
}

// 线路进入对岸后的第一个站点（口岸站）：该站允许上车，乘客可在对岸区域内后续站点下车
function findEntryPortStop(route) {
  const stops = route?.stops || [];
  const destinationRegion = route?.destinationRegion;
  if (!destinationRegion) return null;
  const index = stops.findIndex((stop) => stop.region === destinationRegion);
  return index >= 0 ? { stop: stops[index], index } : null;
}

function entryAllowedStops(stops, entryIndex, region) {
  return stops.slice(entryIndex + 1).filter((stop) => stop.region === region);
}

function matchesDropOffFilter(allowedStops) {
  if (!state.selectedDropOffStops.length) return true;
  const selectedDropOffKeys = new Set(state.selectedDropOffStops.map((stop) => stop.key));
  return allowedStops.some((dropStop) => selectedDropOffKeys.has(stopKeyFromRaw(dropStop)));
}

// 同一线路可能有多个发车班次，用 uid（线路 ID + 发车时间）区分，避免班次被合并成一张卡片
function routeKey(route) {
  return route?.uid || String(route?.id);
}

// 解析 YYYY-MM-DD（按本地日期构造，避免 new Date("YYYY-MM-DD") 被当成 UTC）
function parseDateKey(value) {
  const match = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function startOfDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

// 同一线路在本区域可能有多个可上车站点，合并为一张卡片（时间列显示“07:32 或 07:36”）
function addBoardingLeg(routeDepartures, route, boardingStop, boardingIndex, allowedStops, now, isEntry) {
  const info = nextDepartureInfo(route, boardingStop.time, now);
  if (!info) return;
  const leg = {
    stop: boardingStop,
    index: boardingIndex,
    dateText: info.dateText,
    dayOffset: info.dayOffset,
    minutesUntil: info.minutesUntil,
  };
  const cardKey = `${routeKey(route)}@${info.dateText}`;
  // 同一线路可能同时出现今天/次日班次，按服务日期拆成独立卡片
  let item = routeDepartures.get(cardKey);
  if (!item) {
    item = {
      route,
      dateText: info.dateText,
      boardingStops: [],
      boardingIndexes: [],
      allowedStops: [],
      minutesUntil: leg.minutesUntil,
      dayOffset: leg.dayOffset,
      isEntry,
    };
    routeDepartures.set(cardKey, item);
  } else if (!isEntry) {
    // 同一班次同时含本区域上车点时，按普通班次展示
    item.isEntry = false;
  }
  if (item.boardingStops.some((existing) => existing.stop.time === leg.stop.time)) return;
  item.boardingStops.push(leg);
  item.boardingIndexes.push(boardingIndex);
  mergeStopList(item.allowedStops, allowedStops);
  if (leg.minutesUntil < item.minutesUntil) {
    item.minutesUntil = leg.minutesUntil;
    item.dayOffset = leg.dayOffset;
  }
}

function mergeStopList(target, stops) {
  const seen = new Set(target.map((stop) => `${stop.stop_id}-${stop.time}`));
  stops.forEach((stop) => {
    const key = `${stop.stop_id}-${stop.time}`;
    if (seen.has(key)) return;
    seen.add(key);
    target.push(stop);
  });
}

function departureHtml(item, index, expanded, now) {
  const detailsId = `route-details-${routeKey(item.route)}-${index}`;
  const dayPrefix = (leg) => (leg.dayOffset === 1
    ? '<span class="departure-card__day">次日</span> '
    : leg.dayOffset > 1
      ? `<span class="departure-card__day">${escapeHtml(monthDayLabel(leg.dateText))}</span> `
      : "");
  const boardingDayPrefix = (leg) => (leg.dayOffset === 1 ? "次日 " : leg.dayOffset > 1 ? `${monthDayLabel(leg.dateText)} ` : "");
  const timeLabel = item.boardingStops
    .map((leg) => `${dayPrefix(leg)}${escapeHtml(leg.stop.time || "--:--")}`)
    .join(' <span class="departure-card__or">或</span><br>');
  const routeStops = item.route.stops || [];
  const routePath = `${escapeHtml(routeStops[0]?.name || "未知站点")} → ${escapeHtml(routeStops[routeStops.length - 1]?.name || "未知站点")}`;
  const boardingMarkup = item.boardingStops
    .map((leg) => `<span class="boarding-stop"><time>${boardingDayPrefix(leg)}${escapeHtml(leg.stop.time || "--:--")}</time><span class="boarding-stop__name">${escapeHtml(leg.stop.name)}</span></span>`)
    .join("");
  const statusLabel = departureStatusLabel(item, now);
  const countdownLabel = departureCountdownLabel(item);
  const vehicleTone = departureVehicleTone(item, now);
  const region = item.route.originRegion || routeStops[0]?.region || "1";
  return `<article class="directory-card departure-card${expanded ? " departure-card--expanded is-open" : ""}${index === 0 ? " is-next" : ""}${item.isEntry ? " departure-card--entry" : ""}" data-region="${region}" data-departure-index="${index}">
    <button class="directory-card__summary" type="button" data-departure-toggle aria-expanded="${expanded}" aria-controls="${detailsId}">
      <span class="directory-card__time departure-card__time${item.boardingStops.length > 1 ? " departure-card__time--multi" : ""}"><strong>${timeLabel}</strong><small>${item.isEntry ? "口岸上车" : "发车"}</small></span>
      <span class="directory-card__main">${item.route.labelName ? `<small class="directory-card__label">${escapeHtml(item.route.labelName)}</small>` : ""}<strong>${escapeHtml(item.route.route_name)}</strong><small>${routePath}</small></span>
      <span class="departure-card__ride-row">
        <span class="boarding-stack">${boardingMarkup}</span>
        <span class="vehicle-chip ${vehicleTone}"><strong data-live="status">${escapeHtml(statusLabel)}</strong><small data-live="countdown">${escapeHtml(countdownLabel)}</small></span>
      </span>
      <span class="directory-card__meta"><strong>${routeStops.length}</strong><small>站</small></span>
      <span class="directory-card__expand" aria-hidden="true"></span>
    </button>
    <div class="route-details" id="${detailsId}" aria-hidden="${expanded ? "false" : "true"}"${expanded ? ' data-rendered="1"' : " inert"}>
      <div class="route-details__inner">
        <div class="route-details__body">${expanded ? timelineHtml(item) : ""}</div>
      </div>
    </div>
  </article>`;
}

// 折叠的站点时刻先不生成，展开时才渲染，避免一次渲染大量隐藏 DOM
function timelineHtml(item) {
  const dropOffKeys = new Set(state.selectedDropOffStops.map((stop) => stop.key));
  return `<ol class="route-timeline">${routeTimelineHtml(item.route.stops, item.boardingIndexes, item.allowedStops, dropOffKeys, item.isEntry ? "口岸可上车" : "可上车")}</ol>`;
}

function renderTimeline(details) {
  if (details.dataset.rendered === "1") return;
  const body = details.querySelector(".route-details__body");
  const card = details.closest(".departure-card");
  const item = renderedDepartures[Number(card?.dataset.departureIndex)];
  if (!item || !body) return;
  body.innerHTML = timelineHtml(item);
  details.dataset.rendered = "1";
}

function routeTimelineHtml(stops, boardingIndexes, allowedStops, dropOffKeys, boardingLabel = "可上车") {
  const allowedIds = new Set(allowedStops.map((stop) => `${stop.stop_id}-${stop.time}`));
  const hasDropOffFilter = dropOffKeys.size > 0;
  return stops.map((stop, index) => {
    const isBoarding = boardingIndexes.includes(index);
    const inAllowed = allowedIds.has(`${stop.stop_id}-${stop.time}`);
    const canDropOff = inAllowed && (!hasDropOffFilter || dropOffKeys.has(stopKeyFromRaw(stop)));
    const region = stop.region;
    return `<li class="timeline-stop${isBoarding ? " is-boarding" : ""}${canDropOff ? " is-allowed" : ""}">
      <time>${escapeHtml(stop.time || "--:--")}</time><span class="timeline-dot"></span><div><strong>${escapeHtml(stop.name)}</strong><small>${regionLabel(region)}${isBoarding ? ` · ${boardingLabel}` : canDropOff ? " · 可下车" : ""}</small></div>
    </li>`;
  }).join("");
}

function vehicleStatus(stops, now) {
  const nowValue = now.getHours() * 60 + now.getMinutes();
  const timed = stops.map((stop) => ({ stop, minutes: parseTime(stop.time) })).filter((item) => item.minutes != null);
  if (!timed.length) return "时间待确认";
  if (nowValue < timed[0].minutes) return "未发车";
  const last = timed[timed.length - 1];
  if (nowValue === last.minutes) return `到站 ${last.stop.name}`;
  if (nowValue > last.minutes) return "已结束";
  for (let index = 0; index < timed.length - 1; index += 1) {
    const current = timed[index];
    const next = timed[index + 1];
    if (nowValue === current.minutes) return `到站 ${current.stop.name}`;
    if (nowValue > current.minutes && nowValue < next.minutes) return `离开 ${current.stop.name}`;
  }
  return "运行中";
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

// 判断站点是否位于横琴：特征名优先，其次用经纬度范围兜底
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

// 定位失败时的兜底判断；正常情况下以最近站点的区域为准
function inferRegionFromCoordinates(lat, lng) {
  if (Number.isFinite(lat) && Number.isFinite(lng) && isWithinHengqin(lat, lng) && lng <= 113.55) return "1";
  if (Number.isFinite(lng) && lng >= 113.54 && lat <= 22.22) return "2";
  if (isWithinHengqin(lat, lng)) return "1";
  return "3";
}

function regionLabel(region) {
  return { 1: "横琴", 2: "澳门", 3: "珠海" }[String(region)] || "未知";
}

// 上下车规则：在澳门/珠海上车只能去横琴；在横琴上车可以去澳门或珠海
function defaultOptionForRegion(region) {
  return { 1: "1-2", 2: "2-1", 3: "3-1" }[String(region)] || "1-2";
}

function destinationLabel(regions = state.destinationRegions) {
  return regions.map(regionLabel).join(" / ");
}

function allowedDirections() {
  return state.destinationRegions.map((region) => `${state.currentRegion}-${region}`);
}

function canBoardFrom(stop, direction) {
  return stop.boardingDirections.has(direction) || stop.entryBoardingDirections.has(direction);
}

function canBoardToAny(stop, directions) {
  return directions.some((direction) => canBoardFrom(stop, direction));
}
function parseTime(value) {
  const match = typeof value === "string" ? value.match(/^(\d{1,2}):(\d{2})$/) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function updateClock() {
  if (els.currentTime) els.currentTime.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function setLocationState(message) {
  els.locationState.hidden = false;
  els.locationStateText.textContent = message;
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
