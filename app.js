import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";
import * as CFG from "./config.js";
const { SUPABASE_URL, SUPABASE_ANON_KEY } = CFG;
const TR_EMAIL = CFG.MYMEMORY_EMAIL || ""; // optional: raises the free translation limit
import { STORIES } from "./stories.js";

const configured = !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR-ANON");
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wordsIn = t => (t.match(/[A-Za-z’'-]+/g) || []).length;
const DAY = 864e5;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600); }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
const fmtTime = s => !isFinite(s) ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/* ---------- local audio cache (IndexedDB) so audio plays offline ---------- */
const idb = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => { const r = indexedDB.open("gre-audio", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("files", mode); const req = fn(t.objectStore("files")); t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); }); };
  return { get: k => tx("readonly", s => s.get(k)), put: (k, v) => tx("readwrite", s => s.put(v, k)), del: k => tx("readwrite", s => s.delete(k)) };
})();

/* ---------- state ---------- */
const S = { user: null, texts: [], progress: new Map(), words: [], channel: null };
const cacheKey = () => "gre-cache-" + S.user.id;
function saveCache() { lsSet(cacheKey(), { texts: S.texts, progress: [...S.progress.values()], words: S.words }); }
function loadCache() { const c = lsGet(cacheKey(), null); S.texts = c?.texts || []; S.progress = new Map((c?.progress || []).map(p => [p.story_id, p])); S.words = c?.words || []; }

async function loadAll() {
  const [t, p, w] = await Promise.all([
    sb.from("texts").select("*").order("created_at", { ascending: false }),
    sb.from("progress").select("*"),
    sb.from("words").select("*"),
  ]);
  const err = t.error || p.error || w.error; if (err) throw err;
  S.texts = t.data; S.progress = new Map(p.data.map(r => [r.story_id, r])); S.words = w.data;
  saveCache(); render(true);
}
function subscribe() {
  S.channel?.unsubscribe();
  const ch = sb.channel("sync-" + S.user.id);
  for (const table of ["texts", "progress", "words"]) ch.on("postgres_changes", { event: "*", schema: "public", table }, ev => apply(table, ev));
  ch.subscribe(status => setSync(status === "SUBSCRIBED"));
  S.channel = ch;
}
function apply(table, ev) {
  const del = ev.eventType === "DELETE", row = del ? ev.old : ev.new;
  if (!del && row.user_id && row.user_id !== S.user.id) return;
  if (table === "progress") { del ? S.progress.delete(row.story_id) : S.progress.set(row.story_id, row); }
  else {
    const arr = S[table], i = arr.findIndex(x => x.id === row.id);
    if (del) { if (i >= 0) arr.splice(i, 1); } else if (i >= 0) arr[i] = row; else arr.unshift(row);
  }
  saveCache(); render(true);
}
function setSync(on) { const el = $("#sync"); el.classList.toggle("on", on); el.lastElementChild.textContent = on ? "Live sync on" : navigator.onLine ? "Connecting…" : "Offline"; }

/* writes: optimistic locally, queued while offline */
let outbox = lsGet("gre-outbox", []);
const isNetErr = e => !navigator.onLine || /fetch|network|load failed/i.test(e?.message || "");
async function runOp(op) {
  const q = sb.from(op.table);
  const r = op.t === "upsert" ? await q.upsert(op.row, { onConflict: op.onConflict }) : await q.delete().match(op.match);
  if (r.error) throw r.error;
}
async function write(op) {
  try { await runOp(op); }
  catch (e) {
    if (isNetErr(e)) { outbox.push(op); lsSet("gre-outbox", outbox); }
    else { console.warn(e); toast("Couldn't save: " + e.message); }
  }
}
async function flush() {
  while (outbox.length) { try { await runOp(outbox[0]); outbox.shift(); lsSet("gre-outbox", outbox); } catch (e) { if (!isNetErr(e)) { outbox.shift(); lsSet("gre-outbox", outbox); } else break; } }
}
function setOffline() { $("#offline").hidden = navigator.onLine; if (S.user) setSync(!!S.channel && navigator.onLine && S.channel.state === "joined"); }
addEventListener("online", async () => { setOffline(); if (S.user) { await flush(); loadAll().catch(() => {}); } });
addEventListener("offline", setOffline);

function setProgress(id, patch) {
  const row = { ...(S.progress.get(id) || { pos: 0, done: false }), ...patch, user_id: S.user.id, story_id: id, updated_at: new Date().toISOString() };
  S.progress.set(id, row); saveCache();
  write({ t: "upsert", table: "progress", row, onConflict: "user_id,story_id" });
}
function saveWord(w) {
  const old = S.words.find(x => x.word.toLowerCase() === w.word.toLowerCase());
  const row = { id: old?.id || uuid(), user_id: S.user.id, box: 0, due: new Date(Date.now() + DAY).toISOString(), created_at: new Date().toISOString(), ...old, ...w };
  const i = S.words.findIndex(x => x.id === row.id); i >= 0 ? S.words[i] = row : S.words.unshift(row);
  saveCache(); write({ t: "upsert", table: "words", row, onConflict: "id" });
  return row;
}
function deleteWord(id) { S.words = S.words.filter(w => w.id !== id); saveCache(); render(); write({ t: "delete", table: "words", match: { id } }); }
function saveText(row) {
  row = { user_id: S.user.id, ...row };
  const i = S.texts.findIndex(x => x.id === row.id); i >= 0 ? S.texts[i] = row : S.texts.unshift(row);
  saveCache(); return write({ t: "upsert", table: "texts", row, onConflict: "id" });
}
async function deleteText(t) {
  S.texts = S.texts.filter(x => x.id !== t.id); S.progress.delete(t.id); saveCache();
  await write({ t: "delete", table: "texts", match: { id: t.id } });
  write({ t: "delete", table: "progress", match: { story_id: t.id } });
  if (t.audio_path) { sb.storage.from("audio").remove([t.audio_path]).catch(() => {}); idb.del(t.audio_path).catch(() => {}); }
}

/* ---------- audio files ---------- */
async function uploadAudio(textId, file) {
  const ext = ((file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "")) || "mp3";
  const path = `${S.user.id}/${textId}-${Date.now().toString(36)}.${ext}`;
  const { error } = await sb.storage.from("audio").upload(path, file, { contentType: file.type || "audio/mpeg", upsert: true });
  if (error) throw error;
  idb.put(path, file).catch(() => {});
  return path;
}
async function audioBlob(path) {
  let blob = await idb.get(path).catch(() => null);
  if (blob) return { blob, offline: true };
  const { data, error } = await sb.storage.from("audio").download(path);
  if (error) throw error;
  await idb.put(path, data).catch(() => {});
  return { blob: data, offline: true };
}

/* ---------- data access ---------- */
const allStories = () => [...STORIES, ...S.texts.map(t => ({ ...t, paragraphs: t.paragraphs || [], glossary: t.glossary || {}, questions: t.questions || [] }))];
const getStory = id => allStories().find(s => s.id === id);
const savedWords = () => [...S.words].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
const dueWords = () => { const n = Date.now(); return S.words.filter(w => new Date(w.due).getTime() <= n); };

/* ---------- routing ---------- */
let view = "library", current = null, filter = lsGet("gre-filter", "All");
function route() {
  const h = location.hash.slice(1);
  stopAll(); closeSheet();
  if (h.startsWith("read-")) { current = decodeURIComponent(h.slice(5)); view = "read"; }
  else { view = ["words", "add", "review"].includes(h) ? h : "library"; current = null; }
  window.scrollTo(0, 0); render();
}
addEventListener("hashchange", route);

function render(fromSync) {
  if (!S.user) return;
  updateNavCount();
  if (fromSync && (view === "read" || view === "add" || view === "review")) { if (view === "read") markSavedWords(); return; }
  document.querySelectorAll("nav.tabs a").forEach(a => { if (a.dataset.v === (view === "review" ? "words" : view)) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $("#bar").hidden = view !== "read";
  const m = $("#main");
  if (view === "library") m.innerHTML = libraryHTML();
  else if (view === "words") m.innerHTML = wordsHTML();
  else if (view === "review") m.innerHTML = reviewHTML();
  else if (view === "add") m.innerHTML = addHTML();
  else renderReader();
}
function updateNavCount() { const n = dueWords().length, c = $("#dueCount"); c.hidden = !n; c.textContent = n; }

/* ---------- login ---------- */
let loginMode = "in", loginMsg = "";
function renderLogin() {
  $("#top").hidden = true; $("#bar").hidden = true;
  $("#main").innerHTML = !configured ? `<div class="login"><h1>Almost there</h1><p>Open <b>config.js</b> and paste your Supabase Project URL and anon key. The README explains where to find them.</p></div>` :
  `<form class="login" id="loginForm">
    <div class="eyebrow">Graded Reader EN</div>
    <h1>${loginMode === "in" ? "Sign in" : "Create your account"}</h1>
    <label for="email">Email<input type="email" id="email" autocomplete="email" required></label>
    <label for="pw">Password<input type="password" id="pw" autocomplete="${loginMode === "in" ? "current-password" : "new-password"}" minlength="6" required></label>
    <button class="btn" type="submit">${loginMode === "in" ? "Sign in" : "Create account"}</button>
    <div class="status" id="loginMsg">${esc(loginMsg)}</div>
    <button class="linkbtn" type="button" data-act="toggle-login">${loginMode === "in" ? "First time here? Create an account" : "Already have an account? Sign in"}</button>
  </form>`;
}
async function onLogin(e) {
  e.preventDefault();
  const email = $("#email").value.trim(), password = $("#pw").value, msg = $("#loginMsg");
  msg.classList.remove("err"); msg.textContent = loginMode === "in" ? "Signing in…" : "Creating account…";
  const r = loginMode === "in" ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (r.error) { msg.classList.add("err"); msg.textContent = r.error.message; return; }
  if (loginMode === "up" && !r.data.session) { loginMode = "in"; loginMsg = "Account created. Confirm it from the email we sent you, then sign in."; renderLogin(); }
}
function setUser(u) {
  if ((u?.id || null) === (S.user?.id || null)) return;
  S.channel?.unsubscribe(); S.channel = null;
  S.user = u || null;
  if (!S.user) { stopAll(); renderLogin(); return; }
  $("#top").hidden = false;
  loadCache(); route();
  loadAll().catch(e => { console.warn(e); if (!isNetErr(e)) toast("Couldn't load your data: " + e.message); });
  subscribe(); flush(); setOffline();
}

/* ---------- library ---------- */
function libraryHTML() {
  const list = allStories().filter(s => filter === "All" || s.level === filter);
  const done = allStories().filter(s => S.progress.get(s.id)?.done).length;
  return `<section class="hero">
    <div><div class="eyebrow">Your level · B1–B2</div><h1>Read a little every day.<br>Listen while you read.</h1></div>
    <div class="stats">
      <div class="stat"><b>${done}</b><span>stories finished</span></div>
      <div class="stat"><b>${S.words.length}</b><span>words saved</span></div>
      <div class="stat"><b>${dueWords().length}</b><span>to review</span></div>
    </div></section>
  <div class="filters" role="group" aria-label="Filter by level">${["All", "A2", "B1", "B2", "C1"].map(l => `<button class="chip" aria-pressed="${l === filter}" data-filter="${l}">${l === "All" ? "All levels" : l}</button>`).join("")}</div>
  ${list.length ? `<div class="grid">${list.map(cardHTML).join("")}</div>` : `<div class="empty">Nothing at ${filter} yet. <a href="#add">Import a text</a>.</div>`}
  <div class="account">Signed in as ${esc(S.user.email)} <button class="linkbtn" data-act="logout">Sign out</button></div>`;
}
function cardHTML(s) {
  const w = s.paragraphs.reduce((n, p) => n + wordsIn(p), 0), p = S.progress.get(s.id);
  const st = p?.done ? `<span class="state done">Finished</span>` : p ? `<span class="state prog">In progress</span>` : "";
  return `<a class="card" href="#read-${encodeURIComponent(s.id)}" style="text-decoration:none;color:inherit">
    <div class="card-top">${s.level ? `<span class="lvl" data-l="${esc(s.level)}">${esc(s.level)}</span>` : ""}<span class="src">${s.source === "built-in" ? "Starter" : "Imported"}${s.audio_path ? " · Audio" : ""}</span></div>
    <h3>${esc(s.title)}</h3><p>${esc(s.paragraphs[0] || "")}</p>
    <div class="meta"><span>${w} words</span><span>~${Math.max(1, Math.round(w / 130))} min</span>${st}</div></a>`;
}

/* ---------- reader ---------- */
let sentences = [], idx = 0, playing = false, mode = "tts", mp3 = null, mp3URL = null, starts = null, syncMode = false;
export function splitSentences(p) { return p.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g)?.filter(x => x.trim()) || [p]; }
export function tokenizeSentence(text, gloss) {
  const keys = Object.keys(gloss || {}).map(k => ({ k, parts: k.toLowerCase().split(/\s+/) })).sort((a, b) => b.parts.length - a.parts.length);
  const toks = text.match(/[A-Za-z’'-]+|[^A-Za-z’'-]+/g) || [];
  const isW = t => /^[A-Za-z’'-]+$/.test(t);
  let out = "", i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (!isW(t)) { out += esc(t); i++; continue; }
    let hit = null;
    for (const { k, parts } of keys) {
      let j = i, ok = true, end = i;
      for (let p = 0; p < parts.length; p++) {
        if (p > 0) { if (toks[j] !== " ") { ok = false; break; } j++; }
        if (!toks[j] || toks[j].toLowerCase() !== parts[p]) { ok = false; break; }
        end = j; j++;
      }
      if (ok) { hit = { k, end }; break; }
    }
    if (hit) { out += `<span class="w g" data-g="${esc(hit.k)}">${esc(toks.slice(i, hit.end + 1).join(""))}</span>`; i = hit.end + 1; }
    else { const clean = t.replace(/^['’-]+|['’-]+$/g, ""); out += `<span class="w" data-w="${esc(clean.toLowerCase())}">${esc(t)}</span>`; i++; }
  }
  return out;
}
function renderReader() {
  const s = getStory(current), m = $("#main");
  if (!s) { m.innerHTML = `<div class="reader"><a class="back" href="#library">← Library</a><div class="empty">This text isn't available. It may have been deleted.</div></div>`; $("#bar").hidden = true; return; }
  sentences = []; let html = "";
  for (const p of s.paragraphs) html += "<p>" + splitSentences(p).map(se => { const i = sentences.push(se.trim()) - 1; return `<span class="s" data-i="${i}">${tokenizeSentence(se, s.glossary)}</span>`; }).join("") + "</p>";
  const w = s.paragraphs.reduce((n, p) => n + wordsIn(p), 0), p = S.progress.get(s.id);
  idx = Math.min(p?.pos || 0, Math.max(0, sentences.length - 1));
  mode = s.audio_path ? "mp3" : "tts"; starts = null; syncMode = false;
  const own = s.source !== "built-in";
  m.innerHTML = `<article class="reader">
    <a class="back" href="#library">← Library</a>
    <header class="reader-head">
      <div class="row">${s.level ? `<span class="lvl" data-l="${esc(s.level)}">${esc(s.level)}</span>` : ""}<span class="src">${w} words · ~${Math.max(1, Math.round(w / 130))} min</span></div>
      <h1>${esc(s.title)}</h1>
      <div class="reader-tools">Tap any word for its meaning. Dotted words are new at this level.
        <span class="row" style="margin-left:auto"><button class="chip" data-size="-1" aria-label="Smaller text">A−</button><button class="chip" data-size="1" aria-label="Larger text">A+</button></span></div>
    </header>
    ${own ? `<div class="audio-note" id="audioNote">${s.audio_path ? `<span class="pill" id="audioState">Loading audio…</span>` : `<span>No audio yet — the computer voice reads it.</span>`}
      <label class="linkbtn" for="addAudio" style="cursor:pointer;flex-direction:row">${s.audio_path ? "Replace audio" : "Add audio (.mp3)"}</label><input type="file" id="addAudio" accept="audio/*" hidden>
      ${s.audio_path ? `<button class="linkbtn" data-act="sync-mode" id="syncBtn" hidden>Fix the highlight</button><button class="linkbtn" data-act="use-${mode === "mp3" ? "tts" : "mp3"}">Use computer voice</button>` : ""}</div>
      <div class="sync-hint" id="syncHint" hidden>While the audio plays, tap a sentence at the moment you hear it begin. The sentences after it move with it. Tap <b>Done</b> when the highlight follows the voice.</div>` : ""}
    <div class="text" id="text">${html}</div>
    <section class="endbox">
      ${s.questions?.length ? `<h2>Check your understanding</h2>${s.questions.map((q, qi) => `<div class="q"><p>${qi + 1}. ${esc(q.q)}</p><div class="opts">${q.options.map((o, oi) => `<button class="opt" data-q="${qi}" data-o="${oi}">${esc(o)}</button>`).join("")}</div></div>`).join("")}` : ""}
      <div class="row">
        <button class="btn" data-act="finish">${p?.done ? "Finished ✓ — read again later" : "Mark as finished"}</button>
        ${own ? `<button class="btn ghost" data-act="delete-text">Delete this text</button>` : ""}
      </div>
    </section></article>`;
  document.documentElement.style.setProperty("--reader-size", lsGet("gre-size", 1.22) + "rem");
  markSavedWords(); setActive(idx, false); renderBar();
  if (idx > 0) document.querySelector(`.s[data-i="${idx}"]`)?.scrollIntoView({ block: "center" });
  if (s.audio_path) loadMp3(s);
}
async function loadMp3(s) {
  const st = () => $("#audioState");
  try {
    const { blob } = await audioBlob(s.audio_path);
    if (current !== s.id) return;
    mp3URL && URL.revokeObjectURL(mp3URL);
    mp3URL = URL.createObjectURL(blob);
    mp3 = new Audio(mp3URL); mp3.preload = "auto"; mp3.playbackRate = +lsGet("gre-rate", 0.9);
    const savedT = +lsGet("gre-mp3pos-" + s.id, 0); if (savedT) mp3.currentTime = savedT;
    mp3.ontimeupdate = () => { updateMp3Bar(); followAudio(); if (Math.floor(mp3.currentTime) % 5 === 0) lsSet("gre-mp3pos-" + s.id, mp3.currentTime); };
    const meta = new Promise(r => { if (mp3.readyState >= 1) r(); else mp3.addEventListener("loadedmetadata", r, { once: true }); });
    mp3.onloadedmetadata = updateMp3Bar;
    mp3.onplay = () => { playing = true; renderBar(); }; mp3.onpause = () => { playing = false; renderBar(); };
    mp3.onended = () => { lsSet("gre-mp3pos-" + s.id, 0); };
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: "Graded Reader EN" });
      navigator.mediaSession.setActionHandler("seekbackward", () => mp3 && (mp3.currentTime -= 10));
      navigator.mediaSession.setActionHandler("seekforward", () => mp3 && (mp3.currentTime += 10));
    }
    if (st()) { st().textContent = "Audio saved on this device"; st().classList.add("ok"); }
    renderBar();
    // sentence timings: reuse saved ones, otherwise work them out from the pauses in the recording
    const saved = s.timings?.starts;
    if (Array.isArray(saved) && saved.length === sentences.length) starts = saved.slice();
    else {
      if (st()) { st().textContent = "Matching the audio to the text…"; st().classList.remove("ok"); }
      try { const info = await analyzeAudio(blob); if (current !== s.id) return; starts = alignSentences(sentences.map(x => x.length), info); }
      catch (e) { console.warn("audio analysis failed", e); await meta; if (current !== s.id) return; starts = proportionalStarts(sentences.map(x => x.length), mp3.duration || 0); }
      saveTimings(s.id);
      if (st()) { st().textContent = "Audio saved on this device"; st().classList.add("ok"); }
    }
    const sb2 = $("#syncBtn"); if (sb2) sb2.hidden = false;
    renderBar(); followAudio(true);
  } catch (e) { console.warn(e); if (st()) st().textContent = navigator.onLine ? "Couldn't load the audio" : "Audio not downloaded yet — connect once to save it offline"; mode = "tts"; renderBar(); }
}
function markSavedWords() {
  const saved = new Set(S.words.map(w => w.word.toLowerCase()));
  document.querySelectorAll("#text .w").forEach(el => el.classList.toggle("saved", saved.has((el.dataset.g || el.dataset.w || "").toLowerCase())));
}

/* ---------- MP3 ↔ text: which sentence is being spoken ---------- */
// Energy per 20 ms frame → leading/trailing speech and the pauses between phrases.
export function detectPauses(data, rate) {
  const f = Math.max(1, Math.round(rate * 0.02)), n = Math.floor(data.length / f), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * f, k = j + f; j < k; j++) s += data[j] * data[j]; e[i] = Math.sqrt(s / f); }
  const sorted = Array.from(e).sort((a, b) => a - b), q = p => sorted[Math.min(n - 1, Math.floor(p * n))] || 0;
  const thr = q(0.1) + (q(0.6) - q(0.1)) * 0.2;
  let first = 0; while (first < n - 3 && !(e[first] > thr && e[first + 1] > thr && e[first + 2] > thr)) first++;
  let last = n - 1; while (last > first && e[last] <= thr) last--;
  const pauses = []; let run = 0;
  for (let i = first; i <= last; i++) {
    if (e[i] <= thr) run++;
    else { if (run >= 8) pauses.push({ t: i * 0.02, len: run * 0.02 }); run = 0; }
  }
  return { start: first * 0.02, end: (last + 1) * 0.02, pauses, dur: n * 0.02 };
}
// Predict each sentence start from its length, then snap it to the nearest real pause.
export function alignSentences(lens, info) {
  const n = lens.length, total = lens.reduce((a, b) => a + b, 0) || 1;
  const spc = Math.max(0.01, (info.end - info.start) / total), out = [info.start];
  for (let i = 1; i < n; i++) {
    const prevDur = lens[i - 1] * spc, pred = out[i - 1] + prevDur, win = Math.max(1.5, prevDur * 0.35);
    let best = null, bestScore = -Infinity;
    for (const p of info.pauses) {
      if (p.t < pred - win) continue; if (p.t > pred + win) break;
      if (p.t <= out[i - 1] + 0.3) continue;
      const score = p.len * 2 - Math.abs(p.t - pred);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    out.push(+(best ? best.t : Math.max(pred, out[i - 1] + 0.3)).toFixed(2));
  }
  return out;
}
export function proportionalStarts(lens, dur) {
  const total = lens.reduce((a, b) => a + b, 0) || 1; let acc = 0;
  return lens.map(l => { const t = acc / total * dur; acc += l; return +t.toFixed(2); });
}
async function analyzeAudio(blob) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const buf = await blob.arrayBuffer();
  let ctx; try { ctx = new Ctx(1, 8000, 8000); } catch { ctx = new Ctx(1, 22050, 22050); }
  const audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p?.then) p.then(res, rej); });
  return detectPauses(audio.getChannelData(0), audio.sampleRate);
}
let timingsTimer;
function saveTimings(id) {
  clearTimeout(timingsTimer);
  const snap = starts.slice();
  timingsTimer = setTimeout(() => { const row = S.texts.find(t => t.id === id); if (row) saveText({ ...row, timings: { v: 1, starts: snap } }); }, 800);
}
function sentenceAt(t) { let lo = 0, hi = starts.length - 1, ans = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t + 0.08) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
function followAudio(force) {
  if (mode !== "mp3" || !mp3 || !starts) return;
  const i = sentenceAt(mp3.currentTime);
  if (i !== idx || force) { idx = i; setActive(i, !mp3.paused); rememberPos(); }
}
function anchorSentence(i) {
  if (!mp3 || !starts) return;
  const t = Math.max(0, mp3.currentTime - 0.3), delta = t - starts[i];
  for (let j = i; j < starts.length; j++) starts[j] = +(starts[j] + delta).toFixed(2);
  for (let j = i - 1; j >= 0; j--) if (starts[j] > starts[j + 1] - 0.2) starts[j] = Math.max(0, +(starts[j + 1] - 0.2).toFixed(2));
  idx = i; setActive(i, false); saveTimings(current); toast(`Sentence ${i + 1} synced`);
}
function seekSentence(i) {
  if (!mp3 || !starts) return;
  i = Math.max(0, Math.min(starts.length - 1, i));
  mp3.currentTime = starts[i]; idx = i; setActive(i);
}

/* ---------- player bar ---------- */
const tts = window.speechSynthesis;
let voices = [];
function loadVoices() { if (!tts) return; voices = tts.getVoices().filter(v => /^en[-_]/i.test(v.lang)); if (view === "read") renderBar(); }
if (tts) { loadVoices(); tts.onvoiceschanged = loadVoices; }
const ICON = { play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>', pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>', prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>', next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>', back10: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>', fwd10: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>' };
function renderBar() {
  const b = $("#bar"); if (view !== "read") return;
  const rate = lsGet("gre-rate", 0.9), vname = lsGet("gre-voice", "");
  const rateSel = `<select id="rate" aria-label="Speed">${[0.7, 0.8, 0.9, 1, 1.1, 1.25].map(r => `<option value="${r}" ${r == rate ? "selected" : ""}>${r}×</option>`).join("")}</select>`;
  if (mode === "mp3") {
    b.innerHTML = `<div class="bar-in">
      ${starts ? `<button class="ib" data-act="sprev" aria-label="Previous sentence (tap twice quickly to go further back)">${ICON.prev}</button>` : `<button class="ib" data-act="back10" aria-label="Back 10 seconds">${ICON.back10}</button>`}
      <button class="ib play" data-act="play" aria-label="${playing ? "Pause" : "Play"}" ${mp3 ? "" : "disabled"}>${playing ? ICON.pause : ICON.play}</button>
      ${starts ? `<button class="ib" data-act="snext" aria-label="Next sentence">${ICON.next}</button>` : `<button class="ib" data-act="fwd10" aria-label="Forward 10 seconds">${ICON.fwd10}</button>`}
      <div class="prog"><span id="pos" class="audio-time">${mp3 ? `${fmtTime(mp3.currentTime)} / ${fmtTime(mp3.duration)}` : "Loading audio…"}</span><div class="track" id="seek" style="cursor:pointer"><i id="track"></i></div></div>
      ${rateSel}</div>`;
    updateMp3Bar(); return;
  }
  if (!tts) { b.innerHTML = `<div class="bar-in"><span class="prog">Read-aloud isn't available in this browser.</span></div>`; return; }
  b.innerHTML = `<div class="bar-in">
    <button class="ib" data-act="prev" aria-label="Previous sentence">${ICON.prev}</button>
    <button class="ib play" data-act="play" aria-label="${playing ? "Pause" : "Play"}">${playing ? ICON.pause : ICON.play}</button>
    <button class="ib" data-act="next" aria-label="Next sentence">${ICON.next}</button>
    <div class="prog"><span id="pos">Sentence ${idx + 1} of ${sentences.length}</span><div class="track"><i id="track" style="width:${sentences.length ? ((idx + 1) / sentences.length * 100) : 0}%"></i></div></div>
    ${rateSel}
    <select id="voice" class="voice" aria-label="Voice"><option value="">Default voice</option>${voices.map(v => `<option value="${esc(v.name)}" ${v.name === vname ? "selected" : ""}>${esc(v.name.replace(/^(Microsoft|Google)\s*/, "").slice(0, 28))} (${esc(v.lang)})</option>`).join("")}</select>
  </div>`;
}
function updateMp3Bar() {
  if (mode !== "mp3" || !mp3) return;
  const pos = $("#pos"), tr = $("#track");
  if (pos) pos.textContent = `${fmtTime(mp3.currentTime)} / ${fmtTime(mp3.duration)}`;
  if (tr) tr.style.width = (mp3.duration ? mp3.currentTime / mp3.duration * 100 : 0) + "%";
}
function setActive(i, scroll = true) {
  document.querySelectorAll(".s.active").forEach(e => e.classList.remove("active"));
  const el = document.querySelector(`.s[data-i="${i}"]`); if (!el) return;
  el.classList.add("active");
  if (scroll) { const r = el.getBoundingClientRect(); if (r.top < 90 || r.bottom > innerHeight - 110) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
  if (mode === "tts") { const pos = $("#pos"), tr = $("#track"); if (pos) pos.textContent = `Sentence ${i + 1} of ${sentences.length}`; if (tr) tr.style.width = ((i + 1) / sentences.length * 100) + "%"; }
}
let posTimer;
function rememberPos() { clearTimeout(posTimer); const id = current, i = idx; posTimer = setTimeout(() => { const p = S.progress.get(id); if (!p?.done && p?.pos !== i) setProgress(id, { pos: i }); }, 2000); }
function speak(text, onend) {
  const u = new SpeechSynthesisUtterance(text); u.lang = "en-GB"; u.rate = +lsGet("gre-rate", 0.9);
  const v = voices.find(v => v.name === lsGet("gre-voice", "")); if (v) { u.voice = v; u.lang = v.lang; }
  u.onend = onend; u.onerror = onend; tts.speak(u);
}
let runId = 0;
function playFrom(i) {
  if (!tts) return; tts.cancel(); playing = true; idx = i; const my = ++runId; renderBar();
  const step = () => {
    if (my !== runId) return;
    if (idx >= sentences.length) { playing = false; idx = sentences.length - 1; renderBar(); return; }
    setActive(idx); rememberPos();
    speak(sentences[idx], () => { if (my !== runId || !playing) return; idx++; step(); });
  };
  step();
}
function stopAll() {
  runId++; playing = false; try { tts?.cancel(); } catch {}
  if (mp3) { mp3.pause(); mp3 = null; } if (mp3URL) { URL.revokeObjectURL(mp3URL); mp3URL = null; }
}

/* ---------- word sheet ---------- */
let sheetWord = null;
function openSheet(el) {
  const s = getStory(current), g = el.dataset.g, raw = g || el.dataset.w;
  const entry = g ? s.glossary[g] : null;
  const saved = S.words.find(w => w.word.toLowerCase() === raw.toLowerCase());
  const sentence = el.closest(".s")?.textContent.trim() || "";
  const para = el.closest("p")?.textContent.trim().slice(0, 1200) || "";
  sheetWord = { word: raw, sentence, para, story_id: s.id, story_title: s.title, def: saved?.def || entry?.def || "", pt: saved?.pt || entry?.pt || "", fromGloss: !!entry, ...(trCached("sentence", sentence) ? { tr: trCached("sentence", sentence).pt, trBy: trCached("sentence", sentence).by } : {}) };
  drawSheet();
  // words without a glossary entry or saved meaning: translate in the context of this sentence
  if (!sheetWord.pt && navigator.onLine) {
    const w = sheetWord; w.ptLoading = true; drawSheet();
    smartTranslate("word", raw, sentence).then(r => { if (sheetWord !== w) return; keepInputs(); if (!w.pt) w.pt = r.pt; if (!w.def && r.def) w.def = r.def; w.ptAuto = true; w.ptBy = r.by; })
      .catch(() => {}).finally(() => { if (sheetWord === w) { keepInputs(); w.ptLoading = false; drawSheet(); } });
  }
}
function keepInputs() { if (sheetWord && $("#wdef")) { sheetWord.def = $("#wdef").value.trim(); sheetWord.pt = $("#wpt").value.trim(); } }
function drawSheet() {
  const w = sheetWord, saved = S.words.find(x => x.word.toLowerCase() === w.word.toLowerCase());
  const editable = !w.fromGloss || saved;
  const gt = `https://translate.google.com/?sl=en&tl=pt&text=${encodeURIComponent(w.sentence)}`;
  $("#sheet").innerHTML = `<div class="sheet-card" role="dialog" aria-label="Word: ${esc(w.word)}">
    <div class="hw"><b>${esc(w.word)}</b><button class="chip" data-act="say" aria-label="Hear the word">▶ Hear</button><button class="x" data-act="close" aria-label="Close">×</button></div>
    ${editable ? `<label for="wdef">Meaning<input type="text" id="wdef" value="${esc(w.def)}" placeholder="Meaning in simple English (optional)"></label>
      <label for="wpt">Portuguese${w.ptLoading ? ` <span class="note">· translating…</span>` : w.ptAuto ? ` <span class="note">· ${byName(w.ptBy)}, edit if needed</span>` : ""}<input type="text" id="wpt" value="${esc(w.pt)}" placeholder="Tradução"></label>
      <div class="links"><a href="https://dictionary.cambridge.org/dictionary/english-portuguese/${encodeURIComponent(w.word.split(" ")[0])}" target="_blank" rel="noopener">Cambridge dictionary ↗</a></div>`
      : `<div class="def">${esc(w.def)}</div>${w.pt ? `<div class="pt">${esc(w.pt)}</div>` : ""}`}
    <div class="sent">
      <div class="sent-en">${esc(w.sentence)}</div>
      ${w.tr ? `<div class="sent-pt">${esc(w.tr)}</div><div class="note">${byName(w.trBy)}</div>`
        : w.trLoading ? `<div class="status">Translating…</div>`
        : `<button class="chip" data-act="tr-sentence">Translate this sentence</button>`}
      ${w.trErr ? `<div class="status err">${esc(w.trErr)} <a href="${gt}" target="_blank" rel="noopener">Open in Google Translate ↗</a></div>` : ""}
    </div>
    <div class="row"><button class="btn" data-act="save">${saved ? "Update" : "Save to my words"}</button>${saved ? `<button class="btn ghost" data-act="unsave">Remove</button>` : ""}</div>
  </div>`;
  $("#sheet").hidden = false;
}

/* ---------- translation ----------
   1st choice: your Supabase function "translate" (Claude or DeepL, keys kept on the server).
   Fallback when it isn't set up or fails: MyMemory (free, lower quality). Results are cached on the device. */
const trStore = lsGet("gre-tr2", {});
const trKey = (kind, text, ctx = "") => kind + "|" + text + (kind === "word" ? "|" + ctx : "");
function trCached(kind, text, ctx) { return trStore[trKey(kind, text, ctx)] || null; }
const byName = by => ({ claude: "translated by Claude", deepl: "translated by DeepL", mymemory: "basic translation (MyMemory)" }[by] || "automatic");
const decodeHTML = s => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };
export function chunkText(text, max = 450) {
  const out = []; let rest = text.trim();
  while (rest.length > max) { let cut = rest.lastIndexOf(", ", max); if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max); if (cut <= 0) cut = max; out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim(); }
  if (rest) out.push(rest); return out;
}
async function myMemory(text) {
  const parts = [];
  for (const c of chunkText(text)) {
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(c)}&langpair=en|pt-BR${TR_EMAIL ? `&de=${encodeURIComponent(TR_EMAIL)}` : ""}`);
    const j = await r.json().catch(() => null);
    const txt = j?.responseData?.translatedText || "";
    if (!r.ok || +j?.responseStatus !== 200 || /MYMEMORY WARNING|QUOTA/i.test(txt)) throw new Error(/QUOTA|WARNING/i.test(txt + (j?.responseDetails || "")) ? "Today's free translation limit is used up." : "Couldn't translate right now.");
    parts.push(decodeHTML(txt));
  }
  return parts.join(" ");
}
let fnState = "unknown"; // "ok" | "missing"
async function smartTranslate(kind, text, ctx = "") {
  const k = trKey(kind, text, ctx);
  if (trStore[k]) return trStore[k];
  let res = null, fnErr = "";
  if (fnState !== "missing") {
    const { data, error } = await sb.functions.invoke("translate", { body: { kind, text, context: ctx } });
    if (!error && data?.pt) { res = { pt: data.pt, def: data.def || "", by: data.by }; fnState = "ok"; }
    else {
      const status = error?.context?.status;
      if (status === 404) fnState = "missing";
      try { fnErr = (await error?.context?.json())?.error || ""; } catch {}
      console.warn("translate function:", status, fnErr || error?.message);
    }
  }
  if (!res) res = { pt: await myMemory(text), def: "", by: "mymemory", note: fnErr };
  if (res.by !== "mymemory") { trStore[k] = res; const keys = Object.keys(trStore); if (keys.length > 1500) delete trStore[keys[0]]; lsSet("gre-tr2", trStore); }
  return res;
}
async function translateSentence() {
  const w = sheetWord; if (!w) return;
  keepInputs(); w.trLoading = true; w.trErr = ""; drawSheet();
  try { const r = await smartTranslate("sentence", w.sentence, w.para); w.tr = r.pt; w.trBy = r.by; }
  catch (e) { w.trErr = navigator.onLine ? e.message : "You're offline."; }
  w.trLoading = false; if (sheetWord === w) drawSheet();
}
function closeSheet() { sheetWord = null; $("#sheet").hidden = true; }

/* ---------- words & review ---------- */
const BOXES = [0, 1, 3, 7, 16, 35];
function wordsHTML() {
  const ws = savedWords(), due = dueWords().length;
  return `<section class="hero"><div><div class="eyebrow">Vocabulary</div><h1>My words</h1></div>
    <div class="row">${due ? `<a class="btn" href="#review" style="text-decoration:none">Review ${due} word${due > 1 ? "s" : ""}</a>` : `<span class="muted">Nothing to review today.</span>`}</div></section>
  ${ws.length ? `<div class="wlist">${ws.map(w => `<div class="wi">
    <div><b>${esc(w.word)}</b><div class="box">step ${w.box || 0} of ${BOXES.length - 1}</div></div>
    <div style="min-width:0">${w.def ? esc(w.def) : `<span class="muted">No meaning saved</span>`}${w.pt ? ` <span class="muted">· ${esc(w.pt)}</span>` : ""}${w.sentence ? `<div class="ctx">“${esc(w.sentence)}”</div>` : ""}</div>
    <button class="del" data-delword="${esc(w.id)}" aria-label="Delete ${esc(w.word)}">Delete</button></div>`).join("")}</div>` :
  `<div class="empty">Words you save while reading appear here, with the sentence where you found them. Open a story in the <a href="#library">Library</a> and tap a word.</div>`}`;
}
let queue = [], revealed = false;
function reviewHTML() {
  if (!queue.length) queue = dueWords().map(w => w.id);
  const w = S.words.find(x => x.id === queue[0]);
  if (!w) { queue = []; return `<div class="flash"><div class="eyebrow">Review</div><div class="big">All done</div><p class="muted">Come back tomorrow for the next words.</p><a class="btn ghost" href="#words" style="text-decoration:none">Back to my words</a></div>`; }
  const ctx = w.sentence ? esc(w.sentence).replace(new RegExp(esc(w.word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "<b>$&</b>") : "";
  return `<div class="flash"><div class="eyebrow">${queue.length} left</div>
    <div class="big">${esc(w.word)}</div>${ctx ? `<div class="ctx">${ctx}</div>` : ""}
    ${revealed ? `<div style="font-family:var(--f-read);font-size:1.1rem">${esc(w.def || "—")}</div>${w.pt ? `<div class="muted">${esc(w.pt)}</div>` : ""}
      <div class="row" style="justify-content:center"><button class="btn ghost" data-grade="0">Again</button><button class="btn" data-grade="1">I knew it</button></div>` :
      `<div class="row" style="justify-content:center"><button class="btn ghost" data-act="say-review">▶ Hear</button><button class="btn" data-act="reveal">Show meaning</button></div>`}
  </div>`;
}

/* ---------- import ---------- */
function addHTML() {
  return `<section class="hero"><div><div class="eyebrow">Add to your library</div><h1>Import a text</h1></div></section>
  <section class="pane" style="max-width:720px">
    <p class="note">Paste an article or chapter, or load a .txt or .pdf file. Add the MP3 if you have one: it's saved to your account and downloaded to each device for offline listening.</p>
    <label for="ititle">Title<input type="text" id="ititle" placeholder="e.g. News in Slow English · Episode 12"></label>
    <label for="ilevel">Level<select id="ilevel"><option value="">Not set</option><option>A2</option><option selected>B1</option><option>B2</option><option>C1</option></select></label>
    <label for="ifile">Text file (.txt or .pdf)<input type="file" id="ifile" accept=".txt,.pdf,text/plain,application/pdf"></label>
    <label for="itext">Text<textarea id="itext" placeholder="Paste text here. Leave a blank line between paragraphs."></textarea></label>
    <label for="iaudio">Audio (optional, up to 50 MB)<input type="file" id="iaudio" accept="audio/*"></label>
    <button class="btn" data-act="import">Save to library</button>
    <div class="status" id="impStatus"></div>
  </section>`;
}
function setImp(msg, err) { const el = $("#impStatus"); if (el) { el.textContent = msg; el.classList.toggle("err", !!err); } }
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function readPdf(file) {
  if (!window.pdfjsLib) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    let line = "";
    for (const it of tc.items) { line += it.str; if (it.hasEOL) line += "\n"; else if (it.str && !/\s$/.test(it.str)) line += " "; }
    out += line + "\n";
  }
  return cleanPdfText(out);
}
export function cleanPdfText(out) {
  return out.replace(/[ \t]+\n/g, "\n").replace(/([.!?]["”’]?)\n(?=[A-Z"“])/g, "$1\n\n").replace(/([^\n])\n(?!\n)/g, "$1 ").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
export function toParagraphs(raw) {
  let paras = raw.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  if (paras.length === 1 && wordsIn(paras[0]) > 180) { const ss = splitSentences(paras[0]); paras = []; for (let i = 0; i < ss.length; i += 4) paras.push(ss.slice(i, i + 4).join("").trim()); }
  return paras;
}
async function onTextFile(file) {
  if (!file) return;
  setImp("Reading the file…");
  try {
    const txt = /\.pdf$/i.test(file.name) || file.type === "application/pdf" ? await readPdf(file) : await file.text();
    $("#itext").value = txt; if (!$("#ititle").value) $("#ititle").value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    setImp("Text loaded. Check it, then save.");
  } catch (e) { console.warn(e); setImp("Couldn't read that file. Copy the text and paste it instead.", true); }
}
async function doImport(btn) {
  const raw = $("#itext").value.trim(), title = $("#ititle").value.trim() || "Imported text", af = $("#iaudio").files[0];
  if (wordsIn(raw) < 20) { setImp("Add at least a few sentences of text.", true); return; }
  if (af && af.size > 50 * 1024 * 1024) { setImp("That audio file is over 50 MB. Compress it or split it first.", true); return; }
  btn.disabled = true;
  const id = uuid(); let audio_path = null;
  if (af) {
    setImp(`Uploading audio (${(af.size / 1048576).toFixed(1)} MB)…`);
    try { audio_path = await uploadAudio(id, af); }
    catch (e) { console.warn(e); setImp("The audio didn't upload (" + (e.message || "error") + "). Saving the text without it; add the audio later from the reader.", true); }
  }
  await saveText({ id, title, level: $("#ilevel").value || null, source: "imported", paragraphs: toParagraphs(raw), glossary: {}, questions: [], audio_path, created_at: new Date().toISOString() });
  location.hash = "read-" + id;
}
async function attachAudio(file) {
  const s = getStory(current); if (!file || !s || s.source === "built-in") return;
  if (file.size > 50 * 1024 * 1024) { toast("That audio file is over 50 MB."); return; }
  toast("Uploading audio…");
  try {
    const old = s.audio_path, path = await uploadAudio(s.id, file);
    const row = S.texts.find(t => t.id === s.id);
    await saveText({ ...row, audio_path: path });
    if (old) { sb.storage.from("audio").remove([old]).catch(() => {}); idb.del(old).catch(() => {}); }
    toast("Audio saved"); stopAll(); renderReader();
  } catch (e) { console.warn(e); toast("Upload failed: " + (e.message || "try again")); }
}

/* ---------- events ---------- */
document.addEventListener("submit", e => { if (e.target.id === "loginForm") onLogin(e); });
document.addEventListener("click", e => {
  const sEl = e.target.closest("#text .s");
  if (syncMode && sEl) { anchorSentence(+sEl.dataset.i); return; }
  const t = e.target.closest("button,.w,#seek");
  if (!t) { if (!e.target.closest(".sheet-card")) closeSheet(); return; }
  if (t.classList.contains("w")) { openSheet(t); return; }
  if (t.id === "seek") { if (mp3?.duration) { const r = t.getBoundingClientRect(); mp3.currentTime = (e.clientX - r.left) / r.width * mp3.duration; } return; }
  const d = t.dataset;
  if (d.filter) { filter = d.filter; lsSet("gre-filter", filter); render(); return; }
  if (d.size) { const v = Math.min(1.6, Math.max(1, +lsGet("gre-size", 1.22) + (+d.size) * 0.08)); lsSet("gre-size", +v.toFixed(2)); document.documentElement.style.setProperty("--reader-size", v + "rem"); return; }
  if (d.q !== undefined) {
    const q = getStory(current).questions[+d.q], box = t.parentElement;
    if (box.dataset.answered) return; box.dataset.answered = "1";
    box.querySelectorAll(".opt").forEach((b, i) => { if (i === q.a) b.classList.add("right"); else if (b === t) b.classList.add("wrong"); });
    return;
  }
  if (d.delword) { deleteWord(d.delword); return; }
  if (d.grade !== undefined) {
    const id = queue.shift(), w = S.words.find(x => x.id === id);
    if (w) { const box = d.grade === "1" ? Math.min((w.box || 0) + 1, BOXES.length - 1) : 0; saveWord({ ...w, box, due: new Date(Date.now() + BOXES[box] * DAY - (box ? 36e5 : 0)).toISOString() }); if (d.grade === "0") queue.push(id); }
    revealed = false; render(); return;
  }
  switch (d.act) {
    case "toggle-login": loginMode = loginMode === "in" ? "up" : "in"; loginMsg = ""; renderLogin(); break;
    case "logout": sb.auth.signOut(); break;
    case "play":
      if (mode === "mp3") { if (!mp3) break; mp3.paused ? mp3.play().catch(() => toast("Tap play again to start the audio")) : mp3.pause(); }
      else if (playing) { runId++; playing = false; tts.cancel(); renderBar(); } else playFrom(idx);
      break;
    case "sprev": if (mp3 && starts) { const cur = sentenceAt(mp3.currentTime); seekSentence(mp3.currentTime - starts[cur] > 1.5 ? cur : cur - 1); } break;
    case "snext": if (mp3 && starts) seekSentence(sentenceAt(mp3.currentTime) + 1); break;
    case "sync-mode":
      syncMode = !syncMode; t.textContent = syncMode ? "Done" : "Fix the highlight";
      $("#syncHint").hidden = !syncMode; $("#text").classList.toggle("syncing", syncMode); closeSheet();
      if (syncMode && mp3?.paused) mp3.play().catch(() => {});
      break;
    case "tr-sentence": translateSentence(); break;
    case "back10": if (mp3) mp3.currentTime = Math.max(0, mp3.currentTime - 10); break;
    case "fwd10": if (mp3) mp3.currentTime = Math.min(mp3.duration || 0, mp3.currentTime + 10); break;
    case "prev": idx = Math.max(0, idx - 1); playing ? playFrom(idx) : (setActive(idx), rememberPos()); break;
    case "next": idx = Math.min(sentences.length - 1, idx + 1); playing ? playFrom(idx) : (setActive(idx), rememberPos()); break;
    case "use-tts": if (mp3) mp3.pause(); playing = false; mode = "tts"; t.dataset.act = "use-mp3"; t.textContent = "Use the recording"; renderBar(); break;
    case "use-mp3": runId++; tts?.cancel(); playing = false; mode = "mp3"; t.dataset.act = "use-tts"; t.textContent = "Use computer voice"; renderBar(); followAudio(true); break;
    case "close": closeSheet(); break;
    case "say": if (tts && sheetWord) { if (mode === "tts") { runId++; playing = false; renderBar(); } tts.cancel(); speak(sheetWord.word, () => {}); } break;
    case "say-review": { const w = S.words.find(x => x.id === queue[0]); if (tts && w) { tts.cancel(); speak(w.word, () => {}); } break; }
    case "save": {
      const w = sheetWord; if ($("#wdef")) { w.def = $("#wdef").value.trim(); w.pt = $("#wpt").value.trim(); }
      const existing = S.words.find(x => x.word.toLowerCase() === w.word.toLowerCase());
      saveWord({ word: w.word, def: w.def, pt: w.pt, sentence: existing?.sentence || w.sentence, story_id: w.story_id, story_title: w.story_title });
      markSavedWords(); updateNavCount(); closeSheet(); toast(existing ? "Updated" : "Saved to my words"); break;
    }
    case "unsave": { const w = S.words.find(x => x.word.toLowerCase() === sheetWord.word.toLowerCase()); if (w) deleteWord(w.id); markSavedWords(); closeSheet(); break; }
    case "finish": setProgress(current, { done: true, pos: 0 }); toast("Nice work. Story finished."); location.hash = "library"; break;
    case "delete-text":
      if (t.dataset.confirm) { const s = S.texts.find(x => x.id === current); stopAll(); if (s) deleteText(s); location.hash = "library"; }
      else { t.dataset.confirm = "1"; t.textContent = "Tap again to delete"; setTimeout(() => { if (t.isConnected) { delete t.dataset.confirm; t.textContent = "Delete this text"; } }, 3000); }
      break;
    case "reveal": revealed = true; render(); break;
    case "import": doImport(t); break;
  }
});
document.addEventListener("dblclick", e => {
  const s = e.target.closest("#text .s"); if (!s || syncMode) return;
  closeSheet();
  if (mode === "mp3" && mp3 && starts) { seekSentence(+s.dataset.i); mp3.play().catch(() => {}); }
  else if (mode === "tts" && tts) playFrom(+s.dataset.i);
});
document.addEventListener("change", e => {
  const id = e.target.id;
  if (id === "rate") { lsSet("gre-rate", +e.target.value); if (mp3) mp3.playbackRate = +e.target.value; else if (playing) playFrom(idx); }
  if (id === "voice") { lsSet("gre-voice", e.target.value); if (playing) playFrom(idx); }
  if (id === "ifile") onTextFile(e.target.files[0]);
  if (id === "addAudio") attachAudio(e.target.files[0]);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeSheet();
  if (view === "read" && e.code === "Space" && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); $('[data-act="play"]')?.click(); }
});
addEventListener("pagehide", () => { runId++; try { tts?.cancel(); } catch {} });

/* ---------- start ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
setOffline();
if (!sb) renderLogin();
else {
  // defer: Supabase recommends not calling its API inside this callback directly
  sb.auth.onAuthStateChange((_ev, session) => setTimeout(() => setUser(session?.user), 0));
  sb.auth.getSession().then(({ data }) => { if (!data.session) renderLogin(); });
}
