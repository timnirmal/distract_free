// main.js
const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const path = require('path');
const activeWin = require('active-win');
const screenshotDesktop = require('screenshot-desktop');
const OpenAI = require('openai').default;

const client = new OpenAI(); // reads OPENAI_API_KEY

let mainWindow;

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

async function classifyWindow(title, proc) {
    const system = `
  You are a lightweight classifier.  
  Given a window title and process name, decide if the user is distracted (e.g. social media, games) or it's OK for work.  
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
      console.error("❌ OpenAI call failed:", err);
      return { classification: "ok", screenshot: false };
    }
  
    // now resp.output_text should exist
    if (!resp.output_text || !resp.output_text[0]?.content) {
      console.error("❌ Unexpected shape:", resp);
      return { classification: "ok", screenshot: false };
    }
  
    const jsonStr = resp.output_text[0].content[0].text.trim();
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      console.error("❌ JSON parse failed:", jsonStr, err);
      return { classification: "ok", screenshot: false };
    }
  }
  

async function analyzeScreenshot(buffer) {
  const b64 = buffer.toString('base64');
  const payload = [
    {
      role: 'user',
      content: [
        { type: 'input_text',  text: 'Please describe whether this screenshot shows distraction or work-related content.' },
        { type: 'input_image', image_url: `data:image/png;base64,${b64}` }
      ]
    }
  ];
  const resp = await client.responses.create({
    model: 'gpt-4.1-mini',
    input: payload
  });
  return resp.output_text[0].content[0].text.trim();
}

function notify(title, body) {
  new Notification({ title, body }).show();
}

function startWatcher() {
  let lastTitle       = '';
  let screenshotMode  = false;
  let nextScreenshotT = 0;

  setInterval(async () => {
    try {
      const win = await activeWin();
      const title = win.title || '';
      const proc  = win.owner?.name || 'unknown';

      if (title && title !== lastTitle) {
        // 1) classify
        const info = await classifyWindow(title, proc);

        // 2) send UI update
        mainWindow.webContents.send('status-update', {
          classification: info.classification,
          process: proc,
          title
        });

        // 3) pop desktop notification if distraction
        if (info.classification === 'distraction') {
          notify('🚨 Distraction Detected', `${proc} — ${title}`);
        }

        screenshotMode = info.screenshot;
        if (screenshotMode) {
          nextScreenshotT = Date.now();
        }
        lastTitle = title;
      }

      // 4) if screenshotMode, grab & analyze every minute
      if (screenshotMode && Date.now() >= nextScreenshotT) {
        const imgBuf = await screenshotDesktop();
        const analysis = await analyzeScreenshot(imgBuf);

        // update UI & notify
        mainWindow.webContents.send('screenshot-analysis', { text: analysis });
        notify('🔍 Screenshot Analysis', analysis.split('\n')[0]);

        nextScreenshotT = Date.now() + 60_000;
      }
    } catch (e) {
      console.error('Watcher error:', e);
    }
  }, 1_000);
}

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
