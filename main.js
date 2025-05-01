// main.js
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const activeWin = require('active-win');
const screenshotDesktop = require('screenshot-desktop');
const OpenAI = require('openai').default;
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');

const client = new OpenAI(); // needs OPENAI_API_KEY in env

let mainWindow;
let isPaused = false;           // pause flag
let stickyToastWindow = null;   // holds our “sticky” toast

// —————— lowdb setup —————————————————————————————————————————————
const dbPath  = path.join(app.getPath('userData'), 'db.json');
const adapter = new JSONFileSync(dbPath);
const db      = new LowSync(adapter, { distractions: [] });
db.read();
db.data ||= { distractions: [] };
db.write();

// IPC: history
ipcMain.handle('get-distraction-history', () =>
  db.data.distractions.slice().sort((a,b)=>b.start-a.start)
);

// IPC: pause/resume
ipcMain.handle('get-paused-state', () => isPaused);
ipcMain.on('toggle-pause', () => {
  isPaused = !isPaused;
  mainWindow.webContents.send('paused-state', isPaused);
  popToast(
    isPaused
      ? `⏸️ <strong>Detection Paused</strong><br>Enjoy your break!`
      : `▶️ <strong>Detection Resumed</strong><br>Back to focus!`
  );
});

// —————— Popup helper ————————————————————————————————————————
function showPopupToast(html, duration = 5000, sticky = false) {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 400, h = 80;
  const x = workArea.x + workArea.width  - w - 20;
  const y = workArea.y + workArea.height - h - 20;

  // close any existing sticky if opening a new one
  if (sticky && stickyToastWindow) {
    stickyToastWindow.close();
    stickyToastWindow = null;
  }

  const win = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    focusable: false, resizable: false,
  });

  const htmlPage = `
    <!DOCTYPE html><html><body style="
      margin:0; padding:10px;
      background:rgba(0,0,0,0.85);
      color:#fff; font-family:sans-serif;
      display:flex; align-items:center;
      justify-content:center;
    ">${html}</body></html>
  `;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlPage));

  if (sticky) {
    stickyToastWindow = win;  // remember it
  } else {
    // auto-close after duration
    setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, duration);
  }
}

// wrapper that respects pause
function popToast(html, opts={}) {
  if (!isPaused) {
    showPopupToast(html, opts.duration, opts.sticky);
  }
}

// —————— Record and clear sticky on end ———————————————————————————
function recordDistraction(proc, title, start, end) {
  // close the sticky toast now that distraction ended
  if (stickyToastWindow && !stickyToastWindow.isDestroyed()) {
    stickyToastWindow.close();
    stickyToastWindow = null;
  }

  const duration = end - start;
  const rec = { process: proc, title, start, end, duration };
  db.read();
  db.data.distractions.push(rec);
  db.write();
  mainWindow.webContents.send('distraction-recorded', rec);
}

// —————— Main UI window ——————————————————————————————————————
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800, height: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
}

// —————— GPT-4.1 text classification ——————————————————————————————
async function classifyWindow(title, proc) {
  const system = `
You are a lightweight classifier. Given a window title and process name,
decide if the user is distracted (social, games) or it's OK for work.
Also decide if you need a screenshot for deeper analysis.`.trim();

  const user = `
Window title: \`${title}\`
Process: \`${proc}\`

Return only JSON with:
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
    return JSON.parse((resp.output_text||"").trim());
  } catch {
    return { classification: "ok", screenshot: false };
  }
}

// —————— GPT-4.1-mini image analysis ——————————————————————————————
async function analyzeScreenshot(buf) {
  const b64 = buf.toString('base64');
  const payload = [{
    role:'user', content:[
      {type:'input_text', text:'Is this screenshot work-related or a distraction?'},
      {type:'input_image', image_url:`data:image/png;base64,${b64}`}
    ]
  }];
  const resp = await client.responses.create({
    model:'gpt-4.1-mini', input:payload
  });
  return (resp.output_text||"").trim();
}

// —————— Watcher loop ————————————————————————————————————————
function startWatcher() {
  let lastTitle      = '';
  let lastClass      = 'ok';
  let screenshotMode = false;
  let nextScreenshot = 0;
  let currentStart   = 0;

  setInterval(async () => {
    if (isPaused) return;

    const win   = await activeWin();
    const title = win.title || '';
    const proc  = win.owner?.name || 'unknown';

    if (title && title !== lastTitle) {
      const info = await classifyWindow(title, proc);

      // Distraction started → sticky
      if (info.classification==='distraction' && lastClass!=='distraction') {
        currentStart = Date.now();
        popToast(
          `🚨 <strong>Distraction Detected</strong><br>${proc} — ${title}`,
          { sticky:true }
        );
      }

      // Distraction ended
      if (info.classification!=='distraction' && lastClass==='distraction') {
        const end = Date.now();
        recordDistraction(proc, lastTitle, currentStart, end);
        popToast(`✅ <strong>Back to Work</strong><br>${lastTitle} for ${Math.round((end-currentStart)/1000)}s`);
      }

      lastClass      = info.classification;
      screenshotMode = info.screenshot;
      lastTitle      = title;

      mainWindow.webContents.send('status-update',{
        classification:lastClass, process:proc, title
      });
    }

    if (screenshotMode && Date.now()>=nextScreenshot) {
      const buf = await screenshotDesktop();
      const txt = await analyzeScreenshot(buf);
      popToast(`🔍 <strong>Screenshot Analysis</strong><br>${txt.split('\n')[0]}`);
      mainWindow.webContents.send('screenshot-analysis',{text:txt});
      nextScreenshot = Date.now()+60_000;
    }
  }, 1000);
}

// —————— App lifecycle ————————————————————————————————————————
app.whenReady().then(()=>{
  createWindow();
  startWatcher();
  app.on('activate',()=>{
    if (BrowserWindow.getAllWindows().length===0) createWindow();
  });
});
app.on('window-all-closed',()=>{
  if (process.platform!=='darwin') app.quit();
});
