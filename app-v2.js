// 数据源与查询参数（DATA_URL / MAX_DISTANCE_KM / MAX_NEARBY_STATIONS / MAX_DEPARTURES）集中在 config.js

const state = {
  data: null,
  stops: [],
  userPosition: null,
  currentRegion: null,
  selectedStops: [],
  destinationRegion: null,
  nearbyStops: [],
  availableStops: [],
  selectedDropOffStops: [],
  availableDropOffStops: [],
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
    if (els.routesButtonHint) els.routesButtonHint.textContent = `${(state.data.routes || []).length} 条线路总览`;
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
    button.addEventListener("click", () => setCurrentRegion(button.dataset.region, false));
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
    const originRegion = direction ? direction[0] : null;
    const entry = direction ? findEntryPortStop(route, direction) : null;
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
          entryBoardingDirections: new Set(),
        });
      }
      const station = map.get(stopId);
      station.stopIds.add(stopId);
      const cleanedName = cleanStopName(stop.name);
      if (cleanedName.length < station.name.length) station.name = cleanedName;
      if (direction && String(stop.kind) === "1" && inferRegion(stop) === originRegion) {
        station.boardingDirections.add(direction);
      }
      if (entry && stop === entry.stop) {
        station.entryBoardingDirections.add(reverseDirection(direction));
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

// 接口数据中同一物理站点的不同命名，统一到同一站点
const PORT_STOP_ALIASES = new Map([["南迎客平台（南二门）", "横琴口岸（南二门 迎客平台）"]]);

function cleanStopName(name) {
  const cleaned = String(name || "未命名站点")
    .trim()
    .replace(/[\s]*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]+[\s]*$/u, "")
    .replace(/[\s.。．·]+$/u, "")
    .trim();
  return PORT_STOP_ALIASES.get(cleaned) || cleaned;
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
  const available = state.stops.filter((stop) => stop.region === state.currentRegion && canBoardFrom(stop, direction));
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

  const selectedStillValid = state.selectedStops.filter((stop) => stop.region === state.currentRegion && canBoardFrom(stop, direction));
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
  return `<button class="station-card${state.selectedStops.some((item) => item.key === stop.key) ? " is-selected" : ""}" type="button" data-nearby-stop="${stop.key}">
    <div class="station-card__top"><span class="station-kind ${stop.region === "2" ? "station-kind--macau" : ""}">${regionLabel(stop.region)}站点</span><span class="distance">${closest ? "最近 · " : ""}${formatDistance(stop.distanceKm)}</span></div>
    <h3>${escapeHtml(stop.name)}</h3>
    <div class="station-card__bottom"><span>${stop.entryBoardingDirections?.size ? "口岸站可上车" : "可查询该站点班次"}</span><span class="station-card__check">✓</span></div>
  </button>`;
}

function selectStop(stop, scroll) {
  state.selectedStops = [stop];
  updateStationPickerValue();
  renderNearbyStations();
  computeAvailableDropOffStops();
  renderDepartures();
  if (scroll) document.querySelector(".departures-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearSelectedStop() {
  state.selectedStops = [];
  state.selectedDropOffStops = [];
  if (els.manualDropOffWrap) els.manualDropOffWrap.hidden = true;
  updateStationPickerValue();
  updateDropOffPickerValue();
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
  computeAvailableDropOffStops();
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

function toggleDropOffPicker() {
  const isOpen = els.dropOffPickerButton.getAttribute("aria-expanded") === "true";
  if (isOpen) closeDropOffPicker();
  else {
    els.dropOffPicker.classList.add("is-open");
    els.dropOffPickerButton.setAttribute("aria-expanded", "true");
    els.dropOffPickerMenu.hidden = false;
    els.dropOffPickerSearch.focus();
  }
}

function closeDropOffPicker() {
  els.dropOffPicker.classList.remove("is-open");
  els.dropOffPickerButton.setAttribute("aria-expanded", "false");
  els.dropOffPickerMenu.hidden = true;
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
  const direction = `${state.currentRegion}-${state.destinationRegion}`;
  const reachableKeys = new Set();
  (state.data.routes || []).forEach((route) => {
    const routeDirection = getRouteDirection(route);
    if (routeDirection === direction) {
      (route.stops || []).forEach((boardingStop, boardingIndex) => {
        if (String(boardingStop.kind) !== "1") return;
        if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(boardingStop.stop_id)))) return;
        allowedDropOffStops(route.stops, boardingIndex, state.currentRegion, state.destinationRegion).forEach((dropStop) => {
          reachableKeys.add(stopKeyFromRaw(dropStop));
        });
      });
      return;
    }
    if (routeDirection !== reverseDirection(direction)) return;
    const entry = findEntryPortStop(route, routeDirection);
    if (!entry) return;
    if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(entry.stop.stop_id)))) return;
    entryAllowedStops(route.stops, entry.index, state.currentRegion).forEach((dropStop) => {
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
  renderDropOffPickerOptions(els.dropOffPickerSearch.value);
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
    ? options.map((stop) => `<button class="station-picker__option${state.selectedDropOffStops.some((item) => item.key === stop.key) ? " is-selected" : ""}" type="button" data-dropoff-stop="${escapeHtml(stop.key)}"><span class="station-picker__check">✓</span><span>${escapeHtml(stop.name)}</span>${dropOffRegionTag(stop)}</button>`).join("")
    : `<div class="station-picker__empty">没有匹配的站点</div>`;
}

// 口岸站上车时，下车站与上车站同区域（境内短途），用标签区分
function dropOffRegionTag(stop) {
  return stop.region === state.destinationRegion
    ? ""
    : `<span class="station-picker__tag station-picker__tag--${stop.region}">${regionLabel(stop.region)}境内</span>`;
}

function stopKeyFromRaw(stop) {
  return `${inferRegion(stop)}|${cleanStopName(stop.name)}`;
}

// 快速选择预设：boardingPattern 为 null 时，上车点取当前区域内的附近站点（最多 MAX_NEARBY_STATIONS 个）
const QUICK_PRESETS = {
  "university-to-uma": { boardingRegion: "1", boardingPattern: /澳门新街坊|荔枝湾|横琴检察院（往口岸）/, dropPattern: /澳大/ },
  "uma-to-university": { boardingRegion: "2", boardingPattern: /澳大/, dropPattern: /澳门新街坊|荔枝湾/ },
  "nearby-to-uma": { boardingRegion: "1", boardingPattern: null, dropPattern: /澳大/ },
  "nearby-to-university": { boardingRegion: "2", boardingPattern: null, dropPattern: /澳门新街坊|荔枝湾/ },
};

function quickSelect(mode) {
  const preset = QUICK_PRESETS[mode];
  if (!state.data || !preset) return;
  const boardingRegion = preset.boardingRegion;
  const dropRegion = oppositeRegion(boardingRegion);
  const useNearbyStops = !preset.boardingPattern;

  if (useNearbyStops && !state.userPosition) {
    els.locationHint.textContent = "「附近」快速选择需要定位：请允许定位权限或点击「刷新当前位置」后重试";
    requestLocation(true);
    return;
  }
  setCurrentRegion(boardingRegion, false);
  if (useNearbyStops) {
    if (!state.nearbyStops.length) {
      els.locationHint.textContent = `附近 ${MAX_DISTANCE_KM} 公里内没有可上车的站点，请手动选择上车站点`;
      return;
    }
    state.selectedStops = state.nearbyStops.slice(0, MAX_NEARBY_STATIONS);
  } else {
    state.selectedStops = state.availableStops.filter((stop) => preset.boardingPattern.test(stop.name));
  }
  state.selectedDropOffStops = state.stops.filter((stop) => stop.region === dropRegion && preset.dropPattern.test(stop.name));
  updateStationPickerValue();
  renderStationPickerOptions();
  computeAvailableDropOffStops();
  renderDepartures();
  document.querySelector(".departures-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDepartures() {
  const direction = state.currentRegion && state.destinationRegion ? `${state.currentRegion}-${state.destinationRegion}` : null;
  const hasNormalBoarding = Boolean(direction) && state.selectedStops.some((stop) => stop.boardingDirections.has(direction));
  const hasEntryBoarding = Boolean(direction) && state.selectedStops.some((stop) => stop.entryBoardingDirections.has(direction));
  if (direction && els.departureDirectionNote) {
    const forwardNote = `${regionLabel(state.currentRegion)}上车 · 前往 <strong>${regionLabel(state.destinationRegion)}</strong>`;
    if (!hasEntryBoarding) els.departureDirectionNote.innerHTML = forwardNote;
    else if (hasNormalBoarding) els.departureDirectionNote.innerHTML = `${forwardNote} · 另含口岸站境内班次`;
    else els.departureDirectionNote.innerHTML = `${regionLabel(state.currentRegion)}上车 · 口岸站短途（限${regionLabel(state.currentRegion)}境内下车）`;
  }
  if (!state.data || !state.selectedStops.length || !direction) {
    els.selectedContext.textContent = state.currentRegion ? "请选择上车站点" : "请选择当前所在区域和上车站点";
    els.departureList.innerHTML = "";
    els.departureEmpty.hidden = false;
    return;
  }

  const nowMinutes = currentMinutes();
  const routeDepartures = new Map();
  (state.data.routes || []).forEach((route) => {
    const routeDirection = getRouteDirection(route);
    if (routeDirection === direction) {
      (route.stops || []).forEach((boardingStop, boardingIndex) => {
        if (String(boardingStop.kind) !== "1") return;
        if (inferRegion(boardingStop) !== state.currentRegion) return;
        if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(boardingStop.stop_id)))) return;
        const allowedStops = allowedDropOffStops(route.stops, boardingIndex, state.currentRegion, state.destinationRegion);
        if (!allowedStops.length || !matchesDropOffFilter(allowedStops)) return;
        addBoardingLeg(routeDepartures, route, boardingStop, boardingIndex, allowedStops, nowMinutes, false);
      });
      return;
    }
    if (routeDirection !== reverseDirection(direction)) return;
    const entry = findEntryPortStop(route, routeDirection);
    if (!entry) return;
    if (!state.selectedStops.some((stop) => stop.stopIds.has(Number(entry.stop.stop_id)))) return;
    const allowedStops = entryAllowedStops(route.stops, entry.index, state.currentRegion);
    if (!allowedStops.length || !matchesDropOffFilter(allowedStops)) return;
    addBoardingLeg(routeDepartures, route, entry.stop, entry.index, allowedStops, nowMinutes, true);
  });
  const departures = [...routeDepartures.values()].sort((a, b) => a.minutesUntil - b.minutesUntil);

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
  els.departureList.innerHTML = departures.slice(0, MAX_DEPARTURES).map(departureHtml).join("");
}

function scopeSummary(forwardCount, entryCount) {
  const current = regionLabel(state.currentRegion);
  if (entryCount && !forwardCount) return `口岸站上车 · ${current}境内`;
  if (entryCount) return `${current} → ${regionLabel(state.destinationRegion)} · 含 ${entryCount} 个口岸站境内班次`;
  return `${current} → ${regionLabel(state.destinationRegion)}`;
}

function allowedDropOffStops(stops, boardingIndex, currentRegion, destinationRegion) {
  let lastCurrentRegionIndex = boardingIndex;
  for (let index = boardingIndex; index < stops.length; index += 1) {
    if (inferRegion(stops[index]) === currentRegion) lastCurrentRegionIndex = index;
  }
  const destinationStops = stops.slice(lastCurrentRegionIndex + 1).filter((stop) => inferRegion(stop) === destinationRegion);
  return destinationStops;
}

// 线路驶入对岸后停靠的首个口岸站：该站同样允许上车，乘客可在本区域后续站点下车

function findEntryPortStop(route, direction) {
  const stops = route?.stops || [];
  const destinationRegion = String(direction).split("-")[1];
  const index = stops.findIndex((stop) => inferRegion(stop) === destinationRegion && isPortStopName(stop.name));
  return index >= 0 ? { stop: stops[index], index } : null;
}

function entryAllowedStops(stops, entryIndex, region) {
  return stops.slice(entryIndex + 1).filter((stop) => inferRegion(stop) === region);
}

function isPortStopName(name) {
  const value = String(name || "");
  return !/往口岸/.test(value) && /口岸|迎客平台/.test(value);
}

function matchesDropOffFilter(allowedStops) {
  if (!state.selectedDropOffStops.length) return true;
  const selectedDropOffKeys = new Set(state.selectedDropOffStops.map((stop) => stop.key));
  return allowedStops.some((dropStop) => selectedDropOffKeys.has(stopKeyFromRaw(dropStop)));
}

// 同一线路在本区域可能有多个可上车站点，合并为一张卡片（时间列显示“07:32 或 07:36”）
function addBoardingLeg(routeDepartures, route, boardingStop, boardingIndex, allowedStops, nowMinutes, isEntry) {
  const departureMinutes = parseTime(boardingStop.time);
  if (departureMinutes == null) return;
  const isNextDay = departureMinutes < nowMinutes;
  const leg = {
    stop: boardingStop,
    index: boardingIndex,
    isNextDay,
    minutesUntil: isNextDay ? departureMinutes + 1440 - nowMinutes : departureMinutes - nowMinutes,
  };
  let item = routeDepartures.get(route.id);
  if (!item) {
    item = {
      route,
      boardingStops: [],
      boardingIndexes: [],
      allowedStops: [],
      minutesUntil: leg.minutesUntil,
      isNextDay: leg.isNextDay,
      isEntry,
    };
    routeDepartures.set(route.id, item);
  }
  if (item.boardingStops.some((existing) => existing.stop.time === leg.stop.time)) return;
  item.boardingStops.push(leg);
  item.boardingIndexes.push(boardingIndex);
  mergeStopList(item.allowedStops, allowedStops);
  if (leg.minutesUntil < item.minutesUntil) {
    item.minutesUntil = leg.minutesUntil;
    item.isNextDay = leg.isNextDay;
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

function departureHtml(item, index) {
  const detailsId = `route-details-${item.route.id}-${index}`;
  const statusLabel = vehicleStatus(item.route.stops, new Date(), item.isNextDay);
  const departureText = item.minutesUntil === 0 ? "即将发车" : `${item.minutesUntil} 分钟后`;
  const timeLabel = item.boardingStops
    .map((leg) => `${leg.isNextDay ? '<span class="departure-card__day">次日</span> ' : ""}${escapeHtml(leg.stop.time || "--:--")}`)
    .join(' <span class="departure-card__or">或</span><br>');
  const routeStops = item.route.stops || [];
  const routePath = `${escapeHtml(routeStops[0]?.name || "未知站点")} → ${escapeHtml(routeStops[routeStops.length - 1]?.name || "未知站点")}`;
  const boardingStops = item.boardingStops
    .map((leg) => `${leg.isNextDay ? "次日 " : ""}${escapeHtml(leg.stop.time || "--:--")} ${escapeHtml(leg.stop.name)}`)
    .join("、");
  const dropOffKeys = new Set(state.selectedDropOffStops.map((stop) => stop.key));
  return `<article class="departure-card departure-card--expanded${index === 0 ? " is-next" : ""}${item.isEntry ? " departure-card--entry" : ""}">
    <div class="departure-card__summary">
      <div class="departure-card__time${item.boardingStops.length > 1 ? " departure-card__time--multi" : ""}"><strong>${timeLabel}</strong><small>${escapeHtml(item.route.route_name)}</small></div>
      <div class="departure-card__route"><strong>${escapeHtml(statusLabel)}</strong><span>${routePath}</span><span class="departure-card__boarding">可上车站点：${boardingStops}</span></div>
      <div class="departure-card__countdown"><strong>${departureText}</strong><small>${item.isEntry ? "口岸上车" : "本站发车"}</small></div>
      <button class="route-toggle" type="button" data-route-toggle aria-expanded="${index === 0}" aria-controls="${detailsId}"><span>站点列表</span><span>${index === 0 ? "−" : "+"}</span></button>
    </div>
    <div class="route-details" id="${detailsId}" ${index === 0 ? "" : "hidden"}>
      <ol class="route-timeline">${routeTimelineHtml(item.route.stops, item.boardingIndexes, item.allowedStops, dropOffKeys, item.isEntry ? "口岸上车" : "上车")}</ol>
    </div>
  </article>`;
}

function routeTimelineHtml(stops, boardingIndexes, allowedStops, dropOffKeys, boardingLabel = "上车") {
  const allowedIds = new Set(allowedStops.map((stop) => `${stop.stop_id}-${stop.time}`));
  const hasDropOffFilter = dropOffKeys.size > 0;
  return stops.map((stop, index) => {
    const isBoarding = boardingIndexes.includes(index);
    const inAllowed = allowedIds.has(`${stop.stop_id}-${stop.time}`);
    const canDropOff = inAllowed && (!hasDropOffFilter || dropOffKeys.has(stopKeyFromRaw(stop)));
    const region = inferRegion(stop);
    return `<li class="timeline-stop${isBoarding ? " is-boarding" : ""}${canDropOff ? " is-allowed" : ""}">
      <time>${escapeHtml(stop.time || "--:--")}</time><span class="timeline-dot"></span><div><strong>${escapeHtml(stop.name)}</strong><small>${regionLabel(region)}${isBoarding ? ` · ${boardingLabel}` : canDropOff ? " · 可下车" : ""}</small></div>
    </li>`;
  }).join("");
}

function vehicleStatus(stops, now, isNextDay = false) {
  const nowValue = now.getHours() * 60 + now.getMinutes();
  const timed = stops.map((stop) => ({ stop, minutes: parseTime(stop.time) })).filter((item) => item.minutes != null);
  if (!timed.length) return "时间待确认";
  if (isNextDay || nowValue < timed[0].minutes) return "未发车";
  if (nowValue >= timed[timed.length - 1].minutes) return "已结束";
  for (let index = 0; index < timed.length - 1; index += 1) {
    const current = timed[index];
    const next = timed[index + 1];
    if (nowValue === current.minutes) return `在 ${current.stop.name} · 下一站 ${next.stop.name}`;
    if (nowValue > current.minutes && nowValue < next.minutes) return `前往 ${next.stop.name}`;
  }
  return "运行中";
}

function inferRegion(stop) {
  const name = String(stop?.name || "");
  const lng = Number(stop?.x);
  const hengqin = /横琴|中医药产业园|琴海|金融岛|汇通|市民中心|人才公寓|华发首府|保利国际|中海名钻|K2荔枝湾|上村|下村|琴政|琴朗|十字门|环岛北路|科创中心|洋环路|中葡经贸|中央汇|横琴医院|伯牙|金汇国际|迎客平台|南二门|澳门新街坊/;
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
function reverseDirection(direction) { return String(direction) === "1-2" ? "2-1" : "1-2"; }
function canBoardFrom(stop, direction) {
  return stop.boardingDirections.has(direction) || stop.entryBoardingDirections.has(direction);
}
function currentMinutes() { const now = new Date(); return now.getHours() * 60 + now.getMinutes(); }
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
