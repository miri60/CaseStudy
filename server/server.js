/**
 Minimal Express backend for Radio TX Studio (minimal, ready to test)

 Features:
 - Upload WAV files (POST /api/upload-audio, multipart form-data key 'file')
 - List WAV files (GET  /api/files)
 - Play file (POST /api/play { fileId }) -> streams file bytes to TCP host:port (GNU Radio TCP Audio Input)
 - Pause (POST /api/pause) -> closes TCP connection, can resume (bytesSent preserved)
 - Stream status (GET /api/stream-status)
 - WebSocket status updates at same HTTP server (optional frontend WS)

 How to run:
  - cd server
  - npm install
  - node server.js
 Default HTTP: http://localhost:3001
 Default TCP target (GNU Radio): 127.0.0.1:1234 (change via env TCP_HOST/TCP_PORT)
*/
//2001 port and change TCP to ZMQ

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const net = require('net');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const wavInfo = require('wav-file-info');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// static serving of uploaded files (optional)
app.use('/uploads', express.static(UPLOAD_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

// In-memory state (minimal)
const STATE = {
  playing: false,
  currentFile: null, // filename (id)
  bytesSent: 0,
  durationSec: 0,
  byteRate: 0
};

let activeSocket = null;
let activeReadStream = null;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(data);
  });
}

// Helper to read wav info using wav-file-info
function inspectWav(filePath) {
  return new Promise((resolve, reject) => {
    wavInfo.infoByFilename(filePath, (err, info) => {
      if (err) return reject(err);
      const sampleRate = info.sample_rate ? Number(info.sample_rate) : null;
      const bits = info.bits_per_sample ? Number(info.bits_per_sample) : 16;
      const channels = info.channels ? Number(info.channels) : 1;
      const duration = info.length ? Number(info.length) : null;
      const byteRate = sampleRate && bits ? sampleRate * channels * (bits / 8) : null;
      resolve({ sampleRate, bits, channels, duration, byteRate });
    });
  });
}

// List files
app.get('/api/files', async (req, res) => {
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    const wavFiles = files.filter(f => f.match(/\.wav$/i));
    const out = [];
    for (const f of wavFiles) {
      const full = path.join(UPLOAD_DIR, f);
      try {
        const info = await inspectWav(full);
        out.push({ id: f, name: f, duration: info.duration || 0 });
      } catch (e) {
        out.push({ id: f, name: f, duration: 0 });
      }
    }
    // newest first
    out.sort((a,b) => b.id.localeCompare(a.id));
    res.json({ files: out });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to list files' });
  }
});

// Upload audio
app.post('/api/upload-audio', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  const saved = req.file.filename;
  const fullPath = path.join(UPLOAD_DIR, saved);
  let duration = 0;
  try {
    const info = await inspectWav(fullPath);
    duration = info.duration || 0;
  } catch (e) {
    console.warn('inspect failed', e);
  }
  broadcast({ type: 'files-updated' });
  res.json({ id: saved, name: req.file.originalname, duration });
});

// Play (start or resume streaming)
app.post('/api/play', async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });
    const filePath = path.join(UPLOAD_DIR, fileId);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });

    // inspect to update duration/byterate
    const info = await inspectWav(filePath).catch(() => ({}));
    STATE.durationSec = info.duration || STATE.durationSec;
    STATE.byteRate = info.byteRate || STATE.byteRate;
    STATE.currentFile = fileId;

    // Clean up any existing stream
    if (activeSocket) {
      try { activeSocket.end(); } catch(e) {}
      activeSocket = null;
    }
    if (activeReadStream) {
      try { activeReadStream.destroy(); } catch(e) {}
      activeReadStream = null;
    }

    const TCP_HOST = process.env.TCP_HOST || '127.0.0.1';
    const TCP_PORT = Number(process.env.TCP_PORT || 1234);

    activeSocket = new net.Socket();
    activeSocket.on('error', (err) => {
      console.error('TCP socket error', err.message || err);
      cleanupStream();
      broadcast({ type: 'status', playing: false });
    });
    activeSocket.on('close', () => {
      console.log('TCP socket closed');
      cleanupStream();
      broadcast({ type: 'status', playing: false });
    });

    activeSocket.connect(TCP_PORT, TCP_HOST, () => {
      console.log('Connected to TCP target', TCP_HOST, TCP_PORT);
      const opts = {};
      if (STATE.bytesSent && STATE.bytesSent > 0) opts.start = STATE.bytesSent;
      activeReadStream = fs.createReadStream(filePath, opts);
      activeReadStream.on('data', (chunk) => {
        STATE.bytesSent += chunk.length;
      });
      activeReadStream.on('end', () => {
        console.log('File stream finished');
        STATE.playing = false;
        STATE.bytesSent = 0;
        cleanupStream();
        broadcast({ type: 'status', playing: false });
      });
      activeReadStream.on('error', (err) => {
        console.error('ReadStream error', err);
        cleanupStream();
        broadcast({ type: 'status', playing: false });
      });
      // Pipe raw file bytes into TCP socket (GNU Radio TCP Audio Input expects raw audio samples)
      activeReadStream.pipe(activeSocket, { end: false });
      STATE.playing = true;
      broadcast({ type: 'status', playing: true, currentFile: STATE.currentFile });
      res.json({ ok: true });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to play' });
  }
});

// Pause (stop streaming but keep bytesSent so play resumes)
app.post('/api/pause', (req, res) => {
  try {
    if (activeReadStream) activeReadStream.destroy();
    if (activeSocket) activeSocket.end();
    cleanupStream(false); // keep bytesSent
    STATE.playing = false;
    broadcast({ type: 'status', playing: false });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'failed to pause' });
  }
});

function cleanupStream(resetBytes = false) {
  try { if (activeReadStream) activeReadStream.destroy(); } catch(e) {}
  try { if (activeSocket) activeSocket.destroy(); } catch(e) {}
  activeReadStream = null;
  activeSocket = null;
  if (resetBytes) STATE.bytesSent = 0;
}

// Stream status
app.get('/api/stream-status', (req, res) => {
  res.json({
    playing: STATE.playing,
    currentFileId: STATE.currentFile,
    position: STATE.byteRate ? Math.floor(STATE.bytesSent / STATE.byteRate) : 0,
    duration: STATE.durationSec || 0
  });
});

// Basic WS welcome
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', version: 'minimal-server' }));
  ws.send(JSON.stringify({ type: 'status', playing: STATE.playing, currentFile: STATE.currentFile }));
});

// Start server
const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Uploads folder: ${UPLOAD_DIR}`);
  console.log(`Default TCP target: ${process.env.TCP_HOST || '127.0.0.1'}:${process.env.TCP_PORT || 1234}`);
});
