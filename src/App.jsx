import { useState, useRef, useCallback, useEffect } from "react";

// ── Config ────────────────────────────────────────────────────────────────────
// All API calls go through Netlify functions — no direct Anthropic access from browser.
// API key lives in Netlify environment variables, never in client code.
const FN_MENU  = "/.netlify/functions/analyze-menu";
const FN_PHOTO = "/.netlify/functions/analyze-photo";
const FN_SCRAPE = "/.netlify/functions/scrape-menu";
const VERSION  = "v5.0";

// ── Nutrients ─────────────────────────────────────────────────────────────────
const NUTRIENTS = [
  { key:"calories",  lo:"cal_lo",  hi:"cal_hi",  label:"Calories", unit:"kcal", color:"#E8A838" },
  { key:"fat_g",     lo:"fat_lo",  hi:"fat_hi",  label:"Fat",      unit:"g",    color:"#E05C5C" },
  { key:"sodium_mg", lo:"sod_lo",  hi:"sod_hi",  label:"Sodium",   unit:"mg",   color:"#A78BFA" },
  { key:"carbs_g",   lo:"carb_lo", hi:"carb_hi", label:"Carbs",    unit:"g",    color:"#60A5FA" },
  { key:"protein_g", lo:"pro_lo",  hi:"pro_hi",  label:"Protein",  unit:"g",    color:"#34D399" },
];
const CAT_COLORS = {
  Appetizer:"#E8A838", Entree:"#E05C5C", Salad:"#34D399",
  Dessert:"#F472B6", Drink:"#60A5FA", Side:"#A78BFA", Soup:"#FB923C",
};

// ── API helpers ───────────────────────────────────────────────────────────────
// Simple fetch to Netlify functions — plain JSON in, plain JSON out.
// No SSE, no streaming, no Safari ReadableStream bugs.

async function callFunction(endpoint, body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Wrap res.json() — Safari throws "string did not match" on non-JSON timeout responses
  let data;
  try { data = await res.json(); }
  catch { throw new Error("Request timed out or server unavailable (HTTP " + res.status + ") — please try again"); }
  if (!res.ok) throw new Error(data.error || "Server error " + res.status);
  return data;
}

async function analyzeText(menuText) {
  return callFunction(FN_MENU, { type: "text", content: menuText });
}

async function analyzeRestaurant(name) {
  return callFunction(FN_MENU, { type: "restaurant", name });
}

async function analyzePhoto(image, mimeType, onStage) {
  // Pass 1: OCR — extract text from image
  const ocrResult = await callFunction(FN_PHOTO, { image, mimeType });
  if (!ocrResult.text?.trim()) throw new Error("Could not read text from image. Try a clearer photo or use the Text tab.");
  onStage("Analyzing nutrition...");
  // Pass 2: Nutrition analysis — same path as text tab
  return callFunction(FN_MENU, { type: "text", content: ocrResult.text });
}

async function analyzeUrl(url) {
  return callFunction(FN_SCRAPE, { url });
}

// ── Image compression ─────────────────────────────────────────────────────────
// Still compress client-side to reduce upload size, but backend handles
// larger images without the sandbox payload limits we had in the artifact.
function compressImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Image failed to load"));
    img.onload  = () => {
      const MAX = 1200; // 1200px — safe for OCR-only pass with independent 30s window
      let w = img.width || 800, h = img.height || 600;
      if (w > MAX || h > MAX) { const r = Math.min(MAX/w,MAX/h); w=Math.round(w*r); h=Math.round(h*r); }
      const c = document.createElement("canvas");
      c.width=w; c.height=h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0,0,w,h); ctx.drawImage(img,0,0,w,h);
      const url = c.toDataURL("image/jpeg", 0.80);
      const b64 = (url.split(",")[1] || "").replace(/\s/g, "");
      if (!b64 || b64.length < 200) { reject(new Error("Canvas output empty — try a screenshot")); return; }
      if (!b64.startsWith("/9j/")) { reject(new Error("Canvas not a valid JPEG — try a screenshot")); return; }
      const kb = Math.round(b64.length * 0.75 / 1024);
      // Netlify function limit is 6MB — warn if compressed image is unexpectedly large
      if (kb > 3000) { reject(new Error("Compressed image too large (" + kb + "KB). Please take a closer photo of just the menu.")); return; }
      resolve({ b64, mime: "image/jpeg", kb });
    };
    img.src = dataUrl;
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function Bar({ value, max, color }) {
  return (
    <div style={{width:"100%",height:3,background:"rgba(255,255,255,0.08)",borderRadius:2,marginTop:4}}>
      <div style={{width:Math.min((value/max)*100,100)+"%",height:"100%",background:color,borderRadius:2,transition:"width 0.5s"}}/>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,    setTab   ] = useState("image");
  const [url,    setUrl   ] = useState("");
  const [imgPrev,setImgPrev] = useState(null);
  const [imgB64, setImgB64 ] = useState(null);
  const [imgMime,setImgMime] = useState(null);
  const [text,   setText  ] = useState("");
  const [items,  setItems ] = useState([]);
  const [resto,  setResto ] = useState("");
  const [sortKey,setSortKey] = useState("calories");
  const [sortDir,setSortDir] = useState("asc");
  const [sel,    setSel   ] = useState(new Set());
  const [loading,setLoading] = useState(false);
  const [stage,  setStage ] = useState("");
  const [elapsed,setElapsed] = useState(0);
  const [err,    setErr   ] = useState(null);
  const [drag,   setDrag  ] = useState(false);
  const [partial,  setPartial ] = useState(false);
  const [resultTab,setResultTab] = useState(null);
  const [visNutrients, setVisNutrients] = useState(() => new Set(NUTRIENTS.map(n => n.key)));
  const fileRef    = useRef();
  const galleryRef = useRef();
  const timerRef   = useRef(null);

  const clearAll = () => {
    setUrl(""); setImgPrev(null); setImgB64(null); setImgMime(null);
    setText(""); setItems([]); setResto(""); setSel(new Set()); setErr(null);
    setPartial(false); setResultTab(null);
    setVisNutrients(new Set(NUTRIENTS.map(n => n.key)));
  };

  const toggleNutrient = k => setVisNutrients(prev => {
    if (prev.size === 1 && prev.has(k)) return prev;
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });

  useEffect(() => {
    if (loading) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [loading]);

  const loadFile = useCallback(f => {
    if (!f) return;
    const ok = f.type.startsWith("image/") || /\.(heic|heif|jpg|jpeg|png|webp)$/i.test(f.name || "");
    if (!ok) { setErr("Please select an image file."); return; }
    if (f.size > 25 * 1024 * 1024) { setErr("Image too large. Try a screenshot."); return; }
    setErr(null);
    const r = new FileReader();
    r.onerror = () => setErr("Could not read image file.");
    r.onload  = e => { setImgPrev(e.target.result); setImgB64(e.target.result); setImgMime(f.type || "image/jpeg"); };
    r.readAsDataURL(f);
  }, []);

  const run = async () => {
    setLoading(true); setErr(null); setItems([]); setSel(new Set());
    await new Promise(r => setTimeout(r, 50));
    try {
      let result;

      if (tab === "url") {
        if (!url.trim()) throw new Error("Please enter a restaurant name or URL.");
        // Try as URL first, fall back to restaurant name
        const looksLikeUrl = url.trim().startsWith("http");
        if (looksLikeUrl) {
          setStage("Scraping menu from website...");
          result = await analyzeUrl(url.trim());
        } else {
          setStage("Recalling menu from training data...");
          result = await analyzeRestaurant(url.trim());
        }

      } else if (tab === "image" && imgB64) {
        setStage("Compressing image...");
        const img = await compressImage(imgB64);
        if (img.kb > 5000) throw new Error("Image too large (" + img.kb + "KB). Please take a closer photo of just the menu text.");
        setStage("Reading menu image... (" + img.kb + "KB)");
        result = await analyzePhoto(img.b64, img.mime, setStage);

      } else if (tab === "text" && text.trim()) {
        setStage("Analyzing menu...");
        result = await analyzeText(text);

      } else {
        throw new Error("Please provide a restaurant name, image, or menu text.");
      }

      if (!result?.items?.length) throw new Error("No menu items found.");
      setResto(result.restaurant || "Menu");
      setItems(result.items);
      setPartial(result.partial === true);
      setResultTab(tab);

    } catch(e) {
      setErr(e.message);
    } finally {
      setLoading(false); setStage("");
    }
  };

  const visibleNuts  = NUTRIENTS.filter(n => visNutrients.has(n.key));
  const activeSortKey = visNutrients.has(sortKey) ? sortKey : "calories";
  const doSort = k => {
    if (activeSortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("asc"); }
  };
  const sorted  = [...items].sort((a,b) => ((a[activeSortKey]??0)-(b[activeSortKey]??0)) * (sortDir==="asc"?1:-1));
  const maxV    = NUTRIENTS.reduce((acc,n) => { acc[n.key]=Math.max(...items.map(i=>i[n.key]??0),1); return acc; }, {});
  const togSel  = i => setSel(p => { const n=new Set(p); n.has(i)?n.delete(i):n.add(i); return n; });
  const ordIt   = [...sel].map(i => sorted[i]).filter(Boolean);
  const totals  = ordIt.reduce((a,x) => ({
    calories:  a.calories  + (x.calories  || 0),
    fat_g:     a.fat_g     + (x.fat_g     || 0),
    sodium_mg: a.sodium_mg + (x.sodium_mg || 0),
    carbs_g:   a.carbs_g   + (x.carbs_g   || 0),
    protein_g: a.protein_g + (x.protein_g || 0),
    cal_lo:    a.cal_lo    + (x.cal_lo    || 0),
    cal_hi:    a.cal_hi    + (x.cal_hi    || 0),
  }), {calories:0,fat_g:0,sodium_mg:0,carbs_g:0,protein_g:0,cal_lo:0,cal_hi:0});

  const canRun = (tab==="url" && url.trim().length>2) || (tab==="image" && imgB64) || (tab==="text" && text.trim().length>10);

  return (<>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap');
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      body{background:#0C0C0C;color:#E8E0D5;font-family:'DM Sans',sans-serif}
      .app{min-height:100vh;padding:28px 20px;max-width:960px;margin:0 auto}
      .hdr{margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid rgba(232,168,56,.2)}
      .eye{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.25em;color:#E8A838;text-transform:uppercase;margin-bottom:8px}
      .ttl{font-family:'Playfair Display',serif;font-size:clamp(24px,5vw,40px);font-weight:700;color:#F5EDD8;line-height:1.1;letter-spacing:-.02em}
      .ttl span{color:#E8A838}
      .ver{font-family:'DM Mono',monospace;font-size:9px;color:#2A2A2A;margin-top:4px}
      .sub{margin-top:5px;font-size:13px;color:#7A7268}
      .card{background:#141414;border:1px solid #242424;border-radius:12px;padding:22px;margin-bottom:22px}
      .tabs{display:flex;gap:4px;margin-bottom:18px;background:#0C0C0C;border-radius:8px;padding:4px;width:fit-content}
      .tb{padding:7px 16px;border-radius:6px;border:none;background:transparent;color:#5A5248;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;transition:all .2s}
      .tb.on{background:#E8A838;color:#0C0C0C;font-weight:500}
      .tb:hover:not(.on){color:#E8E0D5}
      .urow{position:relative}
      .ui{width:100%;background:#0C0C0C;border:1px solid #242424;border-radius:8px;color:#E8E0D5;font-family:'DM Mono',monospace;font-size:12px;padding:11px 14px 11px 34px;outline:none;transition:border-color .2s}
      .ui:focus{border-color:rgba(232,168,56,.4)}
      .ui::placeholder{color:#3A3A3A}
      .uico{position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:13px;pointer-events:none}
      .hint{margin-top:8px;font-size:11px;color:#3A3A3A;line-height:1.6}
      .dz{border:2px dashed #2A2A2A;border-radius:10px;padding:32px 20px;text-align:center;cursor:pointer;transition:all .2s}
      .dz.ov,.dz:hover{border-color:#E8A838;background:rgba(232,168,56,.04)}
      .cam{width:100%;padding:12px;border-radius:9px;font-family:'DM Mono',monospace;font-size:12px;font-weight:500;letter-spacing:.1em;cursor:pointer;transition:all .2s;border:none;margin-bottom:8px}
      .cam.pri{background:#E8A838;color:#0C0C0C}
      .cam.pri:hover{background:#F5BA45}
      .cam.sec{background:#1E1E1E;color:#9A9290;border:1px solid #2A2A2A}
      .cam.sec:hover{border-color:#E8A838;color:#E8A838}
      .prev{width:100%;max-height:210px;object-fit:contain;border-radius:8px;border:1px solid #242424}
      .chg{margin-top:8px;padding:5px 12px;background:transparent;border:1px solid #2A2A2A;border-radius:6px;color:#5A5248;font-size:11px;font-family:'DM Mono',monospace;cursor:pointer;transition:all .2s}
      .chg:hover{border-color:#E8A838;color:#E8A838}
      textarea{width:100%;background:#0C0C0C;border:1px solid #242424;border-radius:8px;color:#E8E0D5;font-size:13px;padding:13px;resize:vertical;outline:none;min-height:140px;transition:border-color .2s;line-height:1.6}
      textarea:focus{border-color:rgba(232,168,56,.4)}
      textarea::placeholder{color:#3A3A3A}
      .btn-row{display:flex;gap:8px;margin-top:14px}
      .go{flex:1;padding:13px;background:#E8A838;color:#0C0C0C;border:none;border-radius:8px;font-family:'DM Mono',monospace;font-size:12px;font-weight:500;letter-spacing:.15em;text-transform:uppercase;cursor:pointer;transition:all .2s}
      .go:hover:not(:disabled){background:#F5BA45;transform:translateY(-1px)}
      .go:disabled{opacity:.35;cursor:not-allowed}
      .clr{padding:13px 16px;background:transparent;border:1px solid #2A2A2A;border-radius:8px;color:#5A5248;font-family:'DM Mono',monospace;font-size:11px;cursor:pointer;transition:all .2s;white-space:nowrap}
      .clr:hover{border-color:#E05C5C;color:#E05C5C}
      .spin-w{text-align:center;padding:40px;color:#5A5248}
      .spin{width:32px;height:32px;border:2px solid #2A2A2A;border-top-color:#E8A838;border-radius:50%;animation:sp .8s linear infinite;margin:0 auto 12px}
      @keyframes sp{to{transform:rotate(360deg)}}
      .stg{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase}
      .stg-t{font-family:'DM Mono',monospace;font-size:10px;color:#3A3A3A;margin-top:6px}
      .er{background:rgba(224,92,92,.07);border:1px solid rgba(224,92,92,.2);border-radius:8px;padding:12px 15px;color:#E05C5C;font-size:12px;margin-top:12px;font-family:'DM Mono',monospace;word-break:break-word;line-height:1.6}
      .rh{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
      .rn{font-family:'Playfair Display',serif;font-size:20px;color:#F5EDD8}
      .rc{font-family:'DM Mono',monospace;font-size:11px;color:#5A5248}
      .sort-sec{margin-bottom:14px}
      .nut-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:9px}
      .nut-cb{display:flex;align-items:center;cursor:pointer;user-select:none}
      .nut-cb input{display:none}
      .nut-lbl{padding:4px 11px;border-radius:20px;border:1px solid #2A2A2A;color:#5A5248;font-family:'DM Mono',monospace;font-size:10px;cursor:pointer;transition:all .2s}
      .nut-lbl.on{background:rgba(255,255,255,.03)}
      .nut-lbl:hover{border-color:#5A5248}
      .sort-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:7px}
      .sort-lbl{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.12em;color:#3A3A3A;text-transform:uppercase;margin-right:2px}
      .sbt{padding:5px 12px;border-radius:20px;border:1px solid #242424;background:transparent;color:#5A5248;font-family:'DM Mono',monospace;font-size:10px;cursor:pointer;transition:all .2s}
      .sbt.ak{border-color:var(--sc);color:var(--sc);background:rgba(255,255,255,.03)}
      .sbt:hover:not(.ak){border-color:#3A3A3A;color:#9A9290}
      .dir-row{display:flex;gap:5px;align-items:center}
      .dir-lbl{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.1em;color:#3A3A3A;text-transform:uppercase;margin-right:2px}
      .dir-btn{padding:5px 13px;border-radius:20px;border:1px solid #242424;background:transparent;color:#5A5248;font-family:'DM Mono',monospace;font-size:10px;cursor:pointer;transition:all .2s}
      .dir-btn.on{border-color:#E8A838;color:#E8A838;background:rgba(232,168,56,.06)}
      .dir-btn:hover:not(.on){border-color:#3A3A3A;color:#9A9290}
      .il{display:flex;flex-direction:column;gap:5px;margin-bottom:20px}
      .ic{background:#141414;border:1px solid #1E1E1E;border-radius:10px;padding:12px 14px;cursor:pointer;transition:all .2s;position:relative;overflow:hidden}
      .ic::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--cc,#3A3A3A);border-radius:10px 0 0 10px;opacity:.5;transition:opacity .2s}
      .ic.sk{border-color:rgba(232,168,56,.3);background:rgba(232,168,56,.05)}
      .ic.sk::before{opacity:1;background:#E8A838}
      .ic:hover{border-color:#2A2A2A}
      .it{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:9px}
      .il2{flex:1;min-width:0}
      .in{font-family:'Playfair Display',serif;font-size:14px;color:#F5EDD8;font-weight:700;line-height:1.3}
      .ir{display:flex;align-items:center;gap:7px;flex-shrink:0}
      .ip{font-family:'DM Mono',monospace;font-size:11px;color:#5A5248}
      .ict{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:10px;background:rgba(255,255,255,.04);color:var(--cc,#5A5248);border:1px solid rgba(255,255,255,.06)}
      .sr{width:17px;height:17px;border-radius:50%;border:1.5px solid #3A3A3A;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
      .sk .sr{background:#E8A838;border-color:#E8A838}
      .ck{display:none;font-size:9px;color:#0C0C0C} .sk .ck{display:block}
      .ng{display:grid;gap:6px}
      @media(max-width:560px){.ng{grid-template-columns:repeat(3,1fr)}}
      .nl{font-family:'DM Mono',monospace;font-size:9px;color:#3A3A3A;letter-spacing:.1em;text-transform:uppercase;margin-bottom:2px}
      .nv{font-family:'DM Mono',monospace;font-size:13px;color:#9A9290;line-height:1.2}
      .nv.ak{color:var(--nc)} .nu{font-size:9px;color:#4A4842;margin-left:1px}
      .rng{font-family:'DM Mono',monospace;font-size:10px;color:#6A6260;margin-top:2px;letter-spacing:.02em}
      .op{background:linear-gradient(135deg,#161410,#141414);border:1px solid rgba(232,168,56,.18);border-radius:12px;padding:18px}
      .ot{font-family:'Playfair Display',serif;font-size:15px;color:#E8A838;margin-bottom:11px;display:flex;align-items:center;gap:8px}
      .ob{background:#E8A838;color:#0C0C0C;font-family:'DM Mono',monospace;font-size:10px;padding:2px 7px;border-radius:10px;font-weight:500}
      .oil{margin-bottom:11px;display:flex;flex-direction:column;gap:3px}
      .oi{display:flex;justify-content:space-between;font-size:12px;color:#7A7268;padding:3px 0;border-bottom:1px solid #1A1A1A}
      .oin{color:#C8C0B8}
      .tg{display:grid;gap:8px;padding-top:11px;border-top:1px solid #2A2A2A}
      .tc{text-align:center} .tl{font-family:'DM Mono',monospace;font-size:9px;color:#4A4842;text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
      .tv{font-family:'DM Mono',monospace;font-size:15px;font-weight:500} .tu{font-size:9px;color:#4A4842;margin-left:1px}
      .tr{font-family:'DM Mono',monospace;font-size:9px;color:#5A5248;margin-top:2px}
      .disc{margin-top:12px;font-family:'DM Mono',monospace;font-size:9px;color:#252525;text-align:center;line-height:1.6}
      .warn{background:rgba(232,168,56,.07);border:1px solid rgba(232,168,56,.2);border-radius:8px;padding:10px 14px;color:#E8A838;font-size:11px;margin-bottom:14px;font-family:'DM Mono',monospace;line-height:1.6}
      .note{background:rgba(255,255,255,.03);border:1px solid #242424;border-radius:8px;padding:10px 14px;color:#5A5248;font-size:11px;margin-bottom:14px;font-family:'DM Mono',monospace;line-height:1.6}
    `}</style>

    <div className="app">
      <div className="hdr">
        <div className="eye">Nutrition Intelligence</div>
        <div className="ttl">Menu <span>Decoded</span></div>
        <div className="sub">Any menu — photo, restaurant name, or text — ranked by nutrition.</div>
        <div className="ver">{VERSION}</div>
      </div>

      <div className="card">
        <div className="tabs">
          <button className={"tb"+(tab==="image"?" on":"")} onClick={()=>setTab("image")}>📷 Photo</button>
          <button className={"tb"+(tab==="url"  ?" on":"")} onClick={()=>setTab("url")}>🍽 Restaurant</button>
          <button className={"tb"+(tab==="text" ?" on":"")} onClick={()=>setTab("text")}>📋 Text</button>
        </div>

        {/* ── Photo tab ── */}
        {tab==="image" && (imgPrev
          ? <div>
              <img src={imgPrev} alt="" className="prev"/>
              <button className="chg" onClick={()=>{setImgPrev(null);setImgB64(null);}}>↺ Different image</button>
            </div>
          : <div className={"dz"+(drag?" ov":"")}
              onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
              onDrop={e=>{e.preventDefault();setDrag(false);loadFile(e.dataTransfer.files[0]);}}
              onClick={e=>e.target===e.currentTarget&&galleryRef.current?.click()}>
              <input ref={fileRef}    type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>loadFile(e.target.files[0])}/>
              <input ref={galleryRef} type="file" accept="image/*"                       style={{display:"none"}} onChange={e=>loadFile(e.target.files[0])}/>
              <div style={{maxWidth:280,margin:"0 auto"}}>
                <button className="cam pri" onClick={e=>{e.stopPropagation();fileRef.current?.click();}}>📷 Take a Photo</button>
                <button className="cam sec" onClick={e=>{e.stopPropagation();galleryRef.current?.click();}}>🖼 Choose from Library</button>
              </div>
              <div style={{fontSize:11,color:"#3A3A3A",marginTop:8,fontFamily:"monospace"}}>or drag and drop</div>
            </div>
        )}

        {/* ── Restaurant tab ── */}
        {tab==="url" && <>
          <div className="urow">
            <span className="uico">🍽</span>
            <input className="ui" type="text"
              placeholder="e.g. Chipotle, Olive Garden, Chili's  or  paste a URL"
              value={url} onChange={e=>setUrl(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&canRun&&!loading&&run()}/>
          </div>
          <div className="hint">
            Type a restaurant name (uses training knowledge) or paste a URL (scrapes the live site, handles Wix and Squarespace).
          </div>
        </>}

        {/* ── Text tab ── */}
        {tab==="text" &&
          <textarea value={text} onChange={e=>setText(e.target.value)}
            placeholder={"Paste any menu text here.\n\nFor Wix/Squarespace sites: open the menu page, Cmd+A, Cmd+C, paste here.\n\nExample:\n  Grilled Salmon — lemon butter  $28\n  Caesar Salad — romaine, parmesan  $16"}/>
        }

        <div className="btn-row">
          <button className="go" disabled={!canRun||loading} onClick={run}>
            {loading ? (stage || "Working...") : "Analyze Menu →"}
          </button>
          {(canRun || items.length > 0) && (
            <button className="clr" onClick={clearAll}>✕ Clear</button>
          )}
        </div>
        {err && <div className="er">⚠ {err}</div>}
      </div>

      {loading && (
        <div className="spin-w">
          <div className="spin"/>
          <div className="stg">{stage || "Working..."}</div>
          <div className="stg-t">{elapsed}s</div>
        </div>
      )}

      {items.length > 0 && <>
        <div className="rh">
          <div className="rn">{resto}</div>
          <div className="rc">{items.length} items{partial && " · Partial"}</div>
        </div>
        {partial && (
          <div className="warn">⚠ Large menu — showing {items.length} items. For complete results use the Text tab, or photograph individual sections (e.g. Entrees only).</div>
        )}
        {!partial && resultTab === "image" && (
          <div className="note">📷 Photo results depend on image quality — showing {items.length} items. For best results photograph individual sections (e.g. Entrees only). Use Text tab for complex dishes with many sides.</div>
        )}

        <div className="sort-sec">
          <div className="nut-row">
            <span className="sort-lbl">Show</span>
            {NUTRIENTS.map(n => (
              <label key={n.key} className="nut-cb" style={{"--nc":n.color}}>
                <input type="checkbox" checked={visNutrients.has(n.key)} onChange={()=>toggleNutrient(n.key)}/>
                <span className={"nut-lbl"+(visNutrients.has(n.key)?" on":"")}
                  style={visNutrients.has(n.key)?{borderColor:n.color,color:n.color}:{}}>{n.label}</span>
              </label>
            ))}
          </div>
          <div className="sort-row">
            <span className="sort-lbl">Sort by</span>
            {visibleNuts.map(n => (
              <button key={n.key} className={"sbt"+(activeSortKey===n.key?" ak":"")} style={{"--sc":n.color}} onClick={()=>doSort(n.key)}>
                {n.label}
              </button>
            ))}
          </div>
          <div className="dir-row">
            <span className="dir-lbl">Order</span>
            <button className={"dir-btn"+(sortDir==="asc"?" on":"")}  onClick={()=>setSortDir("asc")}>↑ Lowest first</button>
            <button className={"dir-btn"+(sortDir==="desc"?" on":"")} onClick={()=>setSortDir("desc")}>↓ Highest first</button>
          </div>
        </div>

        <div className="il">
          {sorted.map((item,i) => {
            const cc = CAT_COLORS[item.category] || "#5A5248";
            const s  = sel.has(i);
            return (
              <div key={i} className={"ic"+(s?" sk":"")} style={{"--cc":cc}} onClick={()=>togSel(i)}>
                <div className="it">
                  <div className="il2"><div className="in">{item.name}</div></div>
                  <div className="ir">
                    <span className="ict">{item.category}</span>
                    {item.price && item.price!=="null" && <span className="ip">{item.price}</span>}
                    <div className="sr"><span className="ck">✓</span></div>
                  </div>
                </div>
                <div className="ng" style={{gridTemplateColumns:`repeat(${visibleNuts.length},1fr)`}}>
                  {visibleNuts.map(n => {
                    const lo=item[n.lo], hi=item[n.hi], mid=item[n.key];
                    return (
                      <div key={n.key}>
                        <div className="nl">{n.label}</div>
                        <div className={"nv"+(activeSortKey===n.key?" ak":"")} style={{"--nc":n.color}}>
                          {mid??""}<span className="nu">{mid!=null?n.unit:""}</span>
                        </div>
                        {lo!=null&&hi!=null&&(
                          <div className="rng" style={activeSortKey===n.key?{color:n.color,opacity:0.7}:{}}>{lo}–{hi}</div>
                        )}
                        <Bar value={mid??0} max={maxV[n.key]} color={n.color}/>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {sel.size > 0 && (
          <div className="op">
            <div className="ot">My Order <span className="ob">{sel.size} item{sel.size>1?"s":""}</span></div>
            <div className="oil">
              {ordIt.map((x,i) => (
                <div key={i} className="oi">
                  <span className="oin">{x.name}</span>
                  <span style={{color:"#E8A838"}}>
                    {x.cal_lo && x.cal_hi ? x.cal_lo+"–"+x.cal_hi : x.calories} kcal
                  </span>
                </div>
              ))}
            </div>
            <div className="tg" style={{gridTemplateColumns:`repeat(${visibleNuts.length},1fr)`}}>
              {visibleNuts.map(n => (
                <div key={n.key} className="tc">
                  <div className="tl">{n.label}</div>
                  <div className="tv" style={{color:n.color}}>{totals[n.key]}<span className="tu">{n.unit}</span></div>
                  {n.key==="calories" && totals.cal_lo>0 && <div className="tr">{totals.cal_lo}–{totals.cal_hi}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="disc">Ranges reflect portion uncertainty · AI estimates · Not medical advice</div>
      </>}
    </div>
  </>);
}
