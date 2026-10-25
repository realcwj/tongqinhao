"""获取通琴号跨境线路及其具体站点信息。"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_URL = "https://tqh.hengqin.gov.cn:8069/api/v1/route/get/"
STOPS_API_URL = "https://tqh.hengqin.gov.cn:8069/api/v1/route/timetable/stops"
SCHEDULE_API_URL = "https://tqh.hengqin.gov.cn:8069/api/v1/route/schedule/find"
DEFAULT_LABEL_ID = 7
# 除跨境通勤线（label 7）外，额外记录的境内线路标签
DOMESTIC_LABEL_IDS = (3, 4, 5, 6, 8, 10, 11)
MINUTES_PER_DAY = 24 * 60
TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
SYNC_DATE_PATTERN = re.compile(r'(const DATA_SYNC_DATE = )"[^"]*";')
BEIJING_TIMEZONE = timezone(timedelta(hours=8))
OUTPUT_DIR = Path(__file__).with_name("json")
CONFIG_PATH = Path(__file__).with_name("config.js")
ROUTES_OUTPUT = OUTPUT_DIR / "all_routes.json"
PROCESSED_OUTPUT = Path(__file__).with_name("processed.json")
DEFAULT_TIMEOUT = 20
REQUEST_HEADERS = {
	"Content-Type": "application/json",
	"Accept": "application/json",
	"User-Agent": (
		"Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) "
		"AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
		"MicroMessenger/8.0.75 NetType/WIFI Language/zh_CN"
	),
	"Referer": "",
}


class RouteApiError(RuntimeError):
	"""通琴号接口请求或响应异常。"""


def post_api(url: str, body: dict[str, Any], timeout: int, description: str) -> dict[str, Any]:
	"""以 POST 方式请求接口，返回解析后的 JSON 内容。"""
	request = Request(
		url,
		data=json.dumps(body).encode("utf-8"),
		method="POST",
		headers={**REQUEST_HEADERS},
	)

	try:
		with urlopen(request, timeout=timeout) as response:
			response_text = response.read().decode("utf-8")
	except HTTPError as exc:
		detail = exc.read().decode("utf-8", errors="replace").strip()
		raise RouteApiError(f"{description}接口返回 HTTP {exc.code}: {detail or exc.reason}") from exc
	except URLError as exc:
		raise RouteApiError(f"{description}请求失败: {exc.reason}") from exc
	except TimeoutError as exc:
		raise RouteApiError(f"{description}请求超时（{timeout} 秒）") from exc

	try:
		payload = json.loads(response_text)
	except json.JSONDecodeError as exc:
		raise RouteApiError(f"{description}返回的内容不是有效 JSON") from exc

	if not isinstance(payload, dict):
		raise RouteApiError(f"{description}返回 JSON 格式异常，顶层对象应为字典")
	return payload


def get_routes_by_label(
	label_id: int = DEFAULT_LABEL_ID,
	timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
	"""请求指定标签下的线路列表并返回接口原始 JSON。"""
	if label_id < 0:
		raise ValueError("label_id 不能为负数")
	if timeout <= 0:
		raise ValueError("timeout 必须大于 0")

	payload = post_api(API_URL, {"label_id": label_id}, timeout, f"标签 {label_id} 线路列表")

	api_message = payload.get("msg")
	routes = payload.get("data")
	if not isinstance(routes, list):
		raise RouteApiError(f"标签 {label_id} 未返回线路列表，msg={api_message!r}")

	return payload


def stops_label_name(stops_payload: dict[str, Any]) -> str | None:
	"""从站点接口响应中取出线路所属标签名称（如「夜间线」）。"""
	stops_data = stops_payload.get("data")
	if isinstance(stops_data, dict):
		label_name = stops_data.get("label_name")
		if isinstance(label_name, str) and label_name.strip():
			return label_name.strip()
	return None


def normalize_date(value: Any) -> str | None:
	"""把接口的 2026/9/27 这类日期整理成 2026-09-27，非法日期返回 None。"""
	if not isinstance(value, str):
		return None
	parts = value.strip().replace("/", "-").split("-")
	if len(parts) != 3:
		return None
	try:
		year, month, day = (int(part) for part in parts)
	except ValueError:
		return None
	if not 1 <= month <= 12 or not 1 <= day <= 31:
		return None
	return f"{year:04d}-{month:02d}-{day:02d}"


def get_route_schedule(
	route_id: int,
	timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, list[str]]:
	"""请求单条线路的发车时间，以及每个班次未来几天的开行日期。"""
	if route_id <= 0:
		raise ValueError("route_id 必须大于 0")
	if timeout <= 0:
		raise ValueError("timeout 必须大于 0")

	payload = post_api(
		SCHEDULE_API_URL,
		{"route_id": route_id},
		timeout,
		f"线路 {route_id} 发车时间",
	)

	schedule_data = payload.get("data")
	if schedule_data is None:
		return {}
	if not isinstance(schedule_data, dict):
		raise RouteApiError(f"线路 {route_id} 的发车时间格式异常，data 应为字典")

	schedule: dict[str, list[str]] = {}
	for time_text, entries in schedule_data.items():
		if not isinstance(time_text, str) or not TIME_PATTERN.match(time_text):
			continue
		dates: set[str] = set()
		if isinstance(entries, list):
			for entry in entries:
				if not isinstance(entry, dict):
					continue
				date_text = normalize_date(entry.get("date"))
				if date_text:
					dates.add(date_text)
		schedule[time_text] = sorted(dates)
	return dict(sorted(schedule.items()))


def get_route_stops(
	route_id: int,
	timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
	"""请求单条线路的站点、时刻等详细信息。"""
	if route_id <= 0:
		raise ValueError("route_id 必须大于 0")
	if timeout <= 0:
		raise ValueError("timeout 必须大于 0")

	payload = post_api(
		STOPS_API_URL,
		{"route_id": route_id},
		timeout,
		f"线路 {route_id} 站点",
	)

	if "data" not in payload:
		raise RouteApiError(f"线路 {route_id} 返回内容缺少 data 字段")
	return payload


def time_to_minutes(value: Any) -> int | None:
	"""把 HH:MM 时刻转换为当天的分钟数，非法时刻返回 None。"""
	if not isinstance(value, str) or not TIME_PATTERN.match(value):
		return None
	hour, minute = value.split(":")
	return int(hour) * 60 + int(minute)


def minutes_to_time(minutes: int) -> str:
	"""把分钟数格式化为 HH:MM，超过一天时按 24 小时取模。"""
	normalized = minutes % MINUTES_PER_DAY
	return f"{normalized // 60:02d}:{normalized % 60:02d}"


def shift_time(value: Any, offset: int) -> Any:
	"""按分钟偏移平移时刻，无法解析的时刻原样返回。"""
	minutes = time_to_minutes(value)
	if minutes is None:
		return value
	return minutes_to_time(minutes + offset)


def save_json(payload: Any, output_path: Path) -> None:
	"""以 UTF-8 中文格式保存接口原始响应。"""
	output_path.parent.mkdir(parents=True, exist_ok=True)
	output_path.write_text(
		json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
		encoding="utf-8",
	)


def today_in_beijing() -> str:
	"""返回接口所在时区（UTC+8）的当天日期。"""
	return datetime.now(BEIJING_TIMEZONE).date().isoformat()


def update_sync_date(config_path: Path, date_text: str) -> bool:
	"""把 config.js 中的 DATA_SYNC_DATE 改成给定日期，返回是否发生改动。"""
	if not config_path.exists():
		return False

	content = config_path.read_text(encoding="utf-8")
	updated = SYNC_DATE_PATTERN.sub(
		lambda match: f'{match.group(1)}"{date_text}";',
		content,
	)
	if updated == content:
		return False

	config_path.write_text(updated, encoding="utf-8")
	return True


def print_route_summary(payload: dict[str, Any]) -> None:
	"""打印适合终端查看的班次摘要。"""
	routes = payload["data"]
	print(f"接口消息: {payload.get('msg', '')}")
	print(f"班次数量: {len(routes)}")
	for index, route in enumerate(routes, start=1):
		if not isinstance(route, dict):
			print(f"{index}. {route!r}")
			continue
		start = route.get("bus_start_stop_id") or {}
		end = route.get("bus_end_stop_id") or {}
		start_name = start.get("name", "未知起点") if isinstance(start, dict) else "未知起点"
		end_name = end.get("name", "未知终点") if isinstance(end, dict) else "未知终点"
		route_name = route.get("name", "未命名班次")
		print(f"{index}. {route_name}: {start_name} -> {end_name}")


def merge_route_stops(stops_payload: dict[str, Any]) -> list[dict[str, Any]]:
	"""合并线路上下行站点，并按接口返回的 sequence 排序。"""
	stops_data = stops_payload.get("data", {})
	stops: list[dict[str, Any]] = []
	if not isinstance(stops_data, dict):
		return stops

	for direction in ("up", "down"):
		direction_stops = stops_data.get(direction, [])
		if not isinstance(direction_stops, list):
			continue
		for stop in direction_stops:
			if not isinstance(stop, dict):
				continue
			stops.append(
				{
					"x": stop.get("x"),
					"y": stop.get("y"),
					"time": stop.get("time"),
					"name": stop.get("name"),
					"kind": stop.get("kind"),
					"stop_id": stop.get("stop_id"),
					"_sequence": stop.get("sequence", 0),
				}
			)

	stops.sort(key=lambda stop: stop.pop("_sequence"))
	return stops


def build_route_entries(
	route: dict[str, Any],
	stops_payload: dict[str, Any],
	schedule: dict[str, list[str]],
	warnings: list[str],
) -> list[dict[str, Any]]:
	"""把单条线路的站点与发车时间整理成若干班次条目。

	站点接口只会返回「当前班次」的站点时刻，因此用发车时间接口返回的发车时间
	把站点时刻整体平移，得到每个班次各自的站点时刻（同线路各班次的相对时刻一致）。
	若发车时间接口没有返回任何发车时间，说明该线路未来几天没有发车计划，
	此时按「暂无发车计划」输出（departure 为 null、dates 为空、has_schedule 为 false）。
	"""
	route_id = route["id"]
	stops = merge_route_stops(stops_payload)
	stops_data = stops_payload.get("data")
	route_name = route.get("name") or (
		stops_data.get("route_name") if isinstance(stops_data, dict) else None
	)

	departures = sorted(schedule)
	if not departures:
		warnings.append(f"线路 {route_id} 未来几天没有发车计划，已按「暂无发车计划」输出")
		return [
			{
				"id": route_id,
				"uid": str(route_id),
				"departure": None,
				"dates": [],
				"has_schedule": False,
				"route_name": route_name,
				"bus_id": route.get("bus_id"),
				"stops": stops,
			}
		]

	base_time = stops[0]["time"] if stops else None
	base_minutes = time_to_minutes(base_time)
	if base_minutes is None:
		warnings.append(f"线路 {route_id} 缺少可用的站点时刻，已按发车时间原样输出")

	entries: list[dict[str, Any]] = []
	for departure in departures:
		departure_minutes = time_to_minutes(departure)
		offset = (
			departure_minutes - base_minutes
			if base_minutes is not None and departure_minutes is not None
			else 0
		)
		entries.append(
			{
				"id": route_id,
				"uid": f"{route_id}@{departure}",
				"departure": departure,
				"dates": list(schedule.get(departure, [])),
				"has_schedule": True,
				"route_name": route_name,
				"bus_id": route.get("bus_id"),
				"stops": [{**stop, "time": shift_time(stop["time"], offset)} for stop in stops],
			}
		)
	return entries


def group_entries_by_route_id(entries: Any) -> dict[int, list[dict[str, Any]]]:
	"""按线路 ID 归类已有的班次条目。"""
	grouped: dict[int, list[dict[str, Any]]] = {}
	if not isinstance(entries, list):
		return grouped
	for entry in entries:
		if not isinstance(entry, dict):
			continue
		route_id = entry.get("id")
		if isinstance(route_id, int):
			grouped.setdefault(route_id, []).append(entry)
	return grouped


def prune_entries(entries: list[dict[str, Any]], today: str) -> list[dict[str, Any]]:
	"""清理旧数据中已经过去的开行日期，没有剩余日期的班次直接丢弃。

	「暂无发车计划」（has_schedule 为 False）的条目本身没有日期，原样保留。
	"""
	kept: list[dict[str, Any]] = []
	for entry in entries:
		dates = {
			date_text
			for date_text in entry.get("dates") or []
			if isinstance(date_text, str) and date_text >= today
		}
		if dates:
			kept.append({**entry, "dates": sorted(dates)})
		elif entry.get("has_schedule") is False:
			kept.append({**entry, "dates": []})
	return kept


def merge_processed_routes(
	routes: list[dict[str, Any]],
	fresh_entries_by_route_id: dict[int, list[dict[str, Any]]],
	previous_entries_by_route_id: dict[int, list[dict[str, Any]]],
	failed_route_ids: set[int],
	today: str,
	warnings: list[str],
) -> list[dict[str, Any]]:
	"""按线路合并新旧数据。

	抓取成功的线路以本次抓取的数据为准（完整覆盖旧数据）；
	抓取失败的线路沿用旧数据，只清理早于今天的日期，日期全部过期的班次会被移除。
	"""
	merged: list[dict[str, Any]] = []
	for route in routes:
		route_id = route.get("id")
		if not isinstance(route_id, int):
			continue

		if route_id not in failed_route_ids:
			merged.extend(fresh_entries_by_route_id.get(route_id, []))
			continue

		previous_entries = previous_entries_by_route_id.get(route_id, [])
		kept = prune_entries(previous_entries, today)
		if not previous_entries:
			warnings.append(f"线路 {route_id} 抓取失败且没有可沿用的旧数据，已跳过")
		elif not kept:
			warnings.append(
				f"线路 {route_id} 抓取失败，旧数据的开行日期已全部过期，已从数据中移除"
			)
		merged.extend(kept)
	return merged


def build_processed_payload(
	cross_border: dict[str, Any],
	domestic_labels: list[dict[str, Any]],
) -> dict[str, Any]:
	"""组装最终写入 processed.json 的内容。

	`routes` 仍只放跨境通勤线（label 7），保持前端现有读取方式不变；
	境内线路按标签记录在 `domestic_labels` 中，暂不参与前端展示。
	"""
	return {
		"label_id": cross_border["label_id"],
		"label_name": cross_border["label_name"],
		"route_count": cross_border["route_count"],
		"routes": cross_border["routes"],
		"domestic_labels": domestic_labels,
	}


def update_label(
	label_id: int,
	previous_label: dict[str, Any] | None,
	warnings: list[str],
	today: str,
	verbose: bool,
) -> dict[str, Any] | None:
	"""抓取单个标签下的线路并按线路合并新旧数据。

	返回该标签的数据；若线路列表获取失败且没有可沿用的旧数据，返回 None。
	"""
	previous_entries = (
		previous_label.get("routes") if isinstance(previous_label, dict) else None
	)
	previous_by_route_id = group_entries_by_route_id(previous_entries)
	previous_label_name = (
		previous_label.get("label_name") if isinstance(previous_label, dict) else None
	)

	try:
		routes_payload = get_routes_by_label(label_id)
	except RouteApiError as exc:
		if not previous_by_route_id:
			print(
				f"[label {label_id}] 获取线路列表失败且没有旧数据，已跳过: {exc}",
				file=sys.stderr,
			)
			return None
		print(
			f"[label {label_id}] 获取线路列表失败，将沿用旧数据并清理过期日期: {exc}",
			file=sys.stderr,
		)
		routes = [
			{
				"id": route_id,
				"name": entries[0].get("route_name"),
				"bus_id": entries[0].get("bus_id"),
			}
			for route_id, entries in previous_by_route_id.items()
		]
	else:
		output_path = (
			ROUTES_OUTPUT
			if label_id == DEFAULT_LABEL_ID
			else OUTPUT_DIR / f"label_{label_id}_routes.json"
		)
		save_json(routes_payload, output_path)
		if verbose:
			print_route_summary(routes_payload)

		routes = routes_payload.get("data", [])
		if not isinstance(routes, list):
			print(f"[label {label_id}] 接口返回的 data 不是列表，已按空列表处理", file=sys.stderr)
			routes = []

	fresh_entries_by_route_id: dict[int, list[dict[str, Any]]] = {}
	failed_route_ids: set[int] = set()
	seen_label_names: dict[str, int] = {}

	for index, route in enumerate(routes, start=1):
		if not isinstance(route, dict) or not isinstance(route.get("id"), int):
			print(f"[label {label_id}] 跳过第 {index} 条无效线路: {route!r}", file=sys.stderr)
			continue
		route_id = route["id"]

		try:
			schedule = get_route_schedule(route_id)
			stops_payload = get_route_stops(route_id)
		except (RouteApiError, ValueError, OSError) as exc:
			failed_route_ids.add(route_id)
			print(
				f"[label {label_id}] 线路 {route_id} 获取失败，沿用旧数据并清理过期日期: {exc}",
				file=sys.stderr,
			)
			continue

		save_json(stops_payload, OUTPUT_DIR / f"route_{route_id}.json")
		fresh_entries_by_route_id[route_id] = build_route_entries(
			route, stops_payload, schedule, warnings
		)
		label_name = stops_label_name(stops_payload)
		if label_name:
			seen_label_names[label_name] = seen_label_names.get(label_name, 0) + 1

		if verbose:
			departure_text = (
				"、".join(
					f"{time_text}（{len(dates)} 天）"
					for time_text, dates in schedule.items()
				)
				if schedule
				else "暂无发车计划"
			)
			print(
				f"[{index}/{len(routes)}] 线路 {route_id} 更新成功"
				f"（发车时间：{departure_text}）"
			)

	merged_routes = merge_processed_routes(
		routes,
		fresh_entries_by_route_id,
		previous_by_route_id,
		failed_route_ids,
		today,
		warnings,
	)
	label_name = (
		max(seen_label_names, key=seen_label_names.get)
		if seen_label_names
		else previous_label_name or f"线路 {label_id}"
	)
	print(
		f"[label {label_id}] {label_name}: 成功 {len(fresh_entries_by_route_id)} 条线路，"
		f"沿用旧数据 {len(failed_route_ids)} 条线路，共 {len(merged_routes)} 个班次"
	)
	return {
		"label_id": label_id,
		"label_name": label_name,
		"route_count": len(merged_routes),
		"routes": merged_routes,
	}


def load_json(output_path: Path) -> Any | None:
	"""读取已有 JSON；文件不存在或格式异常时返回 None。"""
	try:
		return json.loads(output_path.read_text(encoding="utf-8"))
	except (OSError, json.JSONDecodeError):
		return None


def run_update() -> int:
	"""抓取跨境线与境内线，按线路与旧数据合并后写入 processed.json。"""
	warnings: list[str] = []
	today = today_in_beijing()

	previous_payload = load_json(PROCESSED_OUTPUT)
	if not isinstance(previous_payload, dict):
		previous_payload = {}

	cross_border = update_label(
		DEFAULT_LABEL_ID,
		previous_payload,
		warnings,
		today,
		verbose=True,
	)
	if cross_border is None:
		raise RouteApiError(f"无法获取跨境通勤线（label {DEFAULT_LABEL_ID}）的线路列表")

	previous_domestic = previous_payload.get("domestic_labels")
	previous_domestic_by_label: dict[int, dict[str, Any]] = {}
	if isinstance(previous_domestic, list):
		for item in previous_domestic:
			if isinstance(item, dict) and isinstance(item.get("label_id"), int):
				previous_domestic_by_label[item["label_id"]] = item

	domestic_labels: list[dict[str, Any]] = []
	for label_id in DOMESTIC_LABEL_IDS:
		label_data = update_label(
			label_id,
			previous_domestic_by_label.get(label_id),
			warnings,
			today,
			verbose=False,
		)
		if label_data is not None:
			domestic_labels.append(label_data)

	processed_payload = build_processed_payload(cross_border, domestic_labels)

	for warning in warnings:
		print(f"提示: {warning}", file=sys.stderr)
	save_json(processed_payload, PROCESSED_OUTPUT)

	domestic_entries = sum(item["route_count"] for item in domestic_labels)
	print(
		f"更新完成：跨境通勤线 {cross_border['route_count']} 个班次；"
		f"境内线 {len(domestic_labels)} 个标签 / {domestic_entries} 个班次"
	)
	print(f"{PROCESSED_OUTPUT} 共 {cross_border['route_count'] + domestic_entries} 个班次")
	print(f"原始响应目录: {OUTPUT_DIR}")

	if update_sync_date(CONFIG_PATH, today):
		print(f"config.js 中的数据同步日期已更新为: {today}")
	return 0


def main() -> int:
	try:
		return run_update()
	except (RouteApiError, ValueError, OSError) as exc:
		print(f"更新失败: {exc}", file=sys.stderr)
		return 1


if __name__ == "__main__":
	raise SystemExit(main())
