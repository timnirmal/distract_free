#!/usr/bin/env python3
"""
distraction_watcher_with_image.py

– Polls active window & classifies via GPT-4.1
– When screenshot_mode=True, captures a shot every minute
– Encodes & sends that shot as base64 with a text prompt to the LLM
– Logs & notifies you of what the model finds
"""

import os
import time
import json
import re
import datetime
import base64

import win32gui
import win32process
import psutil
import mss
from plyer import notification
from openai import OpenAI
from dotenv import load_dotenv

# ─── CONFIG ─────────────────────────────────────────────────────────────────────
load_dotenv()
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

import tkinter as tk
import threading

def show_popup(title, message, duration=5000):
    def popup():
        win = tk.Tk()
        win.title(title)
        win.attributes("-topmost", True)
        win.geometry("300x100+100+100")  # width x height + x + y
        label = tk.Label(win, text=message, font=("Arial", 12))
        label.pack(expand=True, fill="both")
        # close after duration milliseconds
        win.after(duration, win.destroy)
        win.mainloop()

    # run popup in a separate thread
    threading.Thread(target=popup, daemon=True).start()


def notify(title: str, msg: str):
    notification.notify(title=title, message=msg, app_name="DistractionWatcher", timeout=5)

def capture_screenshot() -> str:
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(SCREENSHOT_DIR, f"screenshot_{ts}.png")
    with mss.mss() as sct:
        sct.shot(output=path)
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Screenshot saved: {path}")
    return path

# ─── IMAGE ENCODING & ANALYSIS ──────────────────────────────────────────────────
def encode_image(image_path: str) -> str:
    with open(image_path, "rb") as img:
        return base64.b64encode(img.read()).decode("utf-8")

def analyze_screenshot(image_path: str) -> str:
    """
    Sends the screenshot to GPT-4.1 with a simple prompt.
    Returns the raw text reply.
    """
    b64 = encode_image(image_path)
    # build the input payload
    payload = [
        {
            "role": "user",
            "content": [
                {"type": "input_text",  "text": "Please describe whether this screen shows a distraction (e.g., YouTube, social, gaming) or work-related content."},
                {"type": "input_image", "image_url": f"data:image/png;base64,{b64}"}
            ]
        }
    ]

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Calling OpenAI image analysis…")
    resp = client.responses.create(
        model="gpt-4.1",
        input=payload
    )

    # assemble the reply text
    text = ""
    if getattr(resp, "output", None):
        for msg in resp.output:
            for chunk in getattr(msg, "content", []):
                text += chunk.text
    else:
        # fallback for older client shapes
        text = resp.choices[0].message.content

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Image analysis result:\n{text.strip()}")
    return text.strip()

# ─── SANITIZER (optional for JSON replies) ────────────────────────────────────────
def sanitize_response(response_content: str) -> dict:
    m = re.search(r'\{.*\}', response_content, re.DOTALL)
    if not m:
        raise ValueError("No JSON object found in response")
    raw = m.group()
    raw = re.sub(r'(?<!\\)[\n\r\t]', '', raw).replace('\\', '\\\\')
    return json.loads(raw)

# ─── CLASSIFIER (text-only) ─────────────────────────────────────────────────────
def classify_window(title: str, proc: str) -> dict:
    system = (
        "You are a lightweight classifier. "
        "Given a window title and process name, decide if the user is distracted "
        "(e.g. social, games) or it's OK for work. "
        "Also decide if you need a screenshot for deeper analysis."
    )
    user = (
        f"Window title: `{title}`\n"
        f"Process: `{proc}`\n\n"
        "Return *only* JSON with keys:\n"
        "  - classification: \"distraction\" or \"ok\"\n"
        "  - screenshot: true or false"
    )

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Classifying window…")
    resp = client.responses.create(model="gpt-4.1", input=f"{system}\n\n{user}")

    # assemble raw JSON text
    text = ""
    if getattr(resp, "output", None):
        for msg in resp.output:
            for chunk in getattr(msg, "content", []):
                text += chunk.text
    else:
        text = resp.choices[0].message.content

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Raw classifier response:\n{text}")
    try:
        info = sanitize_response(text)
        print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Parsed classifier info: {info}")
        return info
    except Exception as e:
        print(f"⚠️  Classifier sanitization failed ({e}), defaulting to ok/no-screenshot")
        return {"classification": "ok", "screenshot": False}

# ─── MAIN LOOP ──────────────────────────────────────────────────────────────────
def main():
    print("🔍 Starting DistractionWatcher with Image Analysis…")
    last_title = None
    screenshot_mode = False
    next_ss_time = 0.0

    try:
        while True:
            title, proc = get_active_window_info()
            print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Active: {proc} — {title}")

            if title != last_title:
                info = classify_window(title, proc)
                clsf = info.get("classification","ok")
                want_ss = info.get("screenshot", False)

                if clsf == "distraction":
                    print(f"🚨 Distraction detected: {proc}")
                    show_popup("🚨 Distraction Detected", f"{proc} — {title}")
                else:
                    print(f"✔️  OK window: {proc}")

                screenshot_mode = want_ss
                print(f"📷 Screenshot mode: {'ON' if want_ss else 'OFF'}")
                if want_ss:
                    next_ss_time = time.time()
                last_title = title

            # if in screenshot mode, every minute capture & analyze
            if screenshot_mode and time.time() >= next_ss_time:
                shot_path = capture_screenshot()
                result   = analyze_screenshot(shot_path)
                show_popup("🔍 Screenshot Analysis", result.split("\n")[0])  # first line
                next_ss_time = time.time() + MIN_SCREENSHOT_INT

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        print("\n👋 Stopped by user.")

if __name__ == "__main__":
    main()
