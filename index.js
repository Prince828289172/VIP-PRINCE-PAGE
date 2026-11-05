import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import multer from 'multer';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Boom } from '@hapi/boom';
import cors from 'cors';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ===== RAILWAY VOLUME PATHS =====
const VOLUME_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), 'session');
const SESSION_DIR = VOLUME_ROOT.endsWith('session')
  ? VOLUME_ROOT
  : path.join(VOLUME_ROOT, 'session');

const SESSION_FILE = path.join(SESSION_DIR, 'running_sessions.json');

console.log(chalk.cyan(`📁 Session dir: ${SESSION_DIR}`));
console.log(chalk.cyan(`📁 Session file: ${SESSION_FILE}`));

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });

// ===== ADMIN PASSWORD & ACCESS PASSWORD =====
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Prince890';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'PRINCE123'; // Ye website ka main lock hai

// ===== GLOBAL STATE =====
const royalHeroesSessions = {};
const royalStopFlags = {};
const royalActiveSockets = {};
const royalMessageQueues = {};
const royalReconnectAttempts = {};
const royalConnectionStates = {};
const royalSessionImages = {}; 

const RoyalSessionState = {
  INIT: 'INIT',
  PAIRED: 'PAIRED',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  STOPPED: 'STOPPED'
};

// ===== GITHUB BACKUP SETUP =====
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_BACKUP_REPO;
const GITHUB_BACKUP_FILE = 'session_backup.zip';

async function downloadBackupFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    console.log(chalk.cyan('📥 Checking for backup on GitHub...'));
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      fs.writeFileSync('./temp_backup.zip', Buffer.from(buffer));
      const zip = new AdmZip('./temp_backup.zip');
      zip.extractAllTo('./', true); 
      fs.unlinkSync('./temp_backup.zip');
      console.log(chalk.green('✅ Backup (Sessions + Images) restored from GitHub!'));
    } else {
      console.log(chalk.yellow('⚠️ No backup found on GitHub (Fresh Start).'));
    }
  } catch (e) { console.error(chalk.red('Download error:'), e.message); }
}

async function uploadBackupToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (!fs.existsSync(SESSION_DIR) || fs.readdirSync(SESSION_DIR).length === 0) return;

  try {
    const archive = archiver('zip');
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', async () => {
      const buffer = Buffer.concat(chunks);
      const base64Content = buffer.toString('base64');

      let sha = null;
      const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
        headers: { Authorization: `token ${GITHUB_TOKEN}` }
      });
      if (getRes.ok) {
        const data = await getRes.json();
        sha = data.sha;
      }

      const body = { message: 'Auto-backup WhatsApp session + images', content: base64Content, ...(sha && { sha }) };
      const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
        method: 'PUT',
        headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (putRes.ok) console.log(chalk.green('☁️ Session + Images auto-backed up to GitHub!'));
    });
    
    // 🔥 Yahan humne uploads folder ko bhi zip me add kar diya hai
    archive.directory(SESSION_DIR, 'session');
    archive.directory('uploads', 'uploads'); 
    archive.finalize();
  } catch (e) { console.error(chalk.red('Upload error:'), e.message); }
}

// ===== CLEANUP OLD SESSIONS =====
const cleanupOldSessions = () => {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    const activeKeys = Object.keys(royalHeroesSessions);

    if (activeKeys.length === 0) {
      console.log(chalk.gray('⏭️ No active sessions, skipping cleanup'));
      return;
    }

    const dirs = fs.readdirSync(SESSION_DIR)
      .filter(d => {
        try {
          const fullPath = path.join(SESSION_DIR, d);
          return fs.statSync(fullPath).isDirectory();
        } catch { return false; }
      })
      .map(d => ({
        name: d,
        path: path.join(SESSION_DIR, d),
        mtime: fs.statSync(path.join(SESSION_DIR, d)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    let deleted = 0;
    dirs.forEach(d => {
      if (!activeKeys.includes(d.name)) {
        try {
          fs.rmSync(d.path, { recursive: true, force: true });
          deleted++;
        } catch (e) {}
      }
    });
    if (deleted > 0) console.log(chalk.yellow(`🧹 Cleaned ${deleted} old session folder(s)`));
  } catch (error) {
    console.error(chalk.red(`Cleanup error: ${error.message}`));
  }
};

const royalSaveSessions = () => {
  try {
    const sessionsToSave = {};
    for (const key in royalHeroesSessions) {
      const { restartTimer, ...sessionData } = royalHeroesSessions[key];
      sessionsToSave[key] = sessionData;
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionsToSave, null, 2), 'utf8');
  } catch (error) {
    console.error(chalk.red(`Error saving sessions: ${error.message}`));
  }
};

const royalGenerateUniqueKey = () => crypto.randomBytes(16).toString('hex');

// ===== MESSAGING ENGINE =====
const royalStartMessaging = (RoyalKing, uniqueKey, target, hatersName, messages, speed) => {
  if (royalStopFlags[uniqueKey]?.timeout) {
    clearTimeout(royalStopFlags[uniqueKey].timeout);
  }
  delete royalMessageQueues[uniqueKey];

  if (royalHeroesSessions[uniqueKey]?.paused) {
    console.log(chalk.yellow(`⏸️ Session ${uniqueKey.substring(0, 8)} is paused.`));
    return;
  }

  royalMessageQueues[uniqueKey] = {
    messages: [...messages],
    currentIndex: 0,
    isSending: false,
    lastSentAt: Date.now()
  };

  const queue = royalMessageQueues[uniqueKey];

  const royalSendNextMessage = async () => {
    if (royalStopFlags[uniqueKey]?.stopped || royalConnectionStates[uniqueKey] === RoyalSessionState.STOPPED || royalHeroesSessions[uniqueKey]?.paused) {
      if (royalStopFlags[uniqueKey]?.timeout) clearTimeout(royalStopFlags[uniqueKey].timeout);
      return;
    }

    if (!royalActiveSockets[uniqueKey] || royalConnectionStates[uniqueKey] !== RoyalSessionState.CONNECTED) {
      return;
    }

    if (queue.isSending) return;
    queue.isSending = true;

    const chatId = target.includes('@g.us') ? target : `${target}@s.whatsapp.net`;
    const currentMessage = queue.messages[queue.currentIndex];
    const formattedMessage = `${hatersName} ${currentMessage}`;

    try {
      if (royalSessionImages[uniqueKey]) {
        await Promise.race([
          RoyalKing.sendMessage(chatId, { image: royalSessionImages[uniqueKey], caption: formattedMessage }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Send timeout (30s)')), 30000))
        ]);
      } else {
        await Promise.race([
          RoyalKing.sendMessage(chatId, { text: formattedMessage }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Send timeout (30s)')), 30000))
        ]);
      }

      if (royalHeroesSessions[uniqueKey]) {
        royalHeroesSessions[uniqueKey].sentCount = (royalHeroesSessions[uniqueKey].sentCount || 0) + 1;
      }

      console.log(chalk.green(`✉️ [${queue.currentIndex + 1}/${queue.messages.length}] Sent.`));
      queue.lastSentAt = Date.now();
      queue.currentIndex++;
      if (queue.currentIndex >= queue.messages.length) {
        queue.currentIndex = 0;
      }
    } catch (err) {
      console.error(chalk.red(`❌ Send error: ${err.message}`));
    } finally {
      queue.isSending = false;
    }
  };

  const baseInterval = (parseInt(speed) || 5) * 1000;

  const royalIntervalFunc = async () => {
    await royalSendNextMessage();
    if (!royalStopFlags[uniqueKey]?.stopped && !royalHeroesSessions[uniqueKey]?.paused) {
      royalStopFlags[uniqueKey].timeout = setTimeout(royalIntervalFunc, baseInterval);
    }
  };

  royalStopFlags[uniqueKey] = {
    stopped: false,
    timeout: setTimeout(royalIntervalFunc, baseInterval)
  };
};

// ===== CONNECT + LOGIN =====
const royalConnectAndLogin = async (phoneNumber, uniqueKey, sendPairingCode = null) => {
  const sessionPath = path.join(SESSION_DIR, uniqueKey);
  let pairingCodeSent = false;

  if (!royalConnectionStates[uniqueKey]) royalConnectionStates[uniqueKey] = RoyalSessionState.INIT;

  const royalStartConnection = async () => {
    if (royalConnectionStates[uniqueKey] === RoyalSessionState.CONNECTED && royalActiveSockets[uniqueKey]) {
      return;
    }

    try {
      console.log(chalk.magenta(`🚀 [${royalConnectionStates[uniqueKey]}] Connecting: ${phoneNumber}`));
      if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      if (royalActiveSockets[uniqueKey]) {
        try {
          royalActiveSockets[uniqueKey].ev.removeAllListeners();
          royalActiveSockets[uniqueKey].end();
          delete royalActiveSockets[uniqueKey];
        } catch (e) {}
      }

      const RoyalKing = makeWASocket({
        version,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.ubuntu('Chrome'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 120000,
        keepAliveIntervalMs: 15000,
        getMessage: async () => undefined,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
      });

      royalActiveSockets[uniqueKey] = RoyalKing;

      if (!RoyalKing.authState.creds.registered && sendPairingCode && royalConnectionStates[uniqueKey] !== RoyalSessionState.PAIRED) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
          const code = await RoyalKing.requestPairingCode(cleanedNumber);
          const pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
          if (!pairingCodeSent) {
            pairingCodeSent = true;
            sendPairingCode(pairingCode, false);
          }
        } catch (error) {
          console.error(chalk.red(`❌ Pairing error: ${error.message}`));
        }
      }

      RoyalKing.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          console.log(chalk.green(`\n✅ WhatsApp Connected! (${phoneNumber}) ✅\n`));
          royalConnectionStates[uniqueKey] = RoyalSessionState.CONNECTED;
          royalReconnectAttempts[uniqueKey] = 0;

          royalHeroesSessions[uniqueKey] = {
            ...royalHeroesSessions[uniqueKey],
            phoneNumber,
            uniqueKey,
            connected: true,
            lastUpdateTimestamp: Date.now()
          };
          royalSaveSessions();

          if (sendPairingCode && !pairingCodeSent) {
            pairingCodeSent = true;
            sendPairingCode(null, true);
          }

          if (royalHeroesSessions[uniqueKey]?.messaging && royalHeroesSessions[uniqueKey]?.messages && !royalHeroesSessions[uniqueKey]?.paused) {
            console.log(chalk.cyan(`▶️ Auto-resuming messaging...`));
            royalStartMessaging(
              RoyalKing,
              uniqueKey,
              royalHeroesSessions[uniqueKey].target,
              royalHeroesSessions[uniqueKey].hatersName,
              royalHeroesSessions[uniqueKey].messages,
              royalHeroesSessions[uniqueKey].speed
            );
          }
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;

          if (royalMessageQueues[uniqueKey]) {
            royalMessageQueues[uniqueKey].isSending = false;
          }

          console.log(chalk.red(`⚠️ Connection closed. Status: ${statusCode}`));

          if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
            console.log(chalk.bold.red(`🚨 Unpaired/Banned (${statusCode}) detected. Deleting session ${uniqueKey.substring(0,8)}...`));
            
            if (royalStopFlags[uniqueKey]?.timeout) clearTimeout(royalStopFlags[uniqueKey].timeout);
            
            delete royalHeroesSessions[uniqueKey];
            delete royalStopFlags[uniqueKey];
            delete royalMessageQueues[uniqueKey];
            delete royalReconnectAttempts[uniqueKey];
            delete royalConnectionStates[uniqueKey];
            delete royalSessionImages[uniqueKey];
            delete royalActiveSockets[uniqueKey];

            if (fs.existsSync(sessionPath)) {
              try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
            }
            royalSaveSessions();
            return; 
          }

          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            console.log(chalk.yellow(`🔄 Restart required (515), fast reconnect...`));
            royalConnectionStates[uniqueKey] = RoyalSessionState.RECONNECTING;
            delete royalActiveSockets[uniqueKey];
            setTimeout(() => royalStartConnection(), 1000);
            return;
          }

          let shouldReconnect = true;

          if (shouldReconnect && royalConnectionStates[uniqueKey] !== RoyalSessionState.STOPPED) {
            royalConnectionStates[uniqueKey] = RoyalSessionState.RECONNECTING;
            delete royalActiveSockets[uniqueKey];

            const attempts = royalReconnectAttempts[uniqueKey] || 1;
            const delay = Math.min(2000 * attempts, 30000);
            royalReconnectAttempts[uniqueKey] = attempts + 1;

            console.log(chalk.yellow(`🔄 Reconnecting in ${delay / 1000}s (attempt #${attempts})...`));
            setTimeout(() => royalStartConnection(), delay);
          }
        }
      });

      RoyalKing.ev.on('creds.update', saveCreds);

    } catch (error) {
      console.error(chalk.red(`❌ Connection Error: ${error.message}`));
      if (royalConnectionStates[uniqueKey] !== RoyalSessionState.STOPPED) {
        setTimeout(() => royalStartConnection(), 5000);
      }
    }
  };

  await royalStartConnection();
};

// ===== RESTORE SESSIONS =====
const royalRestoreSessions = async () => {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      const savedSessions = JSON.parse(data);
      Object.assign(royalHeroesSessions, savedSessions);

      const restorePromises = [];
      for (const [key, session] of Object.entries(royalHeroesSessions)) {
        if (session.imagePath && fs.existsSync(session.imagePath)) {
            try { royalSessionImages[key] = fs.readFileSync(session.imagePath); } catch (e) {}
        }

        if (session.phoneNumber && session.uniqueKey) {
          console.log(chalk.cyan(`🔄 Restoring: ${session.phoneNumber}`));
          restorePromises.push(royalConnectAndLogin(session.phoneNumber, session.uniqueKey, null));
        }
      }
      await Promise.all(restorePromises);
    } catch (err) {
      console.error(chalk.red(`Restore error: ${err.message}`));
    }
  } else {
    console.log(chalk.gray('📭 No sessions file found, starting fresh'));
  }
};

// ===== ROUTES =====

// 🔥 NAYA ROUTE: Website Access Password Check 🔥
app.post('/api/verify-access', (req, res) => {
    const { password } = req.body;
    if (password === ACCESS_PASSWORD) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Galat Password!' });
    }
});

app.post('/login', async (req, res) => {
  try {
    let { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number required!' });

    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    const uniqueKey = royalGenerateUniqueKey();

    let responded = false;
    const sendPairingCode = (pairingCode, isConnected = false, errorMsg = null) => {
      if (responded) return;
      responded = true;
      if (errorMsg) res.json({ success: false, message: 'Error', error: errorMsg, uniqueKey });
      else if (isConnected) res.json({ success: true, message: 'Connected!', connected: true, uniqueKey });
      else res.json({ success: true, message: 'Pairing code', pairingCode, uniqueKey });
    };

    await royalConnectAndLogin(phoneNumber, uniqueKey, sendPairingCode);

    setTimeout(() => {
      if (!responded) {
        responded = true;
        res.json({ success: false, message: 'Connection timeout, try again', uniqueKey });
      }
    }, 90000);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/getGroupUID', async (req, res) => {
  try {
    const { uniqueKey } = req.body;
    if (!uniqueKey || !royalActiveSockets[uniqueKey]) {
      return res.status(400).json({ success: false, message: 'Invalid session or not connected' });
    }
    const groups = await royalActiveSockets[uniqueKey].groupFetchAllParticipating();
    const groupUIDs = Object.values(groups).map(group => ({
      groupName: group.subject,
      groupId: group.id
    }));
    res.json({ success: true, groupUIDs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/startMessaging', upload.fields([{ name: 'messageFile', maxCount: 1 }, { name: 'imageFile', maxCount: 1 }]), async (req, res) => {
  try {
    const { uniqueKey, target, hatersName, speed } = req.body;
    const messageFile = req.files?.['messageFile']?.[0];
    const imageFile = req.files?.['imageFile']?.[0];
    const filePath = messageFile?.path;

    if (!uniqueKey || !target || !royalActiveSockets[uniqueKey] || !filePath) {
      if (messageFile && fs.existsSync(messageFile.path)) fs.unlinkSync(messageFile.path);
      if (imageFile && fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const messages = fileContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    fs.unlinkSync(filePath);

    if (messages.length === 0) {
      if (imageFile && fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
      return res.status(400).json({ success: false, message: 'File is empty' });
    }

    if (imageFile) {
      const oldPath = royalHeroesSessions[uniqueKey]?.imagePath;
      if (oldPath && fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (e) {}
      
      const ext = path.extname(imageFile.originalname) || '.jpg';
      const permanentPath = path.join('uploads', `img_${uniqueKey}${ext}`);
      
      fs.renameSync(imageFile.path, permanentPath);
      royalSessionImages[uniqueKey] = fs.readFileSync(permanentPath);
      
      royalHeroesSessions[uniqueKey] = royalHeroesSessions[uniqueKey] || {};
      royalHeroesSessions[uniqueKey].imagePath = permanentPath; 
    } else {
      const oldPath = royalHeroesSessions[uniqueKey]?.imagePath;
      if (oldPath && fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (e) {}
      
      delete royalSessionImages[uniqueKey];
      if (royalHeroesSessions[uniqueKey]) delete royalHeroesSessions[uniqueKey].imagePath;
    }

    royalHeroesSessions[uniqueKey] = {
      ...royalHeroesSessions[uniqueKey],
      target, hatersName, messages, speed, messaging: true, paused: false, sentCount: 0
    };
    royalSaveSessions();

    royalStartMessaging(royalActiveSockets[uniqueKey], uniqueKey, target, hatersName, messages, speed);

    res.json({
      success: true,
      message: 'Messaging started',
      messageCount: messages.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/pause', async (req, res) => {
  const { uniqueKey } = req.body;
  if (!uniqueKey || !royalHeroesSessions[uniqueKey]) return res.status(400).json({ success: false, message: 'Invalid session' });
  
  if (royalHeroesSessions[uniqueKey]) royalHeroesSessions[uniqueKey].paused = true;
  if (royalStopFlags[uniqueKey]?.timeout) clearTimeout(royalStopFlags[uniqueKey].timeout);
  royalSaveSessions();
  
  res.json({ success: true, message: 'Messaging Paused' });
});

app.post('/resume', async (req, res) => {
  const { uniqueKey } = req.body;
  const session = royalHeroesSessions[uniqueKey];
  if (!uniqueKey || !session) return res.status(400).json({ success: false, message: 'Invalid session' });
  if (!royalActiveSockets[uniqueKey]) return res.status(400).json({ success: false, message: 'Number is offline' });

  session.paused = false;
  royalSaveSessions();
  royalStartMessaging(royalActiveSockets[uniqueKey], uniqueKey, session.target, session.hatersName, session.messages, session.speed);
  
  res.json({ success: true, message: 'Messaging Resumed' });
});

app.post('/stop', async (req, res) => {
  const { uniqueKey } = req.body;
  if (!uniqueKey || !royalHeroesSessions[uniqueKey]) {
    return res.status(400).json({ success: false, message: 'Invalid session' });
  }

  royalConnectionStates[uniqueKey] = RoyalSessionState.STOPPED;
  if (royalStopFlags[uniqueKey]?.timeout) clearTimeout(royalStopFlags[uniqueKey].timeout);

  if (royalActiveSockets[uniqueKey]) {
    try { await royalActiveSockets[uniqueKey].logout(); } catch (e) {}
    delete royalActiveSockets[uniqueKey];
  }

  const sessionPath = path.join(SESSION_DIR, uniqueKey);
  if (fs.existsSync(sessionPath)) {
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); }
    catch (e) {}
  }
  
  if (royalHeroesSessions[uniqueKey].imagePath && fs.existsSync(royalHeroesSessions[uniqueKey].imagePath)) {
      try { fs.unlinkSync(royalHeroesSessions[uniqueKey].imagePath); } catch(e){}
  }

  delete royalHeroesSessions[uniqueKey];
  delete royalStopFlags[uniqueKey];
  delete royalMessageQueues[uniqueKey];
  delete royalReconnectAttempts[uniqueKey];
  delete royalConnectionStates[uniqueKey];
  delete royalSessionImages[uniqueKey];

  royalSaveSessions();
  res.json({ success: true, message: 'Stopped and logged out' });
});

app.post('/admin/sessions', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Galat password!' });
  }

  const sessions = Object.entries(royalHeroesSessions).map(([key, s]) => ({
    uniqueKey: key, 
    phoneNumber: s.phoneNumber || 'Unknown',
    connected: royalConnectionStates[key] === RoyalSessionState.CONNECTED,
    paused: !!s.paused,
    sentCount: s.sentCount || 0,
    state: royalConnectionStates[key] || 'UNKNOWN',
    target: s.target || null,
    speed: s.speed || null,
    messagesCount: s.messages?.length || 0,
    lastUpdate: s.lastUpdateTimestamp || null,
    hasSocket: !!royalActiveSockets[key]
  }));

  res.json({ success: true, sessions });
});

app.post('/admin/reconnect', async (req, res) => {
  const { password, uniqueKey } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Galat password!' });
  }

  const session = royalHeroesSessions[uniqueKey];
  if (!session || !session.phoneNumber) {
    return res.status(400).json({ success: false, message: 'Session nahi mila' });
  }

  royalConnectionStates[uniqueKey] = RoyalSessionState.RECONNECTING;
  if (royalActiveSockets[uniqueKey]) {
    try { royalActiveSockets[uniqueKey].end(); } catch (e) {}
    delete royalActiveSockets[uniqueKey];
  }
  if (royalMessageQueues[uniqueKey]) royalMessageQueues[uniqueKey].isSending = false;

  royalConnectAndLogin(session.phoneNumber, uniqueKey, null).catch(() => {});

  res.json({ success: true, message: 'Reconnect triggered' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'alive',
    uptime: process.uptime(),
    sessions: Object.keys(royalHeroesSessions).length
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== SERVER START =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.green(`✅ Server running on port ${PORT}`));
  console.log(chalk.cyan(`💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`));

  console.log(chalk.cyan('🔄 Background me backup load ho raha hai...'));
  downloadBackupFromGitHub().then(() => {
    return royalRestoreSessions();
  }).catch(err => {
    console.error(chalk.red('Backup load error:'), err.message);
    return royalRestoreSessions();
  });

  cleanupOldSessions();
  setInterval(cleanupOldSessions, 60 * 60 * 1000);
  setInterval(uploadBackupToGitHub, 10 * 60 * 1000); 

  setInterval(() => {
    for (const key in royalHeroesSessions) {
      const session = royalHeroesSessions[key];
      if (!session.messaging || session.paused) continue;

      const socket = royalActiveSockets[key];
      const state = royalConnectionStates[key];

      if (!socket || state !== RoyalSessionState.CONNECTED) {
        console.log(chalk.yellow(`⚠️ Watchdog: ${key.substring(0, 8)} dead. Restarting...`));
        royalConnectionStates[key] = RoyalSessionState.RECONNECTING;
        delete royalActiveSockets[key];
        if (royalMessageQueues[key]) royalMessageQueues[key].isSending = false;
        royalConnectAndLogin(session.phoneNumber, key, null);
      }
    }
  }, 5 * 60 * 1000);

  // 🔥 YE HAI NAYA MEMORY CLEANUP BLOCK 🔥
  setInterval(() => {
    const used = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(chalk.gray(`💾 Memory: ${used} MB | Sessions: ${Object.keys(royalHeroesSessions).length}`));
    if (used > 400 && global.gc) { 
      console.log(chalk.yellow(`🧹 Forcing GC (${used}MB)`));
      global.gc();
    }
  }, 10 * 60 * 1000);
  
});
