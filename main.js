// main.js
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const activeWin = require('active-win');
const screenshotDesktop = require('screenshot-desktop');
const OpenAI = require('openai').default;
const { windowManager } = require('node-window-manager');  // ← NEW
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');

const client = new OpenAI();            // needs OPENAI_API_KEY in env
const sessionStart = Date.now();

let mainWindow;
let isPaused = false;
let stickyToastWindow = null;
let lastWorkingWindow = null;           // ← NEW: track last “good” window

// — lowdb setup —————————————————————————————————————————————
const dbPath  = path.join(app.getPath('userData'), 'db.json');
const adapter = new JSONFileSync(dbPath);
const db      = new LowSync(adapter, { distractions: [] });
db.read();
db.data ||= { distractions: [] };
db.write();

// — IPC handlers —————————————————————————————————————————————
// Provide history
ipcMain.handle('get-distraction-history', () =>
  db.data.distractions.slice().sort((a, b) => b.start - a.start)
);
// Pause/resume state
ipcMain.handle('get-paused-state', () => isPaused);
ipcMain.on('toggle-pause', () => {
  isPaused = !isPaused;
  mainWindow.webContents.send('paused-state', isPaused);
  popToast(
    isPaused
      ? `⏸️ <strong>Paused</strong><br>Enjoy your break!`
      : `▶️ <strong>Resumed</strong><br>Back to focus!`
  );
});
// Back to focus click
ipcMain.on('back-to-focus', () => {
  if (!lastWorkingWindow) return;
  let countdown = 1;
  const iv = setInterval(() => {
    popToast(`🔙 <strong>Returning in ${countdown}s</strong>`, { sticky: true });
    countdown--;
    if (countdown < 0) {
      clearInterval(iv);
      // close sticky toast
      if (stickyToastWindow && !stickyToastWindow.isDestroyed()) {
        stickyToastWindow.close();
        stickyToastWindow = null;
      }
      // bring the real previous window to front
      try {
        lastWorkingWindow.bringToTop();
        lastWorkingWindow.focus();
      } catch (err) {
        console.error("Failed to focus last window:", err);
      }
    }
  }, 1000);
});

// Send session start to renderer
function sendSessionStart() {
  mainWindow.webContents.send('session-start', sessionStart);
}

// — Popup helper ————————————————————————————————————————
function showPopupToast(html, duration = 5000, sticky = false) {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 400, h = sticky ? 120 : 80;
  const x = workArea.x + workArea.width  - w - 20;
  const y = workArea.y + workArea.height - h - 20;

  if (sticky && stickyToastWindow) {
    stickyToastWindow.close();
    stickyToastWindow = null;
  }

  const toastWin = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    focusable: false, resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  // Add actionable buttons when sticky
  let actions = "";
  if (sticky) {
    actions = `
      <div style="margin-top:8px; text-align:center;">
        <button id="focusBtn" style="margin-right:8px;">✅ Back to Focus</button>
        <button id="breakBtn">⏸️ Take a Break</button>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        document.getElementById('focusBtn').addEventListener('click', () => ipcRenderer.send('back-to-focus'));
        document.getElementById('breakBtn').addEventListener('click', () => ipcRenderer.send('toggle-pause'));
      </script>
    `;
  }

  const page = `
    <!DOCTYPE html>
    <html><body style="
      margin:0; padding:10px;
      background:rgba(0,0,0,0.85);
      color:#fff; font-family:sans-serif;
      display:flex; flex-direction:column; justify-content:center;
      align-items:center;
    ">
      <div>${html}</div>
      ${actions}
    </body></html>
  `;

  toastWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));

  if (sticky) {
    stickyToastWindow = toastWin;
  } else {
    setTimeout(() => {
      if (!toastWin.isDestroyed()) toastWin.close();
    }, duration);
  }
}

function popToast(html, opts = {}) {
  if (!isPaused) {
    showPopupToast(html, opts.duration, opts.sticky);
  }
}

// — Record distraction & clear sticky —————————————————————————
function recordDistraction(proc, title, start, end) {
  if (stickyToastWindow && !stickyToastWindow.isDestroyed()) {
    stickyToastWindow.close();
    stickyToastWindow = null;
  }
  const rec = { process: proc, title, start, end, duration: end - start };
  db.read();
  db.data.distractions.push(rec);
  db.write();
  mainWindow.webContents.send('distraction-recorded', rec);
}

// — Create main window —————————————————————————————————————
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 700,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', sendSessionStart);
}

// — GPT-4.1 classification ————————————————————————————————————
async function classifyWindow(title, proc) {
  const system = `
You are a lightweight classifier. Given a window title and process name,
decide if the user is distracted (social media, games) or it's OK for work.
Also decide if you need a screenshot for deeper analysis.
  `.trim();
  const user = `
Window title: \`${title}\`
Process: \`${proc}\`

Return only JSON:
  - classification: "distraction" or "ok"
  - screenshot: true or false
  `.trim();

  let resp;
  try {
    resp = await client.responses.create({
      model: "gpt-4.1",
      instructions: system,
      input: user
    });
  } catch {
    return { classification: "ok", screenshot: false };
  }
  try {
    return JSON.parse((resp.output_text || "").trim());
  } catch {
    return { classification: "ok", screenshot: false };
  }
}

// — GPT-4.1-mini image analysis —————————————————————————————————
async function analyzeScreenshot(buf) {
  const b64 = buf.toString('base64');
  const payload = [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'Work-related or distraction?' },
      { type: 'input_image', image_url: `data:image/png;base64,${b64}` }
    ]
  }];
  let resp;
  try {
    resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: payload
    });
  } catch {
    return "";
  }
  return (resp.output_text || "").trim();
}

// — Watcher loop ————————————————————————————————————————
function startWatcher() {
  let lastTitle = "";
  let lastClass = "ok";
  let screenshotMode = false;
  let nextScreenshot = 0;
  let currentStart = 0;

  setInterval(async () => {
    if (isPaused) return;

    const win   = await activeWin();
    const title = win.title || "";
    const proc  = win.owner?.name || "unknown";

    if (title && title !== lastTitle) {
        const info = await classifyWindow(title, proc);
      
        // NEW: only capture the window handle if this one is OK
        if (info.classification === "ok") {
          try {
            const w = windowManager.getActiveWindow();
            // skip our own UI
            if (
              w &&
              w.processId !== process.pid &&
              !w.getTitle().includes("Distraction Free")
            ) {
              lastWorkingWindow = w;
            }
          } catch (e) {
            console.error("Error capturing lastWorkingWindow:", e);
          }
        }
      
        // Distraction started
        if (info.classification === "distraction" && lastClass !== "distraction") {
          currentStart = Date.now();
          popToast(
            `🚨 <strong>Distraction Detected</strong><br>${proc} — ${title}`,
            { sticky: true }
          );
        }
      
        // Distraction ended
        if (info.classification !== "distraction" && lastClass === "distraction") {
          const end = Date.now();
          recordDistraction(proc, lastTitle, currentStart, end);
          popToast(
            `✅ <strong>Back to Work</strong><br>${lastTitle} for ${Math.round(
              (end - currentStart) / 1000
            )}s`
          );
        }
      
        lastClass = info.classification;
        screenshotMode = info.screenshot;
        lastTitle = title;
      
        mainWindow.webContents.send("status-update", {
          classification: lastClass,
          process: proc,
          title,
        });
      }
      

    // Screenshot logic unchanged
    if (screenshotMode && Date.now() >= nextScreenshot) {
      const buf  = await screenshotDesktop();
      const txt  = await analyzeScreenshot(buf);
      popToast(`🔍 <strong>Screenshot Analysis</strong><br>${txt.split("\n")[0]}`);
      mainWindow.webContents.send("screenshot-analysis", { text: txt });
      nextScreenshot = Date.now() + 60_000;
    }
  }, 1000);
}

// — App lifecycle ————————————————————————————————————————
app.whenReady().then(() => {
  createWindow();
  startWatcher();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
