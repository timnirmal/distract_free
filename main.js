// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const activeWin = require('active-win');
const screenshotDesktop = require('screenshot-desktop');
const OpenAI = require('openai').default;
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');

const client = new OpenAI(); // needs OPENAI_API_KEY in env
let mainWindow;

// —————— Setup lowdb JSON store —————————————————————————————————
const dbPath  = path.join(app.getPath('userData'), 'db.json');
console.log('🗄️  lowdb JSON file path:', dbPath);

const adapter = new JSONFileSync(dbPath);
const db      = new LowSync(adapter, { distractions: [] });

db.read();
db.data ||= { distractions: [] };
db.write();
console.log('🗄️  Initial DB contents:', db.data);

// IPC for renderer to fetch history
ipcMain.handle('get-distraction-history', () => {
  console.log('🔁 Renderer requested history');
  return db.data.distractions
    .slice()
    .sort((a, b) => b.start - a.start);
});

// Send in-app toast to renderer
function popToast(html) {
  console.log('🔔 popToast:', html);
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('pop-toast', html);
  }
}

// Record a completed distraction period
function recordDistraction(proc, title, start, end) {
  const duration = end - start;
  const rec = { process: proc, title, start, end, duration };
  console.log('💾 Recording distraction:', rec);

  db.read();
  db.data.distractions.push(rec);
  db.write();
  console.log('🗄️  DB now has', db.data.distractions.length, 'entries');

  mainWindow.webContents.send('distraction-recorded', rec);
}

// —————— Create the main window ————————————————————————————————
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800, height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools({ mode: 'detach' });
  console.log('🖥️  Main window created and DevTools opened');
}

// —————— OpenAI text classification —————————————————————————————
async function classifyWindow(title, proc) {
  console.log(`🤖 classifyWindow() for [${proc}] – "${title}"`);
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
    console.error("❌ OpenAI error:", err);
    return { classification: "ok", screenshot: false };
  }

  const jsonStr = (resp.output_text || "").trim();
  console.log('📥 Raw classify JSON:', jsonStr);
  try {
    const info = JSON.parse(jsonStr);
    console.log('✅ Parsed classify info:', info);
    return info;
  } catch (err) {
    console.error("❌ JSON.parse failed:", jsonStr, err);
    return { classification: "ok", screenshot: false };
  }
}

// —————— OpenAI image analysis ——————————————————————————————————
async function analyzeScreenshot(buffer) {
  console.log('📷 analyzeScreenshot()');
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
  let resp;
  try {
    resp = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: payload
    });
  } catch (err) {
    console.error("❌ OpenAI image error:", err);
    return '';
  }
  const result = (resp.output_text || "").trim();
  console.log('📥 Raw image analysis:', result);
  return result;
}

// —————— Main watcher loop ——————————————————————————————————————
function startWatcher() {
  console.log('▶️  Starting watcher loop…');
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

      console.log(`🔍 Active window: [${proc}] – "${title}"`);

      if (title && title !== lastTitle) {
        const info = await classifyWindow(title, proc);

        // Distraction started?
        if (info.classification === 'distraction' && lastClass !== 'distraction') {
          currentStart = Date.now();
          popToast(`🚨 <strong>Distraction Detected</strong><br>${proc} — ${title}`);
        }

        // Distraction ended?
        if (info.classification !== 'distraction' && lastClass === 'distraction') {
          const end = Date.now();
          recordDistraction(proc, lastTitle, currentStart, end);
          popToast(`✅ <strong>Back to Work</strong><br>${lastTitle} for ${Math.round((end-currentStart)/1000)}s`);
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

      // Screenshot analysis every minute if requested
      if (screenshotMode && Date.now() >= nextScreenshot) {
        const imgBuf   = await screenshotDesktop();
        const analysis = await analyzeScreenshot(imgBuf);
        popToast(`🔍 <strong>Screenshot Analysis</strong><br>${analysis.split('\n')[0]}`);
        mainWindow.webContents.send('screenshot-analysis', { text: analysis });
        nextScreenshot = Date.now() + 60_000;
      }
    } catch (e) {
      console.error('❗ Watcher error:', e);
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
