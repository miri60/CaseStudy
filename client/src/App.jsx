import React, { useEffect, useState, useRef } from "react";

/*
Simple, beautiful frontend:
- lists files
- upload WAV
- play / pause controls
- shows progress
*/

export default function App() {
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [uploading, setUploading] = useState(false);
  const wsRef = useRef(null);

  const API_BASE = "/api"; // backend address (change if needed)

  useEffect(() => {
    fetchFiles();
    fetchStatus();
    const iv = setInterval(fetchStatus, 2000);
    setupWS();
    return () => {
      clearInterval(iv);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  async function fetchFiles() {
    try {
      const r = await fetch(`${API_BASE}/api/files`);
      const j = await r.json();
      setFiles(j.files || []);
      if (!selected && j.files && j.files.length) setSelected(j.files[0].id);
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchStatus() {
    try {
      const r = await fetch(`${API_BASE}/api/stream-status`);
      const s = await r.json();
      setPlaying(Boolean(s.playing));
      setPosition(s.position || 0);
      setDuration(s.duration || 0);
      if (s.currentFileId) setSelected(s.currentFileId);
    } catch (e) {}
  }

  function setupWS() {
    try {
      const ws = new WebSocket("ws://localhost:3001");
      ws.onopen = () => console.log("WS open");
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "status") {
            setPlaying(Boolean(m.playing));
          }
          if (m.type === "files-updated") fetchFiles();
        } catch (e) {}
      };
      wsRef.current = ws;
    } catch (e) {}
  }

  async function uploadAudio(file) {
    if (!file) return;
    setUploading(true);
    const fm = new FormData();
    fm.append("file", file);
    try {
      const r = await fetch(`${API_BASE}/api/upload-audio`, { method: "POST", body: fm });
      const j = await r.json();
      await fetchFiles();
      if (j.id) setSelected(j.id);
    } catch (e) {
      alert("Upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  }

  async function play() {
    if (!selected) return alert("Select a file");
    try {
      await fetch(`${API_BASE}/api/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: selected })
      });
      fetchStatus();
    } catch (e) { console.error(e); }
  }

  async function pause() {
    try {
      await fetch(`${API_BASE}/api/pause`, { method: "POST" });
      fetchStatus();
    } catch (e) {}
  }

  function humanTime(s) {
    if (!s && s !== 0) return "--:--";
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  function onDrop(ev) {
    ev.preventDefault();
    const f = ev.dataTransfer.files?.[0];
    if (f) uploadAudio(f);
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="title">Radio TX Studio</div>
        <div className="subtitle">Stream WAV → GNU Radio (TCP)</div>
      </header>

      <main className="container">
        <section className="left">
          <div className="card">
            <div className="card-header">
              <h3>Audio Library</h3>
              <div>
                <button className="btn" onClick={play}>Play</button>
                <button className="btn ghost" onClick={pause}>Pause</button>
              </div>
            </div>

            <div className="upload-area" onDrop={onDrop} onDragOver={(e)=>e.preventDefault()}>
              <div>Drop WAV file here or</div>
              <label className="upload-btn">
                <input type="file" accept="audio/wav" onChange={(e)=>{const f=e.target.files?.[0]; if(f) uploadAudio(f);}}/>
                Select file
              </label>
              {uploading && <div className="muted">Uploading...</div>}
            </div>

            <div className="filelist">
              {files.length === 0 && <div className="muted">No files yet</div>}
              {files.map(f => (
                <div key={f.id} className={`file-item ${selected===f.id ? 'selected' : ''}`} onClick={()=>setSelected(f.id)}>
                  <div className="file-name">{f.name}</div>
                  <div className="file-meta">{humanTime(f.duration)}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="right">
          <div className="card small">
            <h4>Now Selected</h4>
            {selected ? (
              (() => {
                const s = files.find(x => x.id === selected);
                return s ? (
                  <div>
                    <div className="big">{s.name}</div>
                    <div className="muted">{humanTime(s.duration)}</div>
                  </div>
                ) : <div className="muted">Selected not found</div>
              })()
            ) : <div className="muted">No selection</div>}
            <div className="progress">
              <div className="bar">
                <div className="fill" style={{ width: duration ? `${(position/duration)*100}%` : '0%' }} />
              </div>
              <div className="times">
                <span>{humanTime(position)}</span>
                <span>{humanTime(duration)}</span>
              </div>
            </div>
            <div className="status">Status: <strong>{playing ? 'Playing' : 'Stopped'}</strong></div>
          </div>

          <div className="card small muted-note">
            <h4>Notes</h4>
            <ul>
              <li>WAV files recommended: 16-bit PCM (44.1/48 kHz)</li>
              <li>Backend streams file bytes via TCP to GNU Radio</li>
              <li>Make sure GNU Radio TCP Audio Input listens on the configured host/port</li>
            </ul>
          </div>
        </aside>
      </main>

      <footer className="foot">THM Radio - Built By Communications-Team for CASE STUDY MODULE</footer>
    </div>
  );
}
