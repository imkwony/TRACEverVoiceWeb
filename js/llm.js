/* LLM 호출: BAZE API Gateway (OpenAI 호환). 브라우저에서 직접 호출한다. 키는 메모리에만 두고 어디에도 기록하지 않는다. */
const DEFAULT_BASE = "https://api.baze.co/v1/gateway";
const LLM_TIMEOUT_MS = 240000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
class LLMError extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch (e) {
    const s = t.indexOf("{"), e2 = t.lastIndexOf("}");
    if (s !== -1 && e2 > s) return JSON.parse(t.slice(s, e2 + 1));
    throw e;
  }
}
const baseOf = b => String(b || DEFAULT_BASE).trim().replace(/\/+$/, "");
const headersOf = key => ({ "Authorization": "Bearer " + key, "Content-Type": "application/json" });

async function fetchTimeout(url, opts, ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}
async function postJson(url, headers, body) {
  let last = "";
  for (let a = 0; a < 4; a++) {
    let r;
    try { r = await fetchTimeout(url, { method: "POST", headers, body: JSON.stringify(body) }, LLM_TIMEOUT_MS); }
    catch (e) {
      last = e.name === "AbortError" ? "시간 초과" : "브라우저가 BAZE에 접속하지 못했습니다(네트워크 또는 CORS 차단): " + e.message;
      await sleep(2000 * (a + 1)); continue;
    }
    if (RETRY_STATUS.has(r.status)) { last = `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`; await sleep(3000 * (a + 1)); continue; }
    if (r.status >= 400) throw new LLMError(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
    return await r.json();
  }
  throw new LLMError("재시도 후에도 실패: " + last);
}

async function listModels(key, baseUrl) {
  let r;
  try { r = await fetchTimeout(baseOf(baseUrl) + "/models/?type=llm", { headers: headersOf(key) }, 60000); }
  catch (e) { throw new LLMError("모델 목록 요청 실패: " + e.message); }
  if (r.status >= 400) throw new LLMError(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  try { const j = await r.json(); return j.data.map(m => ({ id: m.id, owned_by: m.owned_by || "" })); }
  catch (e) { throw new LLMError("모델 목록 응답 형식이 문서와 다릅니다."); }
}

async function callRaw(model, key, system, user, baseUrl, images, audio, media) {
  if (media && media.length) return await geminiRaw(model, key, system, user, baseUrl, media);
  const content = ((!images || !images.length) && !audio) ? user
    : [{ type: "text", text: user }, ...(images || []).map(u => ({ type: "image_url", image_url: { url: u } })),
       ...(audio ? [{ type: "input_audio", input_audio: { data: audio.data, format: audio.format } }] : [])];   // OpenAI 호환 음성 입력
  const body = { model, messages: [{ role: "system", content: system }, { role: "user", content }], max_tokens: 16000 };
  const j = await postJson(baseOf(baseUrl) + "/chat/completions/", headersOf(key), body);
  let text;
  try { text = j.choices[0].message.content; } catch (e) { throw new LLMError("응답 형식 오류: " + JSON.stringify(j).slice(0, 300)); }
  if (!text) throw new LLMError("모델이 빈 응답을 반환했습니다(추론 토큰 소진 가능). 다른 모델로 시도해 보세요.");
  const u = j && j.usage, bill = j && j.billing;
  let usage = null;
  if ((u && typeof u === "object") || (bill && typeof bill === "object")) {
    const uu = (u && typeof u === "object") ? u : {};
    const pt = uu.prompt_tokens ?? null, ct = uu.completion_tokens ?? null;
    let tt = uu.total_tokens ?? null;
    if (tt == null && pt != null && ct != null) tt = pt + ct;
    let cr = (bill && typeof bill === "object") ? bill.deducted_credit : null;
    cr = cr == null || isNaN(Number(cr)) ? null : Number(cr);
    usage = { prompt: pt, completion: ct, total: tt, credit: cr };
  }
  return [text, usage];
}

/* ---------- Gemini 네이티브(BAZE 패스스루): PDF를 파일 그대로(inline_data) 전달 ---------- */
const isGemini = m => /gemini/i.test(String(m));
const MAX_INLINE_BYTES = 14 * 1024 * 1024;
function bufToB64(buf) {
  const u8 = new Uint8Array(buf); let s = ""; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
async function geminiRaw(model, key, system, user, baseUrl, media) {
  const parts = [{ text: user }, ...media.map(m => ({ inline_data: { mime_type: m.mime, data: m.data } }))];
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: 16000 } };
  const url = baseOf(baseUrl) + "/gemini/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  const j = await postJson(url, { ...headersOf(key), "x-goog-api-key": key }, body);
  let text;
  try { text = (j.candidates[0].content.parts || []).map(p => p.text || "").join(""); } catch (e) { throw new LLMError("응답 형식 오류: " + JSON.stringify(j).slice(0, 300)); }
  if (!text) throw new LLMError("모델이 빈 응답을 반환했습니다. 다른 모델로 시도해 보세요.");
  const u = j.usageMetadata || {}, bill = j.billing;
  const cr = bill && bill.deducted_credit != null && !isNaN(Number(bill.deducted_credit)) ? Number(bill.deducted_credit) : null;
  return [text, { prompt: u.promptTokenCount ?? null, completion: u.candidatesTokenCount ?? null, total: u.totalTokenCount ?? null, credit: cr }];
}

/* ---------- mock (API 호출 없이 화면·흐름 시험용) ---------- */
function mockResponse(stage, user) {
  const ids = [...new Set([...user.matchAll(/"id":\s*"(C\d+)"/g)].map(m => m[1]))];
  if (stage === "concepts") {
    return { topic: "(mock) 발표 주제", concepts: [1, 2, 3, 4, 5].map(i => ({
      id: "C" + i, name: "개념 " + i, description: `(mock) 개념 ${i} 설명`, importance: i === 1 ? 3 : 2, origin: "slide",
      slides: [i], source_quote: "", why_needed: "(mock)", from_figure: i === 2 })) };
  }
  if (stage === "assess") {
    const lv = ["적용적", "정확", "미언급", "오개념", "표면적", "정확"];
    const sc = { "적용적": 95, "정확": 75, "미언급": 0, "오개념": 10, "표면적": 50 };
    const k = (user.match(/\[학생 답변/g) || []).length;
    const items = ids.map((cid, n) => {
      const l = lv[n % lv.length];
      const s = Math.min(100, sc[l] + 8 * k * (l !== "정확" ? 1 : 0));
      const w = Math.max(5, (l === "미언급" ? 45 : (l === "표면적" ? 35 : 10)) - 8 * k);
      return { id: cid, level: l, score: s, low: Math.max(0, s - w), high: Math.min(100, s + w), evidence_quotes: [],
        rationale: `(mock) ${l} 수준으로 판단`, misconception: l === "오개념" ? "(mock) 잘못된 설명" : null };
    });
    const avg = items.reduce((a, i) => a + i.score, 0) / Math.max(1, items.length);
    const wd = items.reduce((a, i) => a + i.high - i.low, 0) / Math.max(1, items.length);
    return { overall: { score: Math.round(avg * 10) / 10, low: Math.max(0, avg - wd / 2), high: Math.min(100, avg + wd / 2), confidence: Math.max(0, 100 - wd),
        score_basis: "(mock) 개념별 점수의 평균으로 정했습니다.", confidence_basis: "(mock) 개념별 범위의 평균 폭이 좁을수록 신뢰율을 높게 잡았습니다." },
      items, overall_uncertainties: ["(mock) 전사가 짧아 불확실"], reliability_notes: ["(mock)"] };
  }
  if (stage === "questions") {
    const t1 = ids[2] || ids[0] || "C1", t2 = ids[3] || t1;
    const mk = t => ({ question: `(mock) ${t}에 대해 설명해 보세요.`, targets: [t], purpose: "(mock) 불확실 해소", expected_good_answer: "(mock)", how_it_resolves: "(mock)" });
    return { questions: [mk(t1), mk(t2)], no_question_reason: "" };
  }
  if (stage === "feedback") {
    return { summary: "(mock) 전반적으로 보완 필요",
      misconceptions: [{ concept_id: ids[3] || "C1", student_said: "(mock)", problem: "(mock) 오개념", correct_explanation: "(mock)", how_to_study: "(mock)" }],
      gaps: [{ concept_id: ids[2] || "C1", explanation: "(mock)", how_to_study: "(mock)" }] };
  }
  return {};
}
async function callVision(model, key, system, user, images, baseUrl) {
  if (model === "mock") return [`(mock) 그림 ${images.length}개: 막대/도식 형태의 그림. 핵심 수치·관계는 mock이라 생략.`, null];
  return await callRaw(model, key, system, user, baseUrl, images);
}
function addUsage(a, b) {
  if (!a) return b; if (!b) return a;
  const o = {}; for (const k of ["prompt", "completion", "total", "credit"]) o[k] = (a[k] == null || b[k] == null) ? null : a[k] + b[k];
  return o;
}
async function callJson(model, key, system, user, stage, baseUrl, images, audio, media) {
  if (model === "mock") { const d = mockResponse(stage, user); return [d, JSON.stringify(d), null]; }
  const [raw, u1] = await callRaw(model, key, system, user, baseUrl, images, audio, media);
  try { return [parseJson(raw), raw, u1]; } catch (e) {
    const [raw2, u2] = await callRaw(model, key, system + "\n\n반드시 유효한 JSON 객체 하나만 출력하라. 설명·코드펜스 금지.", user, baseUrl, images, audio, media);
    try { return [parseJson(raw2), raw2, addUsage(u1, u2)]; }
    catch (e2) { throw new LLMError("모델이 유효한 JSON을 반환하지 않았습니다. 다른 모델로 시도해 보세요."); }
  }
}
