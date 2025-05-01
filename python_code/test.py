from win10toast import ToastNotifier
import time

toaster = ToastNotifier()
toaster.show_toast("🍵 Test Notification", "If you see this, toast works!", duration=5)
# keep the script alive until the toast disappears
time.sleep(6)
