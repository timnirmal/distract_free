// main.js
const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const path = require('path');
const activeWin = require('active-win');
const screenshotDesktop = require('screenshot-desktop');
const OpenAI = require('openai').default;

// lowdb imports
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');

const client = new OpenAI(); // expects OPENAI_API_KEY in env

let mainWindow;

// —————— Setup lowdb JSON store ———————————————————————————————————
// Create (or open) db.json in your userData folder with a default structure
const dbPath  = path.join(app.getPath('userData'), 'db.json');
const adapter = new JSONFileSync(dbPath);
const db      = new LowSync(adapter, { distractions: [] }); 
db.read();                // load data (or defaultData if file missing) :contentReference[oaicite:0]{index=0}
db.data ||= { distractions: [] };
db.write();               // ensure file exists

// IPC so renderer can fetch history
ipcMain.handle('get-distraction-history', () => {
  return db.data.distractions
    .slice()
    .sort((a, b) => b.start - a.start);
});

// Record a completed distraction into lowdb
function recordDistraction(process, title, start, end) {
  const duration = end - start;
  const rec = { process, title, start, end, duration };

  db.read();
  db.data.distractions.push(rec);
  db.write();

  mainWindow.webContents.send('distraction-recorded', rec);
}

// —————— Electron window & notifications —————————————————————————
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800, height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');
}

function notify(title, body) {
  new Notification({ title, body }).show();
}

// —————— OpenAI classification & analysis —————————————————————————
async function classifyWindow(title, proc) {
  const system = `
You are a lightweight classifier. Given a window title and process name, decide if the user is distracted (e.g. social media, games) or it's OK for work.
Also decide if you need a screenshot for deeper analysis.
  `.trim();

  const user = `
Window title: \`${title}\`
Process: \`${proc}\`

Return *only* JSON with keys:
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
  } catch (err) {
    console.error("OpenAI error:", err);
    return { classification: "ok", screenshot: false };
  }

  const jsonStr = (resp.output_text || "").trim();
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("JSON.parse failed:", jsonStr, err);
    return { classification: "ok", screenshot: false };
  }
}

async function analyzeScreenshot(buffer) {
  const b64 = buffer.toString('base64');
  const payload = [
    {
      role: 'user',
      content: [
        { type: 'input_text',  text: 'Does this screenshot show distraction or work-related content?' },
        { type: 'input_image', image_url: `data:image/png;base64,${b64}` }
      ]
    }
  ];
  const resp = await client.responses.create({
    model: 'gpt-4.1-mini',
    input: payload
  });
  return (resp.output_text || "").trim();
}

// —————— Main watcher loop ——————————————————————————————————————
function startWatcher() {
  let lastTitle      = '';
  let lastClass      = 'ok';
  let screenshotMode = false;
  let nextScreenshot = 0;
  let currentStart   = 0;

  setInterval(async () => {
    try {
      const win   = await activeWin();
      const title = win.title || '';
      const proc  = win.owner?.name || 'unknown';

      if (title && title !== lastTitle) {
        const info = await classifyWindow(title, proc);

        // distraction started?
        if (info.classification === 'distraction' && lastClass !== 'distraction') {
          currentStart = Date.now();
          notify('🚨 Distraction Started', `${proc} — ${title}`);
        }

        // distraction ended?
        if (info.classification !== 'distraction' && lastClass === 'distraction') {
          const end = Date.now();
          recordDistraction(proc, lastTitle, currentStart, end);
          notify('✅ Distraction Ended', `${lastTitle} for ${Math.round((end-currentStart)/1000)}s`);
        }

        lastClass      = info.classification;
        screenshotMode = info.screenshot;
        lastTitle      = title;

        mainWindow.webContents.send('status-update', {
          classification: lastClass,
          process: proc,
          title
        });
      }

      // screenshot analysis every minute if requested
      if (screenshotMode && Date.now() >= nextScreenshot) {
        const imgBuf   = await screenshotDesktop();
        const analysis = await analyzeScreenshot(imgBuf);
        notify('🔍 Screenshot Analysis', analysis.split('\n')[0]);
        mainWindow.webContents.send('screenshot-analysis', { text: analysis });
        nextScreenshot = Date.now() + 60_000;
      }
    } catch (e) {
      console.error('Watcher error:', e);
    }
  }, 1_000);
}

// —————— App lifecycle ————————————————————————————————————————
app.whenReady().then(() => {
  createWindow();
  startWatcher();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
