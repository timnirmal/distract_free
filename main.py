#!/usr/bin/env python3
"""
debug_distraction_watcher.py

Same as before, but with prints on every major step so you can see what’s happening.
"""

import os
import time
import json
import re
import datetime

import win32gui
import win32process
import psutil
import mss
from plyer import notification
from openai import OpenAI

from dotenv import load_dotenv
load_dotenv()  # Load environment variables from .env file

# ─── CONFIG ─────────────────────────────────────────────────────────────────────
POLL_INTERVAL      = 1.0      # seconds between window polls
SCREENSHOT_DIR     = "screenshots"
MIN_SCREENSHOT_INT = 60.0     # seconds between screenshots once enabled

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# ─── UTILITIES ──────────────────────────────────────────────────────────────────
def get_active_window_info():
    hwnd = win32gui.GetForegroundWindow()
    title = win32gui.GetWindowText(hwnd)
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    try:
        proc_name = psutil.Process(pid).name()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        proc_name = "<unknown>"
    return title, proc_name

def notify(title, msg):
    notification.notify(title=title, message=msg, app_name="Watcher", timeout=5)

def capture_screenshot():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(SCREENSHOT_DIR, f"screenshot_{ts}.png")
    with mss.mss() as sct:
        sct.shot(output=path)
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Screenshot saved: {path}")
    return path

# ─── SANITIZER ───────────────────────────────────────────────────────────────────
def sanitize_response(response_content: str) -> dict:
    m = re.search(r'\{.*\}', response_content, re.DOTALL)
    if not m:
        raise ValueError("No JSON object found in response")
    raw = m.group()
    raw = re.sub(r'(?<!\\)[\n\r\t]', '', raw)
    raw = raw.replace('\\', '\\\\')
    print(f"Sanitized JSON string: {raw}")
    return json.loads(raw)

# ─── CLASSIFIER ──────────────────────────────────────────────────────────────────
def classify_window(title: str, proc: str) -> dict:
    system = (
        "You are a lightweight classifier. "
        "Given a window title and process name, decide if the user is distracted "
        "(e.g. social media, games) or it's okay for work. "
        "Also decide if you need a screenshot for deeper analysis."
    )
    user = (
        f"Window title: `{title}`\n"
        f"Process: `{proc}`\n\n"
        "Return *only* JSON with keys:\n"
        "  - classification: \"distraction\" or \"ok\"\n"
        "  - screenshot: true or false"
    )

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Calling OpenAI for '{proc} — {title}'")
    resp = client.responses.create(
        model="gpt-4.1",
        input=f"{system}\n\n{user}"
    )

    # assemble raw text
    text = ""
    if getattr(resp, "output", None):
        for msg in resp.output:
            for chunk in getattr(msg, "content", []):
                text += chunk.text
    else:
        text = resp.choices[0].message.content

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Raw LLM response:\n{text}")
    try:
        info = sanitize_response(text)
        print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Parsed info: {info}")
        return info
    except Exception as e:
        print(f"⚠️  Sanitization failed ({e}), defaulting to ok/no-screenshot")
        return {"classification": "ok", "screenshot": False}

# ─── MAIN LOOP ──────────────────────────────────────────────────────────────────
def main():
    print("🔍 Starting Debug DistractionWatcher…")
    last_title = None
    screenshot_mode = False
    next_ss_time = 0.0

    try:
        while True:
            title, proc = get_active_window_info()

            # Always show what window we see
            print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Active window: '{proc}' — '{title}'")

            if title != last_title:
                info = classify_window(title, proc)
                clsf = info.get("classification", "ok")
                want_ss = info.get("screenshot", False)

                if clsf == "distraction":
                    print(f"🚨 Distraction detected: {proc} — {title}")
                    notify("🚨 Distraction Detected", f"{proc} — {title}")
                else:
                    print(f"✔️  OK window: {proc} — {title}")

                screenshot_mode = want_ss
                if screenshot_mode:
                    print("📸 Screenshot mode ON")
                    next_ss_time = time.time()
                else:
                    print("📷 Screenshot mode OFF")

                last_title = title

            # screenshots every minute if enabled
            if screenshot_mode and time.time() >= next_ss_time:
                capture_screenshot()
                next_ss_time = time.time() + MIN_SCREENSHOT_INT

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        print("\n👋 Debug DistractionWatcher stopped by user.")

if __name__ == "__main__":
    main()
