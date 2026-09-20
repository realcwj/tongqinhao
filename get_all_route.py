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


def get_cross_border_routes(
	label_id: int = DEFAULT_LABEL_ID,
	timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
	"""请求指定标签下的通琴班次并返回接口原始 JSON。"""
	if label_id < 0:
		raise ValueError("label_id 不能为负数")
	if timeout <= 0:
		raise ValueError("timeout 必须大于 0")

	payload = post_api(API_URL, {"label_id": label_id}, timeout, "班次")

	api_message = payload.get("msg")
	routes = payload.get("data")
	if not isinstance(routes, list):
		raise RouteApiError(f"接口未返回班次列表，msg={api_message!r}")

	return payload


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


def build_processed_payload(
	routes: list[dict[str, Any]],
	stops_by_route_id: dict[int, dict[str, Any]],
	schedule_by_route_id: dict[int, dict[str, list[str]]],
	warnings: list[str] | None = None,
) -> dict[str, Any]:
	"""按发车班次整理线路和站点详情，生成根目录 processed.json 的内容。

	站点接口只会返回「当前班次」的站点时刻，因此先通过发车时间接口取到
	该线路的全部发车时间（含未来几天的开行日期），再把站点时刻整体平移到
	每个发车时间上，从而得到每个班次各自的站点时刻（同线路各班次的相对时刻一致）。
	"""
	notes = warnings if warnings is not None else []
	processed_routes: list[dict[str, Any]] = []

	for route in routes:
		route_id = route.get("id")
		if not isinstance(route_id, int):
			continue

		stops = merge_route_stops(stops_by_route_id.get(route_id, {}))
		base_time = stops[0]["time"] if stops else None
		base_minutes = time_to_minutes(base_time)

		schedule = schedule_by_route_id.get(route_id) or {}
		departures = sorted(schedule)
		if base_minutes is None:
			if departures:
				notes.append(f"线路 {route_id} 缺少可用的站点时刻，已按发车时间原样输出")
			departures = departures or [None]
		elif base_time not in departures:
			notes.append(
				f"线路 {route_id} 的站点时刻（{base_time}）不在发车时间列表 {departures} 中，已按单班次输出"
			)
			departures = [base_time]

		for departure in departures:
			offset = 0
			departure_minutes = time_to_minutes(departure)
			if base_minutes is not None and departure_minutes is not None:
				offset = departure_minutes - base_minutes

			processed_routes.append(
				{
					"id": route_id,
					"uid": f"{route_id}@{departure}" if departure else str(route_id),
					"departure": departure,
					"dates": list(schedule.get(departure, [])) if isinstance(departure, str) else [],
					"route_name": route.get("name"),
					"bus_id": route.get("bus_id"),
					"stops": [{**stop, "time": shift_time(stop["time"], offset)} for stop in stops],
				}
			)

	return {
		"label_id": DEFAULT_LABEL_ID,
		"label_name": "跨境通勤线",
		"route_count": len(processed_routes),
		"routes": processed_routes,
	}


def main() -> int:
	try:
		routes_payload = get_cross_border_routes()
		save_json(routes_payload, ROUTES_OUTPUT)
		print_route_summary(routes_payload)

		routes = routes_payload.get("data", [])
		if not isinstance(routes, list):
			raise RouteApiError("线路接口返回的 data 不是列表")

		stops_by_route_id: dict[int, dict[str, Any]] = {}
		schedule_by_route_id: dict[int, dict[str, list[str]]] = {}
		for index, route in enumerate(routes, start=1):
			if not isinstance(route, dict) or not isinstance(route.get("id"), int):
				print(f"跳过第 {index} 条无效线路: {route!r}", file=sys.stderr)
				continue
			route_id = route["id"]

			try:
				schedule = get_route_schedule(route_id)
			except RouteApiError as exc:
				print(f"获取线路 {route_id} 发车时间失败，将按站点时刻兜底: {exc}", file=sys.stderr)
				schedule = {}

			try:
				stops_payload = get_route_stops(route_id)
			except RouteApiError as exc:
				print(f"获取线路 {route_id} 详情失败: {exc}", file=sys.stderr)
				continue

			output_path = OUTPUT_DIR / f"route_{route_id}.json"
			save_json(stops_payload, output_path)
			stops_by_route_id[route_id] = stops_payload
			schedule_by_route_id[route_id] = schedule
			departure_text = (
				"、".join(
					f"{time_text}（{len(dates)} 天）" for time_text, dates in schedule.items()
				)
				if schedule
				else "未返回发车时间"
			)
			print(
				f"[{index}/{len(routes)}] 线路 {route_id} 详情已保存: {output_path}"
				f"（发车时间：{departure_text}）"
			)

		warnings: list[str] = []
		processed_payload = build_processed_payload(
			routes, stops_by_route_id, schedule_by_route_id, warnings
		)
		for warning in warnings:
			print(f"提示: {warning}", file=sys.stderr)
		save_json(processed_payload, PROCESSED_OUTPUT)
		print(
			f"整理后的班次数据已保存到: {PROCESSED_OUTPUT}"
			f"（共 {processed_payload['route_count']} 个班次）"
		)
		print(f"所有内容已保存到: {OUTPUT_DIR}")

		sync_date = today_in_beijing()
		if update_sync_date(CONFIG_PATH, sync_date):
			print(f"config.js 中的数据同步日期已更新为: {sync_date}")
	except (RouteApiError, ValueError, OSError) as exc:
		print(f"获取班次失败: {exc}", file=sys.stderr)
		return 1
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
