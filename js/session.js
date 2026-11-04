/* 세션·기록·단계 처리 (ver0.2 Python 서버의 main.py 이식). 서버 없이 브라우저 안에서 동작한다. */
const SESSIONS = {};
const GLOBAL = { dirHandle: null };   // 사용자가 고른 저장 폴더(크롬/엣지). 탭 메모리에만 있음.
const pad = (n, w = 2) => String(n).padStart(w, "0");
const hms = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const isoSec = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hms(d)}`; };
const jdump = o => JSON.stringify(o, null, 2);

class Store {
  constructor(sessionId) { this.files = new Map(); this.sessionId = sessionId; this.root = null; this.q = Promise.resolve(); this.err = null; }
  set(path, data) { this.files.set(path, data); if (this.root) this._enqueue(path, data); }
  _enqueue(path, data) { this.q = this.q.then(() => this._write(path, data)).catch(e => { this.err = String(e && e.message || e); }); }
  async _write(path, data) {
    const parts = path.split("/"); let d = this.root;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable(); await w.write(data); await w.close();
  }
  async attach(handle) {
    this.root = await handle.getDirectoryHandle(this.sessionId, { create: true });
    for (const [p, d] of this.files) this._enqueue(p, d);
  }
}

class Session {
  constructor(label, fileName) {
    const d = new Date();
    this.id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` + Math.random().toString(16).slice(2, 6);
    this.label = label; this.file = fileName; this.model = "";
    this.store = new Store(this.id);
    this.audio = null; this.slides = {}; this.imgData = {}; this.concepts = null; this.initialTranscript = ""; this.rounds = [];
    this.nCalls = 0; this.saved = []; this.usage = []; this.questions = null; this.timings = [];
    this.tFirst = Date.now(); this.tLast = this.tFirst; this.started = isoSec();
    this.logText = ""; this.eventsText = "";
  }
  dirLabel() { return GLOBAL.dirHandle ? `${GLOBAL.dirHandle.name}/${this.id}` : `(브라우저 메모리) ${this.id}`; }
  write(rel, text) {
    this.store.set(rel, text);
    if (!this.saved.includes(rel) && !rel.startsWith("slide_images/")) this.saved.push(rel);
    return rel;
  }
  writeJson(rel, obj) { return this.write(rel, jdump(obj)); }
  log(event, kw = {}) {
    const ts = isoSec();
    this.eventsText += JSON.stringify({ ts, event, ...kw }) + "\n";
    this.logText += `- \`${ts}\` **${event}** ${Object.entries(kw).map(([k, v]) => `${k}=${v}`).join(" ")}\n`;
    this.write("events.jsonl", this.eventsText); this.write("process_log.md", this.logText);
  }
  timing(key, label, rnd, t0) {
    this.tLast = Date.now();
    this.timings.push({ key, label, round: rnd, start: hms(t0), seconds: Math.round((this.tLast - t0) / 100) / 10 });
    this.writeJson("timings.json", this.timingSummary());
  }
  timingSummary() {
    return { stages: this.timings, active_seconds: Math.round(this.timings.reduce((a, t) => a + t.seconds, 0) * 10) / 10,
      wall_seconds: Math.round((this.tLast - this.tFirst) / 100) / 10, started: this.started };
  }
  history() {
    const out = []; let prev = null;
    for (const rd of this.rounds) {
      const a = rd.assessment, o = a.overall; const ch = [];
      if (prev) {
        const pm = {}; for (const i of prev.items) pm[i.id] = i;
        for (const i of a.items) { const b = pm[i.id];
          if (b && (Math.abs(i.score - b.score) >= 1 || i.level !== b.level)) ch.push({ id: i.id, name: i.name, from: b.score, to: i.score, level_from: b.level, level_to: i.level }); }
        ch.sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from));
      }
      const secs = this.timings.filter(t => t.round === rd.n && ["assess", "feedback", "questions"].includes(t.key)).reduce((s, t) => s + t.seconds, 0);
      out.push({ round: rd.n, trigger: rd.trigger || "", score: o.score, low: o.low, high: o.high, conf: o.confidence, conf_label: o.confidence_label,
        d_score: prev ? r1(o.score - prev.overall.score) : null, d_conf: prev ? Math.round((o.confidence - prev.overall.confidence) * 1000) / 1000 : null,
        changes: ch.slice(0, 8), n_changes: ch.length, seconds: Math.round(secs * 10) / 10 });
      prev = a;
    }
    return out;
  }
  usageSummary() {
    const tot = k => { const v = this.usage.map(u => u[k]); return (!v.length || v.some(x => x == null)) ? null : v.reduce((a, b) => a + b, 0); };
    return { calls: this.usage, n_calls: this.usage.length, prompt: tot("prompt"), completion: tot("completion"), total: tot("total"), credit: tot("credit"),
      n_credit_unreported: this.usage.filter(u => u.credit == null).length, n_unreported: this.usage.filter(u => u.total == null).length };
  }
  payload() {
    return { saved: [...this.saved], dir: this.dirLabel(), usage: this.usageSummary(), history: this.history(), timings: this.timingSummary(),
      store_error: this.store.err };
  }
  meta() { return { id: this.id, label: this.label, file: this.file, model: this.model }; }
  record() {
    return { meta: this.meta(), started: this.started, transcript: this.initialTranscript, slides_text: this.slides.slides ? slidesToText(this.slides) : "",
      concepts: this.concepts, rounds: this.rounds, questions: this.questions, history: this.history(), timings: this.timingSummary(), usage: this.usageSummary(), process_log: this.logText };
  }
  writeReports() {
    if (!(this.concepts && this.rounds.length)) return;
    const rec = this.record(); this.write("전체_기록.md", fullMd(rec)); this.write("요약본.md", summaryMd(rec));
  }
  writeUsage() {
    const us = this.usageSummary(); this.writeJson("token_usage.json", us);
    const L = ["# 토큰 사용량\n", "| # | 단계 | 모델 | 입력 | 출력 | 합계 | 차감 크레딧 |", "|---|---|---|---|---|---|---|"];
    us.calls.forEach((u, i) => L.push(`| ${i + 1} | ${u.stage} (라운드 ${u.round}) | ${u.model} | ${nf(u.prompt)} | ${nf(u.completion)} | ${nf(u.total)} | ${cf(u.credit)} |`));
    L.push(`| | **합계** | | **${nf(us.prompt)}** | **${nf(us.completion)}** | **${nf(us.total)}** | **${cf(us.credit)}** |`);
    if (us.n_unreported) L.push(`\n> 호출 ${us.n_unreported}건은 응답에 usage가 없어 합계에서 '미제공'으로 표시됩니다.`);
    if (us.n_credit_unreported) L.push(`\n> 호출 ${us.n_credit_unreported}건은 응답에 billing(차감 크레딧)이 없어 '미제공'입니다. (크레딧 단가가 등록되지 않은 계정은 billing 블록이 오지 않음)`);
    this.write("token_usage.md", L.join("\n") + "\n");
  }
  persist() {
    this.writeJson("session.json", { ...this.meta(), initial_transcript: this.initialTranscript, n_slides: this.slides.n_slides, concepts: this.concepts,
      questions: this.questions, rounds: this.rounds, timings: this.timingSummary(), saved: this.saved });
  }
  async zip() {
    const z = new JSZip(), root = z.folder(this.id);
    for (const [p, d] of this.store.files) root.file(p, d);
    return await z.generateAsync({ type: "blob", compression: "DEFLATE" });
  }
}

const getSession = sid => { const s = SESSIONS[sid]; if (!s) throw new Error("세션을 찾을 수 없습니다. (페이지를 새로고침하면 진행 중 세션은 초기화됩니다. 저장한 폴더·zip에는 기록이 남아 있습니다.)"); return s; };

async function runLlm(s, b, system, user, stage, images, audio) {
  const modelId = b.model;
  if (modelId !== "mock" && !(b.api_key || "").trim()) throw new Error("API 키가 없습니다. 상단 '설정'에서 BAZE API 키를 입력하세요.");
  s.model = modelId; s.nCalls++;
  const t0 = Date.now(); let data, raw, usage;
  try { [data, raw, usage] = await callJson(modelId, (b.api_key || "").trim(), system, user, stage, b.base_url, images, audio); }
  catch (e) {
    s.log("llm_error", { stage, model: modelId, error: String(e.message).slice(0, 300).replace(/\n/g, " ") });
    if (audio && e instanceof LLMError) throw new Error(`⛔ 모델 '${modelId}'이(가) 음성 파일 입력을 받지 못했습니다(거부 또는 미지원). 음성 입력을 지원하는 다른 모델을 선택하세요. — 원인: ${e.message}`);
    if (images && images.length && e instanceof LLMError) throw new Error(`⛔ 모델 '${modelId}'이(가) 발표자료 이미지 입력을 받지 못했습니다(거부 또는 미지원). 이미지 입력을 지원하는 다른 모델을 선택하세요. — 원인: ${e.message}`);
    throw new Error(e instanceof LLMError ? `LLM 호출 실패(${stage}): ${e.message}` : `처리 오류(${stage}): ${e.name}`);
  }
  const dt = Math.round((Date.now() - t0) / 100) / 10;
  const u = { prompt: null, completion: null, total: null, credit: null, ...(usage || {}) };
  s.usage.push({ stage, model: modelId, round: (stage === "concepts" || stage === "assess") ? s.rounds.length : s.rounds.length - 1, ...u });
  s.writeJson(`llm_calls/${pad(s.nCalls, 3)}_${stage}.json`, { stage, model: modelId, seconds: dt, usage, system, user, audio_attached: audio ? (s.audio && s.audio.name) : null, response_raw: raw });
  s.writeUsage();
  s.log("llm_call", { stage, model: modelId, seconds: dt, tokens: u.total != null ? u.total : "n/a" });
  return data;
}

const SAMPLES = { "original": { title: "샘플 · 원본(강의자 발표)", label: "원본(강의자)", audio: "sample original.mp3" },
                  "bad": { title: "샘플 · 못한 학생", label: "샘플(못한 학생)", audio: "sample bad student.mp3" },
                  "good": { title: "샘플 · 잘한 학생", label: "샘플(잘한 학생)", audio: "sample good student.mp3" } };

/* 음성 파일 → 모델에 보낼 {data(base64), format}. mp3·wav는 그대로, 그 외 형식은 브라우저에서 디코딩해 16kHz 모노 wav로 바꾼다. */
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;
async function blobToB64(blob) { return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); }); }
async function toWav16k(buf) {
  const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC();
  let ab; try { ab = await ac.decodeAudioData(buf.slice(0)); } catch (e) { throw new Error("이 브라우저에서 읽을 수 없는 음성 형식입니다. mp3 또는 wav 파일을 사용하세요."); } finally { try { ac.close(); } catch (e) {} }
  const len = Math.ceil(ab.duration * 16000), oc = new OfflineAudioContext(1, len, 16000), src = oc.createBufferSource(); src.buffer = ab; src.connect(oc.destination); src.start();
  const pcm = (await oc.startRendering()).getChannelData(0), out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVEfmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const v = Math.max(-1, Math.min(1, pcm[i])); out.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); }
  return { blob: new Blob([out.buffer], { type: "audio/wav" }), format: "wav", seconds: ab.duration };
}
async function prepareAudio(name, buf) {
  const ext = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  let blob, format, seconds = null;
  if (ext === ".mp3" || ext === ".wav") { blob = new Blob([buf], { type: ext === ".mp3" ? "audio/mpeg" : "audio/wav" }); format = ext.slice(1); }
  else { const r = await toWav16k(buf); blob = r.blob; format = r.format; seconds = r.seconds; }
  if (blob.size > AUDIO_MAX_BYTES) throw new Error(`음성 파일이 너무 큽니다(${(blob.size / 1048576).toFixed(1)}MB). 20MB 이하의 mp3 파일을 사용하세요.`);
  return { name, blob, format, data: await blobToB64(blob), seconds };
}
const SAMPLE_PPT = "sample slide.pdf", SAMPLE_PPT_NAME = "sample slide.pdf";

/* ---------- 요청 라우터: 화면 코드가 서버 API처럼 부르면 브라우저 안에서 처리한다 ---------- */
async function localApi(path, opts = {}) {
  const body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
  let m;
  if (path === "/api/status") return { configured: true, save_dir: null, default_dir: "", default_base: DEFAULT_BASE };
  if (path === "/api/models") {
    if (!(body.api_key || "").trim()) throw new Error("API 키를 먼저 입력하세요.");
    try { return { models: await listModels(body.api_key.trim(), body.base_url) }; }
    catch (e) { throw new Error("모델 목록을 불러오지 못했습니다: " + e.message); }
  }
  if ((m = path.match(/^\/api\/sample\/(\w+)$/))) {
    const sp = SAMPLES[m[1]]; if (!sp) throw new Error("없는 테스트파일입니다.");
    return { n: m[1], title: sp.title, label: sp.label, ppt_name: SAMPLE_PPT_NAME, audio_name: sp.audio };
  }
  if (path === "/api/session") {
    const t0 = Date.now(); const sample = body.get("sample"), file = body.get("file"), label = (body.get("student_label") || "").trim();
    let fname, buf;
    if (sample) {
      if (!SAMPLES[sample]) throw new Error("없는 테스트파일입니다.");
      fname = SAMPLE_PPT_NAME; const r = await fetch("samples/" + encodeURIComponent(SAMPLE_PPT)); if (!r.ok) throw new Error("샘플 발표자료를 불러오지 못했습니다.");
      buf = await r.arrayBuffer();
    } else {
      if (!file || !file.name) throw new Error("발표자료 파일을 선택하거나 테스트파일을 고르세요.");
      fname = file.name; buf = await file.arrayBuffer();
    }
    const s = new Session(label, fname);
    if (GLOBAL.dirHandle) { try { await s.store.attach(GLOBAL.dirHandle); } catch (e) { s.store.err = String(e.message || e); } }
    const ext = (fname.match(/\.[^.]+$/) || [".pptx"])[0].toLowerCase();
    s.store.set("original_presentation" + ext, new Blob([buf]));
    try { s.slides = await extractSlides(fname, buf, s.imgData); }
    catch (e) { throw new Error("발표자료 읽기 실패: " + e.message); }
    for (const [f, im] of Object.entries(s.imgData)) s.store.set(f, im.blob);
    SESSIONS[s.id] = s;
    s.writeJson("slides.json", s.slides);
    s.write("slides.md", "# 발표자료 추출 텍스트\n\n" + slidesToText(s.slides) + "\n");
    s.log("session_created", { file: s.file, slides: s.slides.n_slides, student: s.label || "-" });
    s.persist(); s.timing("read", "발표자료 읽기", 0, t0);
    return { id: s.id, dir: s.dirLabel(), n_slides: s.slides.n_slides, warnings: s.slides.warnings, ...s.payload() };
  }
  if ((m = path.match(/^\/api\/session\/([^/]+)\/(\w+)$/))) return await sessionStep(getSession(m[1]), m[2], body || {});
  throw new Error("알 수 없는 요청: " + path);
}

async function sessionStep(s, step, b) {
  const t0 = Date.now();
  if (step === "figures") {
    if (b.model !== "mock" && !(b.api_key || "").trim()) throw new Error("API 키가 없습니다. 상단 '설정'에서 BAZE API 키를 입력하세요.");
    const report = [], warnings = []; let blocked = null;
    for (const sl of s.slides.slides) {
      const n = sl.n; sl.figures = [];
      if (!sl.images || !sl.images.length) continue;
      if (blocked) { report.push({ slide: n, status: "미시도(앞선 실패)", n_images: sl.images.length }); continue; }
      const urls = sl.images.map(im => s.imgData[im.file].dataUrl);
      s.model = b.model; s.nCalls++; const t1 = Date.now(); let text, usage;
      try { [text, usage] = await callVision(b.model, (b.api_key || "").trim(), P.FIG_SYS, figUser(sl), urls, b.base_url); }
      catch (e) {
        const msg = e instanceof LLMError ? String(e.message).slice(0, 300) : (e.name || "오류");
        s.log("figure_error", { slide: n, model: b.model, error: msg.replace(/\n/g, " ") });
        blocked = msg; report.push({ slide: n, status: "실패", n_images: sl.images.length, error: msg }); continue;
      }
      const dt = Math.round((Date.now() - t1) / 100) / 10;
      const u = { prompt: null, completion: null, total: null, credit: null, ...(usage || {}) };
      s.usage.push({ stage: `figures(슬라이드 ${n})`, model: b.model, round: s.rounds.length, ...u });
      s.writeJson(`llm_calls/${pad(s.nCalls, 3)}_figures_s${n}.json`, { stage: "figures", slide: n, model: b.model, seconds: dt, usage, system: P.FIG_SYS,
        user: figUser(sl), images: sl.images.map(i => i.file), response_raw: text });
      s.writeUsage();
      sl.figures.push({ source: `모델 해석(${b.model})`, text: text.trim() });
      report.push({ slide: n, status: "해석 완료", n_images: sl.images.length });
    }
    const failed = report.filter(r => r.status === "실패" || r.status === "미시도(앞선 실패)");
    if (blocked) warnings.push(`모델에 이미지를 보내 읽는 데 실패했습니다(${blocked}). 이 모델/게이트웨이가 이미지 입력을 지원하지 않을 수 있습니다. 다른 모델로 시도해 보세요. 해석하지 못한 슬라이드: [${failed.map(r => r.slide).join(", ")}] — 이 그림 내용은 점수 평가에서 제외됩니다.`);
    s.writeJson("slides.json", s.slides);
    s.write("slides.md", "# 발표자료 추출 텍스트 (그림·차트 설명 포함)\n\n" + slidesToText(s.slides) + "\n");
    s.writeJson("figures.json", report);
    s.log("figures_done", { ok: report.filter(r => r.status === "해석 완료").length, failed: failed.length });
    s.persist(); s.timing("figures", "그림·차트 해석", 0, t0);
    return { figures: report, warnings, ...s.payload() };
  }
  if (step === "audio") {
    let name, buf; const sample = b.get && b.get("sample"), file = b.get && b.get("file");
    if (file && file.name) { name = file.name; buf = await file.arrayBuffer(); }
    else if (sample && SAMPLES[sample]) { name = SAMPLES[sample].audio; const r = await fetch("samples/" + encodeURIComponent(name)); if (!r.ok) throw new Error("샘플 음성을 불러오지 못했습니다."); buf = await r.arrayBuffer(); }
    else throw new Error("발표 음성 파일을 선택하세요.");
    s.audio = await prepareAudio(name, buf);
    s.store.set("presentation_audio." + s.audio.format, s.audio.blob);
    s.initialTranscript = "";
    s.log("audio_ready", { file: name, bytes: s.audio.blob.size, format: s.audio.format });
    s.timing("audio", "음성 파일 준비", 0, t0);
    return { duration_seconds: s.audio.seconds, bytes: s.audio.blob.size, ...s.payload() };
  }
  if (step === "concepts") {
    const imgs = b.model === "mock" ? [] : (s.slides.page_images || []).map(f => s.imgData[f].dataUrl);
    let d = await runLlm(s, b, P.CONCEPTS_SYS, conceptsUser(s.slides, imgs.length), "concepts", imgs);
    d = postConcepts(d, s.slides);
    if (!d.concepts.length) throw new Error("모델이 개념을 하나도 반환하지 않았습니다. 다른 모델로 시도해 보세요.");
    s.concepts = d; s.writeJson("1_알아야_할_개념.json", d); s.write("1_알아야_할_개념.md", conceptsMd(d, s.meta()));
    s.log("concepts_done", { n: d.concepts.length }); s.persist(); s.timing("concepts", "알아야 할 개념 도출", 0, t0);
    return { concepts: d, ...s.payload() };
  }
  if (step === "assess") {
    if (!s.concepts) throw new Error("먼저 '알아야 할 개념'을 생성해야 합니다.");
    let trigger = "발표 전사", trigQid = null, prevQa;
    if (!s.rounds.length) {
      if (!s.audio) throw new Error("발표 음성 파일을 선택하세요.");
      s.initialTranscript = ""; prevQa = [];
    } else {
      if (!s.questions || !s.questions.questions.length) throw new Error("반영할 질문이 없습니다.");
      prevQa = [...s.rounds[s.rounds.length - 1].qa];
      const done = new Set(prevQa.map(e => e.qid)), qmap = {}; for (const q of s.questions.questions) qmap[q.qid] = q;
      const picks = Object.entries(b.answers || {}).filter(([qid, ans]) => qmap[qid] && String(ans).trim());
      if (picks.length !== 1) throw new Error("질문 하나의 답변만 입력해 반영하세요. (질문 1개 = 라운드 1개)");
      const [qid, ans] = picks[0];
      if (done.has(qid)) throw new Error(`${qid}는 이미 반영되었습니다.`);
      prevQa.push({ qid, question: qmap[qid].question, answer: ans.trim() }); trigQid = qid; trigger = `${qid} 답변 반영`;
    }
    const n = s.rounds.length, block = buildTranscriptBlock(s.initialTranscript, prevQa);
    const audio = (s.audio && b.model !== "mock") ? { data: s.audio.data, format: s.audio.format } : null;
    const d = await runLlm(s, b, P.ASSESS_SYS, assessUser(s.concepts, block, !!s.audio), "assess", undefined, audio);
    const a = postAssess(d, s.concepts, block, !!s.audio);
    s.rounds.push({ n, trigger, trigger_qid: trigQid, qa: prevQa, assessment: a, feedback: null });
    const rp = `round_${pad(n)}/`;
    s.write(rp + "transcript.txt", block); s.writeJson(rp + "2_이해도_점수.json", a); s.write(rp + "2_이해도_점수.md", scoreMd(a, n, s.label));
    s.log("assess_done", { round: n, trigger, score: a.overall.score, low: a.overall.low, high: a.overall.high, confidence: a.overall.confidence });
    s.persist(); s.timing("assess", `이해도 평가 (라운드 ${n})`, n, t0); s.writeReports();
    return { round: n, assessment: a, trigger, ...s.payload() };
  }
  if (step === "questions") {
    if (!s.rounds.length) throw new Error("먼저 이해도 평가가 필요합니다.");
    if (s.questions !== null) throw new Error("질문은 이미 생성되었습니다. (질문 생성은 1회만 진행합니다)");
    const d = await runLlm(s, b, P.QUESTION_SYS, questionsUser(s.concepts, s.rounds[0].assessment, []), "questions");
    const q = postQuestions(d, s.concepts); s.questions = q;
    s.writeJson("3_학생에게_질문.json", q); s.write("3_학생에게_질문.md", questionsMd(q, s.label));
    s.log("questions_done", { n_questions: q.questions.length }); s.persist(); s.timing("questions", "질문 생성", 0, t0); s.writeReports();
    return { questions: q, ...s.payload() };
  }
  if (step === "feedback") {
    if (!s.rounds.length) throw new Error("먼저 이해도 평가가 필요합니다.");
    const rd = s.rounds[s.rounds.length - 1], done = new Set(rd.qa.map(e => e.qid));
    const pending = []; for (const q of (s.questions || { questions: [] }).questions) if (!done.has(q.qid)) pending.push(...q.targets);
    const d = await runLlm(s, b, P.FEEDBACK_SYS, feedbackUser(s.concepts, rd.assessment, pending), "feedback");
    const f = postFeedback(d, s.concepts); rd.feedback = f;
    const rp = `round_${pad(rd.n)}/`;
    s.writeJson(rp + "4_학생에게_피드백.json", f); s.write(rp + "4_학생에게_피드백.md", feedbackMd(f, rd.n, s.label));
    s.log("feedback_done", { round: rd.n }); s.persist(); s.timing("feedback", `피드백 작성 (라운드 ${rd.n})`, rd.n, t0); s.writeReports();
    return { round: rd.n, feedback: f, ...s.payload() };
  }
  throw new Error("알 수 없는 단계: " + step);
}
