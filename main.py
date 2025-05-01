#!/usr/bin/env python3
"""
active_window_logger.py

Logs active window title and process name with timestamps.
"""

import time
import csv
import os
from datetime import datetime

import win32gui
import win32process
import psutil

LOG_FILE = "window_activity_log.csv"
POLL_INTERVAL = 1.0  # seconds

def get_active_window_info():
    """Return (window_title, process_name) of the foreground window."""
    hwnd = win32gui.GetForegroundWindow()
    title = win32gui.GetWindowText(hwnd)
    # get process ID
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    try:
        proc = psutil.Process(pid)
        proc_name = proc.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        proc_name = "<unknown>"
    return title, proc_name

def init_log_file(path):
    """Create CSV with header if not exists."""
    if not os.path.exists(path):
        with open(path, mode="w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["timestamp", "window_title", "process_name"])

def log_activity(path, title, proc_name):
    """Append one row to the CSV log."""
    timestamp = datetime.now().isoformat(sep=" ", timespec="seconds")
    with open(path, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([timestamp, title, proc_name])

def main():
    print(f"Starting active-window logger (polling every {POLL_INTERVAL}s).")
    init_log_file(LOG_FILE)

    last_title, last_proc = None, None
    try:
        while True:
            title, proc = get_active_window_info()
            # Only log when active window changes
            if title != last_title or proc != last_proc:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] {proc} - {title}")
                log_activity(LOG_FILE, title, proc)
                last_title, last_proc = title, proc
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        print("\nLogger stopped by user.")

if __name__ == "__main__":
    main()
