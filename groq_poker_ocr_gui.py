#!/usr/bin/env python3
"""Poker OCR via Groq Vision with local HTML GUI (start/stop loop)."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
LEGACY_MODEL = "llama-3.2-90b-vision-preview"


HTML_PAGE = """<!doctype html><html><body><h1>Poker OCR API server is running</h1></body></html>"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_prompt(prompt_path: Path) -> str:
    return prompt_path.read_text(encoding="utf-8").strip()


def encode_image(image_path: Path) -> str:
    return base64.b64encode(image_path.read_bytes()).decode("utf-8")


def load_env_key_from_dotenv(dotenv_path: Path = Path(".env")) -> str | None:
    if not dotenv_path.exists():
        return None
    for line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == "GROQ_API_KEY":
            return value.strip().strip('"').strip("'")
    return None


def run_ocr(api_key: str, image_path: Path, prompt_path: Path, model: str) -> str:
    try:
        from groq import Groq
    except ImportError as exc:
        raise RuntimeError("Package 'groq' is not installed. Run: pip3 install groq==0.9.0 httpx==0.27.2 pydantic<2") from exc

    prompt_text = read_prompt(prompt_path)
    image_data = encode_image(image_path)
    client = Groq(api_key=api_key)

    payload = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{image_data}"},
                },
                {"type": "text", "text": prompt_text},
            ],
        }
    ]

    try:
        response = client.chat.completions.create(model=model, messages=payload)
    except Exception as exc:
        if LEGACY_MODEL in str(exc) and model == LEGACY_MODEL:
            response = client.chat.completions.create(model=DEFAULT_MODEL, messages=payload)
        else:
            raise

    content = response.choices[0].message.content
    text = content.strip() if isinstance(content, str) else str(content).strip()
    return normalize_ocr_output(text)


def normalize_ocr_output(raw_text: str) -> str:
    """Force stable OCR output format: Board/Players only."""
    text = (raw_text or "").replace("\r\n", "\n").strip()
    if not text:
        return "Board: none\n\nPlayers:"

    lines = [line.strip() for line in text.split("\n") if line.strip()]
    board_line_raw = next((line for line in lines if line.startswith("Board:")), None)
    players_line = next((line for line in lines if line.startswith("Players:")), None)
    board_line = "Board: none"
    if board_line_raw:
        board_value = board_line_raw.split("Board:", 1)[1].strip()
        if "none" in board_value.lower():
            board_line = "Board: none"
        else:
            card_pattern = re.compile(r"\b([2-9TJQKA][hdcs])\b")
            cards = card_pattern.findall(board_value)
            board_line = f"Board: {' '.join(cards)}" if cards else "Board: none"

    if players_line:
        idx = lines.index(players_line)
        player_rows: list[str] = []
        for row in lines[idx + 1:]:
            if "|" not in row:
                continue
            parts = [part.strip() for part in row.split("|")]
            if len(parts) < 3:
                continue
            p0 = re.sub(r"[^a-z]", "", parts[0].lower())
            p1 = re.sub(r"[^a-z]", "", parts[1].lower())
            p2 = re.sub(r"[^a-z]", "", parts[2].lower())
            if p0 == "nickname":
                continue
            if p0 == "nickname" and p1 == "cards" and p2.startswith("stack"):
                continue
            if p1 == "cards" and p2.startswith("stack"):
                continue
            clean_parts = parts[:4]
            player_rows.append(" | ".join(clean_parts))
        if player_rows:
            return board_line + "\n\nPlayers:\n" + "\n".join(player_rows)
        return board_line + "\n\nPlayers:"

    card_pattern = re.compile(r"\b([2-9TJQKA][hdcs])\b")
    cards = card_pattern.findall(text)
    board_guess = " ".join(cards[:5]) if cards else "none"
    return f"Board: {board_guess}\n\nPlayers:"


def take_screenshot(
    temp_dir: Path,
    timeout_sec: float = 10.0,
    region: tuple[int, int, int, int] | None = None,
) -> Path:
    temp_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="poker_ocr_", suffix=".png", dir=temp_dir, delete=False) as handle:
        screenshot_path = Path(handle.name)
    cmd = ["screencapture", "-x"]
    if region is not None:
        x, y, w, h = region
        cmd.extend(["-R", f"{x},{y},{w},{h}"])
    cmd.append(str(screenshot_path))
    try:
        subprocess.run(
            cmd,
            check=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired as exc:
        screenshot_path.unlink(missing_ok=True)
        raise RuntimeError("Screenshot timed out. Check Screen Recording permission.") from exc
    return screenshot_path


class OCRService:
    def __init__(
        self,
        api_key: str,
        prompt_path: Path,
        output_txt: Path,
        temp_dir: Path,
        model: str,
        interval_sec: float,
    ) -> None:
        self.api_key = api_key
        self.prompt_path = prompt_path
        self.output_txt = output_txt
        self.temp_dir = temp_dir
        self.model = model

        self._interval_sec = max(1.0, interval_sec)
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._running = False

        self.latest_result = ""
        self.last_error = ""
        self.last_update = ""
        self.total_runs = 0
        self.last_screenshot_path = self.output_txt.parent / "last_capture.png"
        self.last_screenshot_update = ""
        self._region: tuple[int, int, int, int] | None = None

    def _cleanup_stale_temp_screenshots(self) -> None:
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        for path in self.temp_dir.glob("poker_ocr_*.png"):
            path.unlink(missing_ok=True)

    def status(self) -> dict[str, Any]:
        with self._lock:
            region = self._region
            return {
                "running": self._running,
                "interval_sec": self._interval_sec,
                "latest_result": self.latest_result,
                "last_error": self.last_error,
                "last_update": self.last_update,
                "total_runs": self.total_runs,
                "region": {
                    "x": region[0],
                    "y": region[1],
                    "width": region[2],
                    "height": region[3],
                } if region is not None else None,
                "last_screenshot_update": self.last_screenshot_update,
            }

    def start(
        self,
        interval_sec: float | None = None,
        region: tuple[int, int, int, int] | None = None,
        set_region: bool = False,
    ) -> None:
        with self._lock:
            if interval_sec is not None:
                self._interval_sec = max(1.0, float(interval_sec))
            if set_region:
                self._region = region
            if self._running:
                return
            self._cleanup_stale_temp_screenshots()
            self._running = True
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()

    def stop(self) -> None:
        thread: threading.Thread | None
        with self._lock:
            if not self._running:
                return
            self._running = False
            self._stop_event.set()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=3)

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            started_at = time.monotonic()
            self._process_cycle()

            with self._lock:
                interval = self._interval_sec
            elapsed = time.monotonic() - started_at
            wait_time = max(0.0, interval - elapsed)
            if self._stop_event.wait(wait_time):
                break

    def _process_cycle(self) -> None:
        screenshot_path: Path | None = None
        try:
            with self._lock:
                region = self._region
            screenshot_path = take_screenshot(self.temp_dir, region=region)
            self.output_txt.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(screenshot_path, self.last_screenshot_path)
            result = run_ocr(
                api_key=self.api_key,
                image_path=screenshot_path,
                prompt_path=self.prompt_path,
                model=self.model,
            )
            text = result or "(empty response)"
            self.output_txt.write_text(text, encoding="utf-8")

            with self._lock:
                self.latest_result = text
                self.last_error = ""
                self.last_update = now_iso()
                self.last_screenshot_update = self.last_update
                self.total_runs += 1
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self.last_error = str(exc)
                self.last_update = now_iso()
                self.total_runs += 1
        finally:
            # Screenshot is always removed after OCR cycle (success or failure).
            if screenshot_path and screenshot_path.exists():
                screenshot_path.unlink(missing_ok=True)

    def run_once(
        self,
        region: tuple[int, int, int, int] | None = None,
        set_region: bool = False,
    ) -> None:
        if set_region:
            with self._lock:
                self._region = region
        self._process_cycle()


class OCRHandler(BaseHTTPRequestHandler):
    service: OCRService

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    @staticmethod
    def _parse_region(payload: dict[str, Any]) -> tuple[int, int, int, int] | None:
        region = payload.get("region")
        if region is None:
            return None
        if not isinstance(region, dict):
            raise ValueError("region must be an object")

        keys = ("x", "y", "width", "height")
        if not all(key in region for key in keys):
            raise ValueError("region must include x, y, width, height")

        try:
            x = int(region["x"])
            y = int(region["y"])
            width = int(region["width"])
            height = int(region["height"])
        except (TypeError, ValueError) as exc:
            raise ValueError("region values must be integers") from exc

        if width <= 0 or height <= 0:
            raise ValueError("region width/height must be > 0")
        if x < 0 or y < 0:
            raise ValueError("region x/y must be >= 0")
        return (x, y, width, height)

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/":
            body = HTML_PAGE.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self._send_cors_headers()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/status":
            self._send_json(HTTPStatus.OK, self.service.status())
            return

        if path == "/api/last-screenshot":
            image_path = self.service.last_screenshot_path
            if not image_path.exists():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "no screenshot yet"})
                return
            body = image_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self._send_cors_headers()
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/start":
            payload = self._read_json()
            interval = payload.get("interval_sec")
            try:
                interval_num = float(interval) if interval is not None else None
                region = self._parse_region(payload)
            except (TypeError, ValueError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid interval_sec or region"})
                return
            self.service.start(
                interval_num,
                region=region,
                set_region=("region" in payload),
            )
            self._send_json(HTTPStatus.OK, self.service.status())
            return

        if path == "/api/stop":
            self.service.stop()
            self._send_json(HTTPStatus.OK, self.service.status())
            return

        if path == "/api/run-once":
            payload = self._read_json()
            try:
                region = self._parse_region(payload)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self.service.run_once(region=region, set_region=("region" in payload))
            self._send_json(HTTPStatus.OK, self.service.status())
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})


def open_window(url: str) -> None:
    if os.name == "posix":
        subprocess.run(["open", url], check=False)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Poker OCR web GUI using Groq Vision.")
    parser.add_argument("--prompt", default="config/poker_prompt.txt", help="Path to OCR prompt file.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Groq model (default: {DEFAULT_MODEL}).")
    parser.add_argument("--api-key", default=os.getenv("GROQ_API_KEY"), help="Groq API key (or .env).")
    parser.add_argument("--output", default="data/ocr_result.txt", help="Path to latest OCR text output.")
    parser.add_argument("--temp-dir", default="data/tmp", help="Temp folder for screenshots.")
    parser.add_argument("--interval", type=float, default=1.0, help="Default OCR interval in seconds.")
    parser.add_argument("--host", default="127.0.0.1", help="Web UI host.")
    parser.add_argument("--port", type=int, default=8765, help="Web UI port.")
    parser.add_argument("--no-open", action="store_true", help="Do not auto-open browser window.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    prompt_path = Path(args.prompt).expanduser().resolve()
    output_txt = Path(args.output).expanduser().resolve()
    temp_dir = Path(args.temp_dir).expanduser().resolve()

    api_key = args.api_key or load_env_key_from_dotenv()
    if not api_key:
        raise SystemExit("GROQ API key is missing. Set GROQ_API_KEY, .env, or pass --api-key.")
    if not prompt_path.exists():
        raise SystemExit(f"Prompt file not found: {prompt_path}")

    service = OCRService(
        api_key=api_key,
        prompt_path=prompt_path,
        output_txt=output_txt,
        temp_dir=temp_dir,
        model=args.model,
        interval_sec=args.interval,
    )

    OCRHandler.service = service
    server = ThreadingHTTPServer((args.host, args.port), OCRHandler)
    url = f"http://{args.host}:{args.port}"

    print(f"Poker OCR GUI: {url}")
    if not args.no_open:
        open_window(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
        server.server_close()


if __name__ == "__main__":
    main()
