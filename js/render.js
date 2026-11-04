/* 산출물 → 마크다운 (ver0.2 Python 버전 이식) */
const IMPL = { 3: "★★★ 핵심", 2: "★★ 중요", 1: "★ 보조" };
const f0 = x => Number(x).toFixed(0), f1 = x => Number(x).toFixed(1);

function conceptsMd(c, meta) {
  const L = ["# 알아야 할 개념\n", `- 발표자료: \`${meta.file || ""}\`  /  세션: \`${meta.id || ""}\``, `- 발표 주제: ${c.topic || ""}`, `- 개념 수: ${c.concepts.length}\n`,
    "> 학생이 이 발표자료의 내용을 다 이해했다고 보기 위해 알아야 할 개념 목록입니다.\n", "| id | 개념 | 중요도 | 구분 | 쪽 | 설명 |", "|---|---|---|---|---|---|"];
  for (const x of c.concepts) {
    let org = x.origin === "slide" ? "슬라이드" : "선행 개념"; if (x.from_figure) org += " (그림·차트)";
    L.push(`| ${x.id} | ${x.name} | ${IMPL[x.importance]} | ${org} | ${x.slides.join(",")} | ${x.description} |`);
  }
  L.push("\n## 개념별 근거\n");
  for (const x of c.concepts) {
    const mark = x.quote_verified === false ? " ⚠ 슬라이드 원문에서 인용을 찾지 못함" : "";
    L.push(`- **${x.id} ${x.name}** — ${x.why_needed || ""}`);
    if (x.source_quote) L.push(`  - 슬라이드 인용: "${x.source_quote}"${mark}`);
  }
  return L.join("\n") + "\n";
}

function scoreMd(a, roundNo, label) {
  const o = a.overall;
  const L = [`# 학생 이해도 점수 — ${label || "(이름 없음)"} (라운드 ${roundNo})\n`, "## 종합\n",
    `- **이해도 점수: ${f1(o.score)} / 100**`, `- 범위(신뢰구간 성격): ${f1(o.low)} ~ ${f1(o.high)}`,
    `- **신뢰율: ${f0(o.confidence * 100)}% (판단 확실도 ${o.confidence_label})**`,
    `- 언급·평가된 개념 비율: ${f0(o.coverage * 100)}% (${o.n_concepts}개 개념 기준)`,
    `- 점수 산출 근거: ${o.score_basis || ""}`, `- 신뢰율·범위 산출 근거: ${(o.confidence_basis || "")}\n`,
    "> 종합 점수·범위·신뢰율은 모델이 직접 판단한 값입니다. 범위는 통계적 신뢰구간이 아닙니다.\n", "## 불확실하거나 신뢰하기 어려운 점\n"];
  if (a.uncertainties.length) a.uncertainties.forEach(u => L.push(`- ${u}`)); else L.push("- (없음)");
  a.notes.forEach(n => L.push(`- (주의) ${n}`));
  L.push("\n## 점수 산출 근거 (개념별)\n", "| id | 개념 | 중요도 | 수준 | 점수 | 범위 |", "|---|---|---|---|---|---|");
  for (const i of a.items) L.push(`| ${i.id} | ${i.name} | ${i.importance} | ${i.level} | ${f0(i.score)} | ${f0(i.low)}~${f0(i.high)} |`);
  L.push("");
  for (const i of a.items) {
    L.push(`### ${i.id} ${i.name} — ${i.level} (${f0(i.score)}점, ${f0(i.low)}~${f0(i.high)})`, i.rationale || "");
    if (i.misconception) L.push(`- **오개념**: ${i.misconception}`);
    for (const q of i.evidence) L.push(`- 근거 발화: "${q.text}"` + (q.verified === false ? "  ⚠ 전사에서 확인되지 않음" : ""));
    L.push("");
  }
  return L.join("\n");
}

function questionsMd(q, label) {
  const L = [`# 학생에게 질문 — ${label || "(이름 없음)"}\n`];
  if (!q.questions.length) { L.push(`질문 없음 — ${q.no_question_reason}`); return L.join("\n") + "\n"; }
  L.push("> 질문 생성은 1회만 진행합니다. 질문 하나의 답변을 반영할 때마다 라운드가 1씩 늘어납니다(Q1→라운드 1, Q2→라운드 2 …).\n");
  for (const x of q.questions) L.push(`## ${x.qid}. ${x.question}`, `- 확인 대상 개념: ${x.targets.join(", ")}`, `- 질문 목적: ${x.purpose}`,
    `- 이해했다면 나올 답: ${x.expected_good_answer}`, `- 답변에 따른 판단: ${x.how_it_resolves}\n`);
  return L.join("\n");
}

function feedbackMd(f, roundNo, label) {
  const L = [`# 학생에게 피드백 — ${label || "(이름 없음)"} (라운드 ${roundNo})\n`, `${f.summary}\n`, "## 1. 오개념\n"];
  if (f.misconceptions.length) for (const x of f.misconceptions)
    L.push(`### ${x.concept_id} ${x.concept_name}`, `- 학생의 설명: ${x.student_said || ""}`, `- 문제점: ${x.problem || ""}`, `- 올바른 설명: ${x.correct_explanation || ""}`, `- 공부 가이드: ${x.how_to_study || ""}\n`);
  else L.push("(확인된 오개념 없음)\n");
  L.push("## 2. 개념 공백\n");
  if (f.gaps.length) for (const x of f.gaps) L.push(`### ${x.concept_id} ${x.concept_name}`, `- 설명: ${x.explanation || ""}`, `- 공부 가이드: ${x.how_to_study || ""}\n`);
  else L.push("(확인된 개념 공백 없음)\n");
  return L.join("\n");
}

const tFmt = x => { x = Number(x || 0); return x >= 60 ? `${Math.floor(x / 60)}분 ${(x % 60).toFixed(0)}초` : `${x.toFixed(1)}초`; };
function sgFmt(v, nd = 1, pct = false) {
  if (v == null) return "-"; v = pct ? v * 100 : v;
  return (v >= 0 ? "+" : "") + v.toFixed(nd) + (pct ? "%p" : "");
}
function historyMd(h) {
  const L = ["| 라운드 | 계기 | 점수 | 범위 | 신뢰율 | Δ점수 | Δ신뢰율 | 소요 |", "|---|---|---|---|---|---|---|---|"];
  for (const r of h) L.push(`| ${r.round} | ${r.trigger} | ${f1(r.score)} | ${f1(r.low)}~${f1(r.high)} | ${f0(r.conf * 100)}% (${r.conf_label}) | ${sgFmt(r.d_score)} | ${sgFmt(r.d_conf, 0, true)} | ${tFmt(r.seconds)} |`);
  return L.join("\n");
}
function changesMd(h) {
  const L = [];
  for (const r of h) {
    if (r.round === 0) continue;
    L.push(`**라운드 ${r.round} (${r.trigger})** — 점수 ${sgFmt(r.d_score)}, 신뢰율 ${sgFmt(r.d_conf, 0, true)}` + (r.n_changes ? `, 개념 ${r.n_changes}개 변화` : ", 개념별 점수 변화 없음"));
    for (const c of r.changes) L.push(`- ${c.id} ${c.name}: ${f0(c.from)}(${c.level_from}) → ${f0(c.to)}(${c.level_to})`);
    L.push("");
  }
  return L.join("\n") || "(질문 답변 반영 전)";
}
function timingsMd(t) {
  const L = ["| 단계 | 라운드 | 시작 | 소요 |", "|---|---|---|---|"];
  for (const x of t.stages) L.push(`| ${x.label} | ${x.round} | ${x.start} | ${tFmt(x.seconds)} |`);
  L.push(`| **합계(단계 소요 합)** | | | **${tFmt(t.active_seconds)}** |`);
  L.push(`\n> 세션 시작 후 경과: ${tFmt(t.wall_seconds)} (사람이 답변을 입력한 대기 시간 포함)`);
  return L.join("\n");
}
const nf = v => v == null ? "미제공" : Number(v).toLocaleString("en-US");
const cf = v => v == null ? "미제공" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
function usageMd(u) {
  const L = ["| # | 단계 | 모델 | 입력 | 출력 | 합계 | 차감 크레딧 |", "|---|---|---|---|---|---|---|"];
  u.calls.forEach((c, i) => L.push(`| ${i + 1} | ${c.stage} (라운드 ${c.round}) | ${c.model} | ${nf(c.prompt)} | ${nf(c.completion)} | ${nf(c.total)} | ${cf(c.credit)} |`));
  L.push(`| | **합계** | | **${nf(u.prompt)}** | **${nf(u.completion)}** | **${nf(u.total)}** | **${cf(u.credit)}** |`);
  return L.join("\n");
}
const bodyOf = md => md.startsWith("#") ? md.split("\n").slice(1).join("\n") : md;

function qaStatus(rec) {
  const q = rec.questions;
  if (!q) return ["(질문 미생성)"];
  if (!q.questions.length) return [`질문 없음 — ${q.no_question_reason}`];
  const applied = {}; for (const r of rec.rounds) if (r.trigger_qid) applied[r.trigger_qid] = r;
  const out = [];
  for (const x of q.questions) {
    const r = applied[x.qid];
    let ans = null; for (const rd of rec.rounds) for (const e of rd.qa) if (e.qid === x.qid) ans = e.answer;
    out.push(`### ${x.qid}. ${x.question}`, `- 확인 대상: ${x.targets.join(", ")} · 목적: ${x.purpose}`);
    if (r) { const h = rec.history.find(h => h.round === r.n);
      out.push(`- 답변: ${ans}`, `- 반영 결과(라운드 ${r.n}): 점수 ${f1(h.score)} (${sgFmt(h.d_score)}), 신뢰율 ${f0(h.conf * 100)}% (${sgFmt(h.d_conf, 0, true)})`); }
    else out.push("- 답변: (아직 반영되지 않음)");
    out.push("");
  }
  return out;
}
function feedbackBlock(f, brief) {
  if (!f) return ["(피드백 없음)"];
  const L = [f.summary, "", "**오개념**"];
  if (f.misconceptions.length) f.misconceptions.forEach(x => L.push(`- ${x.concept_id} ${x.concept_name}: ${x.problem || ""} → ${x.correct_explanation || ""}` + (brief ? "" : `  (공부: ${x.how_to_study || ""})`)));
  else L.push("- (확인된 오개념 없음)");
  L.push("\n**개념 공백**");
  if (f.gaps.length) f.gaps.forEach(x => L.push(`- ${x.concept_id} ${x.concept_name}: ${x.explanation || ""}` + (brief ? "" : `  (공부: ${x.how_to_study || ""})`)));
  else L.push("- (확인된 개념 공백 없음)");
  return L;
}

function summaryMd(rec) {
  const m = rec.meta, last = rec.rounds[rec.rounds.length - 1], a = last.assessment, o = a.overall;
  const L = [`# TRACE 요약본 — ${m.label || "(이름 없음)"}`, "", `- 세션 \`${m.id}\` · 발표자료 \`${m.file || ""}\` · 모델 \`${m.model || ""}\` · 시작 ${rec.started}`, "",
    `## 1. 학생의 이해도 점수와 신뢰도 (최종: 라운드 ${last.n})`, "",
    `- **이해도 점수: ${f1(o.score)} / 100** (범위 ${f1(o.low)} ~ ${f1(o.high)})`,
    `- **신뢰율: ${f0(o.confidence * 100)}% (${o.confidence_label})** · 언급·평가된 개념 ${f0(o.coverage * 100)}%`, "- 불확실하거나 신뢰하기 어려운 점:"];
  if (a.uncertainties.length) a.uncertainties.forEach(u => L.push(`  - ${u}`)); else L.push("  - (없음)");
  a.notes.forEach(n => L.push(`  - (주의) ${n}`));
  L.push("", "### 라운드별 변화", "", historyMd(rec.history), "", changesMd(rec.history), "", "## 2. 학생에게 질문", "", ...qaStatus(rec));
  L.push("## 3. 학생에게 피드백 (최신 라운드 기준)", "", ...feedbackBlock(last.feedback, false));
  L.push("", "> 종합 점수·범위·신뢰율은 모델이 직접 판단한 값입니다. 범위는 통계적 신뢰구간이 아닙니다.", "");
  return L.join("\n");
}

function fullMd(rec) {
  const m = rec.meta, lab = m.label || "";
  const L = [`# TRACE 전체 기록 — ${lab || "(이름 없음)"}`, "", `- 세션 \`${m.id}\` · 발표자료 \`${m.file || ""}\` · 모델 \`${m.model || ""}\` · 시작 ${rec.started}`,
    "- 구성: 입력 → 알아야 할 개념 → 라운드별(점수·근거·피드백) → 질문 → 시간 → 토큰 → 과정 로그 → 부록", "",
    "## A. 라운드 이력 요약", "", historyMd(rec.history), "", changesMd(rec.history), "", "---", "", "## B. 알아야 할 개념", "", bodyOf(conceptsMd(rec.concepts, m)), "---", ""];
  for (const r of rec.rounds) L.push(`## C${r.n}. 라운드 ${r.n} — ${r.trigger}`, "", "### 이해도 점수와 산출 근거", "", bodyOf(scoreMd(r.assessment, r.n, lab)), "", "### 이 라운드의 피드백", "", ...feedbackBlock(r.feedback), "", "---", "");
  L.push("## D. 학생에게 질문 (1회 생성)", "", bodyOf(questionsMd(rec.questions || { questions: [], no_question_reason: "(미생성)" }, lab)), "", "### 질문별 답변과 반영 결과", "", ...qaStatus(rec), "---", "",
    "## E. 단계별 소요 시간", "", timingsMd(rec.timings), "", "## F. 토큰 사용량", "", usageMd(rec.usage), "", "## G. 과정 로그", "", rec.process_log || "(없음)", "",
    "## 부록 1. 발표자료 추출 텍스트(그림·차트 설명 포함)", "", "```", rec.slides_text, "```", "", "## 부록 2. 학생 발표 전사", "", "```", rec.transcript, "```", "");
  const qa = rec.rounds[rec.rounds.length - 1].qa;
  if (qa.length) { L.push("## 부록 3. 질문 답변 전사", ""); for (const e of qa) L.push(`**${e.qid}. ${e.question}**`, "", "```", e.answer, "```", ""); }
  return L.join("\n");
}
