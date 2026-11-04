/* 프롬프트 조립과 후처리 (ver0.2 Python 버전 이식). 지시문 본문은 prompts.js */
const P = PROMPTS;
const r1 = x => Math.round(x * 10) / 10;

function conceptsUser(slides, nImages = 0) {
  const head = nImages
    ? `첨부된 이미지 ${nImages}장은 발표자료의 각 쪽을 1쪽부터 순서대로 그린 것이다. 이미지가 발표자료의 원본이며, 글자가 추출되지 않은 쪽은 이미지를 직접 읽어라. 아래 텍스트는 보조 정보(추출된 글자)다.\n\n`
    : "아래는 발표자료에서 추출한 슬라이드별 텍스트(차트 데이터·그림 설명 포함)다.\n\n";
  return head + slidesToText(slides);
}

function figUser(slide) {
  const alts = (slide.images || []).filter(i => i.alt).map(i => i.alt);
  const page = slide.images.some(i => i.page);
  let s = `슬라이드 ${slide.n}의 텍스트(맥락용):\n${slide.text || "(없음)"}\n\n` + (page
    ? "첨부된 이미지는 이 슬라이드(페이지) 전체를 그린 것이다. 그 안의 그림·도표·차트·사진만 위 규칙대로 설명하라(본문 글자는 다시 옮기지 않는다)."
    : `첨부된 그림 ${slide.images.length}개를 위 규칙대로 설명하라.`);
  if (alts.length) s += "\n(작성자가 달아 둔 대체 텍스트: " + alts.join(" / ") + ")";
  return s;
}

function postConcepts(d, slides) {
  const full = slidesToText(slides);
  const bySlide = {};
  for (const s of slides.slides) bySlide[s.n] = s.text + "\n" + s.notes + "\n" + (s.figures || []).map(f => f.text).join(" ");
  const out = [];
  (d.concepts || []).forEach((c, i) => {
    c.id = c.id || "C" + (i + 1);
    c.importance = Math.min(3, Math.max(1, parseInt(c.importance || 2) || 2));
    c.origin = c.origin || "slide";
    c.from_figure = !!c.from_figure;
    c.slides = c.slides || [];
    const q = c.source_quote || "";
    if (c.origin === "slide" && q) {
      const pool = c.slides.map(n => bySlide[n] || "").join(" ") || full;
      c.quote_verified = (pool.trim() || !(slides.page_images && slides.page_images.length)) ? (contains(pool, q) || contains(full, q)) : null;
    } else c.quote_verified = null;
    out.push(c);
  });
  d.concepts = out; return d;
}

function buildTranscriptBlock(initial, qa) {
  const parts = initial.trim() ? ["[발표 내용 전사]\n" + initial.trim()] : [];
  for (const e of qa) parts.push(`[질문 ${e.qid}] ${e.question}\n[학생 답변 ${e.qid}]\n${e.answer.trim()}`);
  return parts.join("\n\n");
}
function assessUser(concepts, block, audio = false) {
  const slim = concepts.concepts.map(c => ({ id: c.id, name: c.name, description: c.description, importance: c.importance, ...(c.from_figure ? { from_figure: true } : {}) }));
  return "## 알아야 할 개념\n" + JSON.stringify(slim)
    + (audio ? "\n\n## 발표 음성\n학생의 발표는 이 메시지에 첨부된 음성 파일이다. 음성을 직접 듣고 평가하라. evidence_quotes는 학생이 음성에서 실제로 한 말을 그대로 옮겨 적는다.\n\n## 질문·답변 전사(텍스트)\n" : "\n\n## 학생 발화 전사\n") + block;
}

function postAssess(d, concepts, block, audio = false) {
  const got = {}; for (const it of d.items || []) got[it.id] = it;
  const items = []; let unverified = 0; const missing = []; let nMentioned = 0;
  const num = (v, dflt) => { const x = Number(v); return v == null || isNaN(x) ? dflt : x; };
  for (const c of concepts.concepts) {
    let it = got[c.id];
    if (!it) { missing.push(c.id); it = { level: "미언급", score: 0, low: 0, high: 50, evidence_quotes: [], rationale: "(모델이 이 개념의 평가를 반환하지 않아 미언급으로 처리)", misconception: null }; }
    const s = Math.min(100, Math.max(0, num(it.score, 0)));
    const lo = Math.min(s, Math.max(0, num(it.low, s)));
    const hi = Math.max(s, Math.min(100, num(it.high, s)));
    const lvl = String(it.level || "").trim().slice(0, 12) || "-";
    const quotes = [];
    for (const q of it.evidence_quotes || []) { const ok = audio ? null : contains(block, q); if (ok === false) unverified++; quotes.push({ text: q, verified: ok }); }
    if (s > 0 || quotes.length) nMentioned++;
    items.push({ id: c.id, name: c.name, importance: c.importance, level: lvl, score: r1(s), low: r1(lo), high: r1(hi), evidence: quotes,
      rationale: it.rationale || "", misconception: it.misconception || null });
  }
  const ov = d.overall || {};
  let score = Math.min(100, Math.max(0, num(ov.score, NaN))); let missingOverall = false;
  if (isNaN(score)) { score = items.reduce((a, i) => a + i.score, 0) / Math.max(1, items.length); missingOverall = true; }
  const lo = Math.min(score, Math.max(0, num(ov.low, score))), hi = Math.max(score, Math.min(100, num(ov.high, score)));
  let cv = num(ov.confidence, NaN); if (isNaN(cv)) cv = Math.max(0, 100 - (hi - lo));
  const conf = Math.max(0, Math.min(1, cv > 1 ? cv / 100 : cv));
  const label = conf >= 0.8 ? "높음" : (conf >= 0.6 ? "중간" : "낮음");
  const notes = [...(d.reliability_notes || [])];
  if (missingOverall) notes.push("모델이 종합 점수를 반환하지 않아 개념별 점수의 단순 평균으로 대체했습니다.");
  if (missing.length) notes.push(`모델이 평가를 빠뜨린 개념 ${missing.length}개(${missing.join(", ")})는 미언급으로 처리했습니다.`);
  if (unverified) notes.push(`근거 인용 중 ${unverified}개는 전사 원문에서 찾지 못했습니다(표시 ⚠). 해당 근거는 신뢰하기 어렵습니다.`);
  if (audio) notes.push("발표가 음성으로 직접 입력되어, 근거 인용은 모델이 음성에서 옮긴 것이며 원문 대조(⚠ 표시)를 하지 않았습니다.");
  const nWords = block.split(/\s+/).filter(Boolean).length;
  if (!audio && nWords < 150) notes.push(`전사 분량이 짧습니다(약 ${nWords}어절). 이해도 추정의 불확실성이 큽니다.`);
  const none = "(모델이 설명을 반환하지 않았습니다)";
  return { overall: { score: r1(score), low: r1(lo), high: r1(hi), confidence: Math.round(conf * 1000) / 1000, confidence_label: label,
      coverage: Math.round(nMentioned / Math.max(1, items.length) * 1000) / 1000,
      score_basis: String(ov.score_basis || none).trim(), confidence_basis: String(ov.confidence_basis || none).trim(),
      n_concepts: items.length, unverified_quotes: unverified },
    items, uncertainties: d.overall_uncertainties || [], notes };
}

function questionsUser(concepts, assessment, asked) {
  const rows = assessment.items.map(i => ({ id: i.id, name: i.name, importance: i.importance, level: i.level, score: i.score, low: i.low, high: i.high,
    width: r1(i.high - i.low), misconception: i.misconception }));
  let s = "## 현재 평가(개념별)\n" + JSON.stringify(rows);
  s += "\n\n## 전체\n" + JSON.stringify(assessment.overall);
  s += "\n\n## 불확실 요소\n" + JSON.stringify(assessment.uncertainties);
  if (asked && asked.length) s += "\n\n[이미 질문함]\n" + asked.map(q => `- ${q.qid}: ${q.question}`).join("\n");
  return s;
}
function postQuestions(d, concepts) {
  const ids = new Set(concepts.concepts.map(c => c.id));
  let qs = (d.questions || []).slice(0, 3).map((q, k) => ({ qid: "Q" + (k + 1), question: q.question || "", targets: (q.targets || []).filter(t => ids.has(t)),
    purpose: q.purpose || "", expected_good_answer: q.expected_good_answer || "", how_it_resolves: q.how_it_resolves || "" }));
  qs = qs.filter(q => q.question.trim());
  let reason = qs.length ? "" : (d.no_question_reason || "");
  if (!qs.length && !reason) reason = "추가 질문 없이도 이해도를 충분히 판단할 수 있다고 모델이 판단했습니다.";
  return { questions: qs, no_question_reason: reason };
}

function feedbackUser(concepts, assessment, pending) {
  const cs = {}; for (const c of concepts.concepts) cs[c.id] = c;
  const rows = assessment.items.map(i => ({ id: i.id, name: i.name, description: cs[i.id].description, importance: i.importance, level: i.level, score: i.score,
    range: [i.low, i.high], misconception: i.misconception, rationale: i.rationale, from_figure: !!cs[i.id].from_figure }));
  return "## 개념별 평가\n" + JSON.stringify(rows) + "\n\n## pending_question_targets\n" + JSON.stringify(pending);
}
function postFeedback(d, concepts) {
  const names = {}; for (const c of concepts.concepts) names[c.id] = c.name;
  for (const k of ["misconceptions", "gaps"]) {
    d[k] = (d[k] || []).filter(x => x && names[x.concept_id] !== undefined);
    for (const x of d[k]) x.concept_name = names[x.concept_id];
  }
  if (d.summary === undefined) d.summary = "";
  return d;
}
