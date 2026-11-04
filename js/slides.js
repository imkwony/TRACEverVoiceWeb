/* 발표자료(PPTX/PDF) → 슬라이드별 텍스트·차트 데이터·그림 추출 (브라우저에서 직접 처리) */
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAX_IMG_PER_SLIDE = 3;

const _norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
function contains(hay, quote) {
  if (!quote || !String(quote).trim()) return false;
  const h = _norm(hay);
  const parts = String(quote).split(/\.\.\.|…/).filter(p => _norm(p).length >= 2);
  return parts.length > 0 && parts.every(p => h.includes(_norm(p)));
}

/* ---------- XML 도우미 ---------- */
const parseXml = txt => new DOMParser().parseFromString(txt, "application/xml");
const kids = (el, ln) => [...el.children].filter(c => c.localName === ln);
const kid = (el, ln) => kids(el, ln)[0] || null;
const descs = (el, ln) => [...el.getElementsByTagName("*")].filter(c => c.localName === ln);
function relsOf(rels) {                // {Id: Target}
  const m = {}; if (!rels) return m;
  for (const r of descs(rels, "Relationship")) m[r.getAttribute("Id")] = r.getAttribute("Target");
  return m;
}
function resolve(baseDir, target) {    // baseDir: 'ppt/slides' , target: '../media/a.png'
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of target.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
  return parts.join("/");
}
function paragraphsOf(txBody) {
  const out = [];
  for (const p of kids(txBody, "p")) {
    const t = kids(p, "r").map(r => (kid(r, "t") || { textContent: "" }).textContent).join("").trim();
    if (t) out.push(t);
  }
  return out;
}
const textOfAll = el => descs(el, "t").map(t => t.textContent).join("").trim();

/* ---------- 차트: 이미지 해석 없이 데이터(범주·계열·값)를 그대로 읽는다 ---------- */
function chartText(xml) {
  try {
    const doc = parseXml(xml), chart = descs(doc, "chart")[0];
    const plotArea = kid(chart, "plotArea");
    const plots = [...plotArea.children].filter(c => /Chart$/.test(c.localName));
    let kind = plots.length ? plots[0].localName.replace(/Chart$/, "").toUpperCase() : "CHART";
    if (plots.length && plots[0].localName === "barChart") {
      const dir = (kid(plots[0], "barDir") || {}).getAttribute?.("val") === "bar" ? "BAR" : "COLUMN";
      const gr = ((kid(plots[0], "grouping") || {}).getAttribute?.("val") || "clustered").toUpperCase();
      kind = dir + "_" + gr;
    }
    let title = ""; const t = kid(chart, "title"); if (t) title = textOfAll(t);
    const axes = [];
    for (const [nm, ln] of [["x축", "catAx"], ["y축", "valAx"]]) {
      const ax = kid(plotArea, ln); const at = ax && kid(ax, "title");
      if (at) { const s = textOfAll(at); if (s) axes.push(`${nm}=${s}`); }
    }
    const cache = (el, ln) => { const c = el && kid(el, ln); if (!c) return null;
      const ref = [...c.children][0]; const cc = ref && [...ref.children].find(x => /Cache$/.test(x.localName)); return cc || null; };
    const pts = cc => { const o = []; if (!cc) return o; for (const p of kids(cc, "pt")) o[Number(p.getAttribute("idx"))] = (kid(p, "v") || {}).textContent; return o; };
    const series = [];
    for (const plot of plots) {
      const sers = kids(plot, "ser");
      const cats = sers.length ? pts(cache(sers[0], "cat")) : [];
      for (const ser of sers) {
        let name = ""; const tx = kid(ser, "tx"); if (tx) name = descs(tx, "v").map(v => v.textContent).join("");
        const vals = pts(cache(ser, "val"));
        const n = Math.min(cats.length, vals.length);
        const parts = []; for (let i = 0; i < n; i++) parts.push(`${cats[i]}=${vals[i]}`);
        series.push(`${name}: ` + parts.join(", "));
      }
    }
    const head = `[차트 데이터: ${kind}` + (title ? ` · ${title}` : "") + (axes.length ? ` · ${axes.join(" ")}` : "") + "]";
    return head + " " + series.join(" / ");
  } catch (e) { return "[차트 있음 — 데이터를 읽지 못함]"; }
}

/* ---------- 이미지: 최대 1024px JPEG로 줄임. 너무 작거나(아이콘) 읽을 수 없는 형식(EMF/WMF 등)은 null ---------- */
async function shrinkImage(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    if (Math.min(bmp.width, bmp.height) < 60) return null;
    const sc = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); cx.drawImage(bmp, 0, 0, w, h);
    const out = await new Promise(res => cv.toBlob(res, "image/jpeg", 0.85));
    if (!out) return null;
    const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(out); });
    return { blob: out, dataUrl };
  } catch (e) { return null; }
}
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" };

/* ---------- PPTX ---------- */
async function extractPptx(buf, imgStore) {
  const zip = await JSZip.loadAsync(buf);
  const readXml = async p => { const f = zip.file(p); return f ? parseXml(await f.async("string")) : null; };
  const pres = await readXml("ppt/presentation.xml");
  if (!pres) throw new Error("PPTX 형식이 아닙니다(ppt/presentation.xml 없음).");
  const prels = relsOf(await readXml("ppt/_rels/presentation.xml.rels"));
  const order = descs(pres, "sldId").map(s => resolve("ppt", prels[s.getAttributeNS(NS_R, "id")] || ""));
  const slides = [];
  for (let i = 0; i < order.length; i++) {
    const sp = order[i], dir = sp.split("/").slice(0, -1).join("/"), base = sp.split("/").pop();
    const sdoc = await readXml(sp); if (!sdoc) continue;
    const rels = relsOf(await readXml(`${dir}/_rels/${base}.rels`));
    const ctx = { texts: [], pics: 0, raw: [] };
    const tree = descs(sdoc, "spTree")[0];
    const walk = async el => {
      for (const ch of el.children) {
        const ln = ch.localName;
        if (ln === "grpSp") { await walk(ch); continue; }
        if (ln === "pic") {
          ctx.pics++;
          const nv = descs(ch, "cNvPr")[0]; const alt = ((nv && nv.getAttribute("descr")) || "").trim();
          const blip = descs(ch, "blip")[0]; const rid = blip && blip.getAttributeNS(NS_R, "embed");
          if (rid && rels[rid]) ctx.raw.push({ path: resolve(dir, rels[rid]), alt });
        } else if (ln === "graphicFrame") {
          const tbl = descs(ch, "tbl")[0];
          if (tbl) for (const tr of kids(tbl, "tr")) ctx.texts.push(kids(tr, "tc").map(tc => { const tb = kid(tc, "txBody"); return tb ? paragraphsOf(tb).join("\n") : ""; }).join(" | "));
          const ch2 = descs(ch, "chart")[0]; const rid = ch2 && ch2.getAttributeNS(NS_R, "id");
          if (rid && rels[rid]) {
            ctx.pics++;
            const cf = zip.file(resolve(dir, rels[rid]));
            ctx.texts.push(cf ? chartText(await cf.async("string")) : "[차트 있음 — 데이터를 읽지 못함]");
          }
        } else if (ln === "sp") {
          const tb = kid(ch, "txBody"); if (tb) ctx.texts.push(...paragraphsOf(tb));
        }
      }
    };
    if (tree) await walk(tree);
    // 발표자 노트
    let notes = "";
    const nrel = descs(await readXml(`${dir}/_rels/${base}.rels`) || sdoc, "Relationship").find(r => /notesSlide$/.test(r.getAttribute("Type") || ""));
    if (nrel) {
      const nd = await readXml(resolve(dir, nrel.getAttribute("Target")));
      if (nd) for (const s of descs(nd, "sp")) { const ph = descs(s, "ph")[0]; if (ph && ph.getAttribute("type") === "body") { const tb = kid(s, "txBody"); if (tb) notes += paragraphsOf(tb).join("\n"); } }
    }
    const images = [];
    for (let k = 0; k < Math.min(ctx.raw.length, MAX_IMG_PER_SLIDE); k++) {
      const r = ctx.raw[k], f = zip.file(r.path); if (!f) continue;
      const ext = r.path.split(".").pop().toLowerCase();
      const blob = new Blob([await f.async("arraybuffer")], { type: MIME[ext] || "application/octet-stream" });
      const s = await shrinkImage(blob);
      if (s) { const file = `slide_images/s${i + 1}_${k + 1}.jpg`; imgStore[file] = s; images.push({ file, alt: r.alt }); }
    }
    slides.push({ n: i + 1, text: ctx.texts.join("\n"), notes: notes.trim(), n_pictures: ctx.pics, images, figures: [] });
  }
  const warnings = [];
  const nImg = slides.reduce((a, s) => a + s.images.length, 0), nChart = slides.reduce((a, s) => a + (s.text.split("[차트 데이터").length - 1), 0);
  const lost = slides.reduce((a, s) => a + s.n_pictures, 0) - nImg - nChart;
  if (lost > 0) warnings.push(`그림 ${lost}개는 형식(EMF/WMF 등)이나 크기 때문에 읽지 못했습니다.`);
  return { slides, warnings };
}

/* ---------- PDF: 글자 + (그림·도표·차트가 있는 쪽은) 쪽 전체를 이미지로 그려 모델이 읽게 한다 ---------- */
const PDF_PATH_THRESHOLD = 15;   // 벡터 도형(차트·도식) 연산이 이 이상이면 그림이 있는 쪽으로 본다
const MAX_PAGE_IMAGES = 30, PAGE_IMG_PX = 1100;
async function extractPdf(buf, imgStore) {
  if (typeof pdfjsLib === "undefined") throw new Error("PDF 읽기 라이브러리를 불러오지 못했습니다.");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const OPS = pdfjsLib.OPS, IMG_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat].filter(x => x !== undefined));
  const slides = [], pageImages = [], warnings = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let t = ""; for (const it of tc.items) t += it.str + (it.hasEOL ? "\n" : " ");
    let nImg = 0, nPath = 0;
    try {
      const ol = await page.getOperatorList();
      for (let k = 0; k < ol.fnArray.length; k++) {
        const fn = ol.fnArray[k];
        if (IMG_OPS.has(fn)) nImg++; else if (fn === OPS.constructPath) nPath++;
      }
    } catch (e) { nImg = 0; nPath = 0; }
    const images = []; let nPics = 0;
    if (nImg > 0 || nPath >= PDF_PATH_THRESHOLD) {
      nPics = 1;
      try {
        const v1 = page.getViewport({ scale: 1 }), sc = 1600 / Math.max(v1.width, v1.height);
        const vp = page.getViewport({ scale: sc });
        const cv = document.createElement("canvas"); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: cx, viewport: vp }).promise;
        const blob = await new Promise(res => cv.toBlob(res, "image/jpeg", 0.85));
        const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
        const file = `slide_images/s${i}_page.jpg`; imgStore[file] = { blob, dataUrl }; images.push({ file, alt: "", page: true });
      } catch (e) { /* 그림 쪽 렌더 실패 시 글자만 사용 */ }
    }
    slides.push({ n: i, text: t.replace(/[ \t]+\n/g, "\n").trim(), notes: "", n_pictures: nPics, images, figures: [] });
    // 발표자료를 모델에 '그대로' 보내기 위해 모든 쪽을 이미지로 그린다 (글자 없는 스캔/이미지 PDF도 처리)
    if (i > MAX_PAGE_IMAGES) { if (i === MAX_PAGE_IMAGES + 1) warnings.push(`쪽이 ${doc.numPages}개라 앞의 ${MAX_PAGE_IMAGES}쪽만 이미지로 모델에 보냅니다.`); continue; }
    try {
      const v1 = page.getViewport({ scale: 1 }), sc = PAGE_IMG_PX / Math.max(v1.width, v1.height), vp = page.getViewport({ scale: sc });
      const cv = document.createElement("canvas"); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      const blob = await new Promise(res => cv.toBlob(res, "image/jpeg", 0.8));
      const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      const file = `page_images/p${String(i).padStart(3, "0")}.jpg`; imgStore[file] = { blob, dataUrl }; pageImages.push(file);
    } catch (e) { /* 쪽 렌더 실패 시 글자만 사용 */ }
  }
  if (pageImages.length) for (const sl of slides) { sl.images = []; sl.n_pictures = 0; }   // 모든 쪽을 이미지로 보내므로 쪽별 그림 해석은 필요 없다
  return { slides, warnings, page_images: pageImages };
}

async function extractSlides(fileName, buf, imgStore) {
  const ext = (fileName.match(/\.[^.]+$/) || [".pptx"])[0].toLowerCase();
  let r;
  if (ext === ".pptx") r = await extractPptx(buf, imgStore);
  else if (ext === ".pdf") r = await extractPdf(buf, imgStore);
  else throw new Error("지원 형식: .pptx, .pdf  (.ppt 는 .pptx 로 저장 후 사용)");
  const pageImages = r.page_images || [];
  if (!r.slides.some(s => s.text) && !pageImages.length) throw new Error("텍스트를 추출하지 못했습니다. (스캔/이미지 위주 자료일 수 있음. PDF로 저장하면 이미지로 읽을 수 있습니다)");
  const empty = pageImages.length ? [] : r.slides.filter(s => !s.text).map(s => s.n);
  if (empty.length) r.warnings.push(`텍스트가 없는 슬라이드: [${empty.join(", ")}]`);
  return { file: fileName, n_slides: r.slides.length, slides: r.slides, warnings: r.warnings, page_images: pageImages };
}

function slidesToText(sl) {
  const out = [];
  for (const s of sl.slides) {
    out.push(`[슬라이드 ${s.n}]\n${s.text}`);
    for (const f of s.figures || []) out.push(`[그림·차트 설명 — ${f.source}] ${f.text}`);
    if (s.images && s.images.length && !(s.figures && s.figures.length)) out.push(`(이 슬라이드에는 그림 ${s.images.length}개가 있으나 내용을 해석하지 못했음)`);
    if (s.notes) out.push(`(발표자 노트) ${s.notes}`);
  }
  return out.join("\n\n");
}
