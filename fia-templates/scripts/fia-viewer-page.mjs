/**
 * FIA viewer — single-page app served by fia-viewer.mjs.
 * Self-contained (no CDN, works offline). All UI components are custom-built —
 * no native selects/checkboxes. Inner script uses string concatenation only
 * (this file wraps everything in one template literal).
 */
import { MAX_FALLBACKS } from '../modules/engines.mjs';

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FIA — the IAI Agent Factory</title>
<style>
  :root {
    --bg:#07090f; --panel:#0d1119; --panel2:#101522; --line:#1b2233; --line2:#27314a;
    --text:#e7ecf5; --dim:#8a93a8; --faint:#5b6478;
    --cyan:#22d3ee; --violet:#a78bfa; --ok:#34d399; --err:#f87171; --warn:#fbbf24;
    --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; scrollbar-width:thin; scrollbar-color:var(--line2) transparent; }
  *::-webkit-scrollbar { width:9px; height:9px; }
  *::-webkit-scrollbar-thumb { background:var(--line2); border-radius:99px; border:2px solid var(--panel); }
  *::-webkit-scrollbar-track { background:transparent; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:13.5px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
         height:100vh; display:flex; flex-direction:column; overflow:hidden; }

  header { display:flex; align-items:center; gap:18px; padding:0 18px; height:52px;
           border-bottom:1px solid var(--line); background:rgba(13,17,25,.85); backdrop-filter:blur(8px); }
  .brand { display:flex; align-items:baseline; gap:9px; white-space:nowrap; }
  .brand b { font-size:16px; letter-spacing:.5px;
             background:linear-gradient(90deg,var(--cyan),var(--violet));
             -webkit-background-clip:text; background-clip:text; color:transparent; }
  .brand span { color:var(--faint); font-size:12px; }
  .crumbs { color:var(--dim); font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .crumbs b { color:var(--text); font-family:var(--mono); font-weight:500; }
  .crumbs i { color:var(--faint); font-style:normal; margin:0 7px; }
  .live { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12px; white-space:nowrap; }
  .pulse { width:8px; height:8px; border-radius:99px; background:var(--ok); box-shadow:0 0 0 0 rgba(52,211,153,.6); animation:pulse 2s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)} 70%{box-shadow:0 0 0 7px rgba(52,211,153,0)} 100%{box-shadow:0 0 0 0 rgba(52,211,153,0)} }
  .viewsw { display:flex; gap:4px; background:var(--panel2); border:1px solid var(--line); border-radius:99px; padding:3px; }
  .viewsw span { padding:3px 13px; border-radius:99px; font-size:12px; color:var(--dim); cursor:pointer; user-select:none; transition:all .12s; white-space:nowrap; }
  .viewsw span:hover { color:var(--text); }
  .viewsw span.on { color:#04070c; background:linear-gradient(90deg,var(--cyan),var(--violet)); font-weight:650; }
  .ty-user{background:rgba(52,211,153,.12); color:var(--ok)} .ty-asst{background:rgba(167,139,250,.12); color:var(--violet)}

  .app { flex:1; display:flex; min-height:0; }
  aside { width:284px; flex:0 0 284px; border-right:1px solid var(--line); display:flex; flex-direction:column; background:var(--panel); }
  .search { margin:12px 12px 8px; display:flex; align-items:center; gap:8px; background:var(--panel2);
            border:1px solid var(--line); border-radius:10px; padding:8px 11px; transition:border .15s; }
  .search:focus-within { border-color:var(--cyan); }
  .search svg { flex:0 0 14px; opacity:.5; }
  .search input { flex:1; background:none; border:none; outline:none; color:var(--text); font:inherit; }
  .search input::placeholder { color:var(--faint); }
  .list { flex:1; overflow-y:auto; padding:4px 12px 14px; display:flex; flex-direction:column; gap:8px; }
  .scard { border:1px solid var(--line); border-radius:12px; padding:10px 12px; cursor:pointer;
           background:var(--panel2); transition:border .15s, transform .1s; position:relative; }
  .scard:hover { border-color:var(--line2); }
  .scard.sel { border-color:transparent; }
  .scard.sel::before { content:''; position:absolute; inset:-1px; border-radius:12px; padding:1px;
      background:linear-gradient(135deg,var(--cyan),var(--violet));
      -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
      -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none; }
  .scard .row1 { display:flex; align-items:center; gap:8px; }
  .sdot { width:8px; height:8px; border-radius:99px; flex:0 0 8px; }
  .sdot.success{background:var(--ok)} .sdot.fail{background:var(--err)}
  .sdot.running{background:var(--warn); animation:pulse 2s infinite}
  .sdot.idle{background:var(--faint)}
  .scard .name { font-weight:600; font-size:13px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .scard .ago { color:var(--faint); font-size:11px; white-space:nowrap; }
  .scard .id { font-family:var(--mono); font-size:11px; color:var(--faint); margin-top:2px; }
  .scard .req { color:var(--dim); font-size:12px; margin-top:5px; display:-webkit-box;
                -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .scard .meta { display:flex; gap:10px; color:var(--faint); font-size:11px; margin-top:7px; flex-wrap:wrap; }
  .scard .meta .oc { color:var(--dim); font-weight:600; }
  .side-empty { color:var(--faint); text-align:center; padding:40px 20px; font-size:12.5px; }

  main { flex:1; min-width:0; display:flex; flex-direction:column; padding:14px 16px; gap:12px; overflow-y:auto; }
  .kpis { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; }
  .kpi { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:10px 14px; }
  .kpi .k { color:var(--faint); font-size:11px; text-transform:uppercase; letter-spacing:.7px; }
  .kpi .v { font-size:17px; font-weight:650; margin-top:3px; font-variant-numeric:tabular-nums; }
  .kpi .v.ok{color:var(--ok)} .kpi .v.fail{color:var(--err)} .kpi .v.running{color:var(--warn)}
  .kpi .why { color:var(--faint); font-size:11px; margin-top:4px; line-height:1.35; }
  .tokmodels { display:flex; gap:7px; flex-wrap:wrap; align-items:center; }
  .tokmodels .tm-label { color:var(--faint); font-size:11px; text-transform:uppercase; letter-spacing:.7px; }
  .tokmodels .chip b { font-family:var(--mono); font-weight:600; font-size:11px; color:var(--text); }

  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; display:flex; flex-direction:column; min-height:0; }
  .card-head { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--line); min-height:47px; }
  .card-head h2 { margin:0; font-size:13px; text-transform:uppercase; letter-spacing:.8px; color:var(--dim); font-weight:600; }
  .legend { display:flex; gap:13px; margin-left:auto; flex-wrap:wrap; }
  .legend .li { display:flex; align-items:center; gap:6px; color:var(--dim); font-size:12px; }
  .ldot { width:9px; height:9px; border-radius:3px; }

  .tl-wrap { padding:14px 16px 10px; overflow-x:auto; }
  .chart { position:relative; min-width:680px; }
  .axis { position:relative; height:22px; margin-left:150px; }
  .tick { position:absolute; top:0; color:var(--faint); font-size:10.5px; transform:translateX(-50%); font-family:var(--mono); }
  .lane { display:flex; align-items:center; height:46px; border-top:1px solid var(--line); }
  .lane-label { width:150px; flex:0 0 150px; display:flex; align-items:center; gap:8px; color:var(--dim); font-size:12.5px; }
  .track { position:relative; flex:1; height:100%; }
  .bar { position:absolute; top:9px; height:28px; border-radius:7px; display:flex; align-items:center;
         justify-content:center; font-size:11.5px; color:#04070c; font-weight:650; padding:0 9px;
         white-space:nowrap; overflow:hidden; min-width:30px; cursor:pointer; transition:filter .12s, box-shadow .12s; }
  .bar:hover { filter:brightness(1.18); }
  .bar.selbar { box-shadow:0 0 0 2px var(--bg), 0 0 0 3.5px var(--cyan); }
  .bar .dur { position:absolute; top:-15px; left:2px; color:var(--faint); font-size:10px; font-weight:400; font-family:var(--mono); }
  .bar.running { border:1.5px dashed rgba(255,255,255,.65); background:transparent !important; color:var(--text); }
  .bar.fail { outline:2px solid var(--err); outline-offset:1px; }

  .split { display:grid; grid-template-columns:5fr 7fr; gap:12px; flex:1; min-height:360px; }
  .detail-body { flex:1; overflow-y:auto; padding:14px 16px; }
  .tabs { display:flex; gap:2px; padding:0 12px; border-bottom:1px solid var(--line); }
  .tab { padding:9px 13px; color:var(--dim); font-size:12.5px; cursor:pointer; border-bottom:2px solid transparent;
         transition:color .12s; user-select:none; }
  .tab:hover { color:var(--text); }
  .tab.on { color:var(--cyan); border-bottom-color:var(--cyan); }
  .chip { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line2); border-radius:99px;
          padding:1px 9px; font-size:11px; color:var(--dim); white-space:nowrap; }
  .chip.ok{color:var(--ok);border-color:rgba(52,211,153,.35)} .chip.fail{color:var(--err);border-color:rgba(248,113,113,.35)}
  .chip.running{color:var(--warn);border-color:rgba(251,191,36,.35)}
  .chip.kind{color:var(--violet);border-color:rgba(167,139,250,.3)}
  .rows { display:flex; flex-direction:column; gap:9px; }
  .frow { display:flex; gap:12px; font-size:12.5px; }
  .frow .fk { width:105px; flex:0 0 105px; color:var(--faint); }
  .frow .fv { flex:1; min-width:0; overflow-wrap:break-word; }
  .frow .fv.mono { font-family:var(--mono); font-size:12px; }
  .toolchips { display:flex; flex-wrap:wrap; gap:5px; }
  .tchip { background:var(--panel2); border:1px solid var(--line); border-radius:7px; padding:1px 8px;
           font-family:var(--mono); font-size:11px; color:var(--dim); }
  .ctxbar { height:7px; background:var(--panel2); border-radius:99px; overflow:hidden; margin-top:5px; }
  .ctxbar i { display:block; height:100%; background:linear-gradient(90deg,var(--cyan),var(--violet)); border-radius:99px; }
  .errbox { background:rgba(248,113,113,.08); border:1px solid rgba(248,113,113,.3); color:var(--err);
            border-radius:10px; padding:10px 12px; font-size:12.5px; margin-top:12px; font-family:var(--mono); }

  .gate { border:1px solid var(--line); border-radius:11px; margin-bottom:10px; overflow:hidden; }
  .gate-head { display:flex; align-items:center; gap:9px; padding:9px 12px; background:var(--panel2); font-size:12.5px; }
  .gate-head .gname { font-weight:600; font-family:var(--mono); font-size:12px; }
  .gicon { width:16px; height:16px; border-radius:99px; display:flex; align-items:center; justify-content:center;
           font-size:10px; flex:0 0 16px; }
  .gicon.ok{background:rgba(52,211,153,.15); color:var(--ok)} .gicon.fail{background:rgba(248,113,113,.15); color:var(--err)}
  .gchecks { padding:7px 12px; display:flex; flex-direction:column; gap:5px; }
  .gcheck { display:flex; gap:8px; font-size:12px; font-family:var(--mono); }
  .gcheck .ci{flex:0 0 12px} .gcheck .ok{color:var(--ok)} .gcheck .bad{color:var(--err)}
  .gcheck .cnote { color:var(--faint); }

  .jsonbox { position:relative; background:var(--panel2); border:1px solid var(--line); border-radius:11px; padding:12px 14px; }
  pre { margin:0; font-family:var(--mono); font-size:12px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
  .jk{color:var(--violet)} .js{color:#7ee787} .jn{color:var(--cyan)} .jl{color:var(--warn)} .jp{color:var(--faint)}
  .copybtn { position:absolute; top:8px; right:8px; background:var(--panel); border:1px solid var(--line2);
             color:var(--dim); border-radius:8px; padding:3px 10px; font-size:11px; cursor:pointer; transition:all .12s; }
  .copybtn:hover { color:var(--text); border-color:var(--cyan); }
  .collap { border:1px solid var(--line); border-radius:11px; margin-bottom:10px; overflow:hidden; }
  .collap-head { display:flex; align-items:center; gap:9px; padding:9px 12px; background:var(--panel2);
                 cursor:pointer; font-size:12.5px; user-select:none; }
  .collap-head .arrow { transition:transform .15s; color:var(--faint); font-size:10px; }
  .collap.open .arrow { transform:rotate(90deg); }
  .badge { margin-left:auto; color:var(--faint); font-size:11px; font-family:var(--mono); }
  .collap-body { display:none; padding:11px 13px; max-height:270px; overflow-y:auto; }
  .collap.open .collap-body { display:block; }

  .ev-filters { display:flex; gap:5px; margin-left:auto; flex-wrap:wrap; }
  .fchip { border:1px solid var(--line2); border-radius:99px; padding:2px 11px; font-size:11.5px;
           color:var(--dim); cursor:pointer; user-select:none; transition:all .12s; }
  .fchip:hover { color:var(--text); }
  .fchip.on { color:#04070c; background:linear-gradient(90deg,var(--cyan),var(--violet)); border-color:transparent; font-weight:650; }
  .switch { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:11.5px; cursor:pointer; user-select:none; }
  .sw { width:30px; height:17px; border-radius:99px; background:var(--line2); position:relative; transition:background .15s; }
  .sw::after { content:''; position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:99px;
               background:var(--dim); transition:all .15s; }
  .switch.on .sw { background:var(--cyan); }
  .switch.on .sw::after { left:15px; background:#04070c; }

  .events { flex:1; overflow-y:auto; font-size:12px; }
  .ev { display:flex; align-items:center; gap:10px; padding:5px 16px; border-bottom:1px solid rgba(27,34,51,.5); cursor:pointer; }
  .ev:hover { background:var(--panel2); }
  .ev .t { font-family:var(--mono); color:var(--faint); font-size:11px; flex:0 0 60px; }
  .ev .ty { flex:0 0 92px; }
  .tychip { display:inline-block; border-radius:6px; padding:0 7px; font-size:10.5px; font-family:var(--mono); }
  .ty-tool{background:rgba(34,211,238,.12); color:var(--cyan)} .ty-gatep{background:rgba(52,211,153,.12); color:var(--ok)}
  .ty-gatef{background:rgba(248,113,113,.14); color:var(--err)} .ty-phase{background:rgba(167,139,250,.12); color:var(--violet)}
  .ty-log{background:rgba(138,147,168,.12); color:var(--dim)} .ty-error{background:rgba(248,113,113,.2); color:var(--err)}
  .ty-agent{background:rgba(251,191,36,.12); color:var(--warn)} .ty-other{background:var(--panel2); color:var(--faint)}
  .ev .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--mono); font-size:11.5px; }
  .ev .nm .bad { color:var(--err); }
  .ev .d { font-family:var(--mono); color:var(--faint); font-size:11px; flex:0 0 auto; }
  .ev-payload { padding:8px 16px 12px 86px; border-bottom:1px solid var(--line); background:var(--panel2); display:none; }
  .ev-payload.open { display:block; }

  .hero { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; color:var(--dim); padding:40px; text-align:center; }
  .hero .glyph { font-size:42px; background:linear-gradient(135deg,var(--cyan),var(--violet));
                 -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero code { background:var(--panel2); border:1px solid var(--line); border-radius:8px; padding:3px 10px;
               font-family:var(--mono); font-size:12px; color:var(--text); }
  .mini-empty { color:var(--faint); text-align:center; padding:34px 18px; font-size:12.5px; }

  /* ── Plan ── */
  .plantabs { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:2px 8px 0; }
  .ptable-wrap { overflow-x:auto; }
  .ptable { width:100%; border-collapse:collapse; font-size:12.5px; }
  .ptable th { text-align:left; color:var(--faint); font-weight:600; font-size:11px; text-transform:uppercase;
               letter-spacing:.6px; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  .ptable td { padding:8px 10px; border-bottom:1px solid rgba(27,34,51,.6); vertical-align:top; }
  .ptable tr[data-row]:hover { background:var(--panel2); cursor:pointer; }
  .ptable code, .md code { background:var(--panel2); border:1px solid var(--line); border-radius:6px;
                           padding:1px 6px; font-family:var(--mono); font-size:11.5px; }
  .steps { display:flex; flex-direction:column; }
  .step { display:flex; gap:11px; padding:8px 0; align-items:flex-start; }
  .stepdot { width:18px; height:18px; border-radius:99px; flex:0 0 18px; display:flex; align-items:center;
             justify-content:center; font-size:10px; background:var(--panel2); color:var(--faint);
             border:1px solid var(--line2); margin-top:1px; }
  .stepdot.done { background:rgba(52,211,153,.15); color:var(--ok); border-color:transparent; }
  .stepdot.run { background:rgba(251,191,36,.15); color:var(--warn); border-color:transparent; animation:pulse 2s infinite; }
  .stepdot.fail { background:rgba(248,113,113,.15); color:var(--err); border-color:transparent; }
  .step .sname { font-size:13px; }
  .step .smeta { color:var(--faint); font-size:11.5px; margin-top:2px; }
  .mdcb { display:inline-flex; width:14px; height:14px; border-radius:4px; margin-right:7px; border:1px solid var(--line2);
          align-items:center; justify-content:center; font-size:9px; color:var(--ok); vertical-align:-2px; flex:0 0 14px; }
  .mdcb.on { border-color:rgba(52,211,153,.5); background:rgba(52,211,153,.12); }
  .md { font-size:13px; line-height:1.62; }
  .md .mdh { margin:15px 0 7px; font-weight:650; }
  .md .mdh:first-child { margin-top:0; }
  .md .mdh1 { font-size:17px; } .md .mdh2 { font-size:15px; }
  .md .mdh3, .md .mdh4 { font-size:12.5px; color:var(--dim); text-transform:uppercase; letter-spacing:.6px; }
  .md .mdp { margin:0 0 9px; }
  .md .mdlist { margin:0 0 9px; padding-left:20px; }
  .md .mdli-sub { margin-left:14px; }
  .md .mdpre { background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:11px 13px; margin:0 0 10px; }
  .md .mdq { border-left:2px solid var(--line2); margin:0 0 10px; padding-left:12px; color:var(--dim); }
  .md .mdhr { border:0; border-top:1px solid var(--line); margin:14px 0; }
  .md .mdlink { color:var(--cyan); cursor:pointer; text-decoration:underline dotted; }
  .md a { color:var(--cyan); }
  .plan-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:10px; }

  /* ── Agents ── */
  .aeng { border:1px solid var(--line); border-radius:12px; background:var(--panel2); padding:10px 12px;
          display:flex; flex-direction:column; gap:7px; }
  .aeng .top { display:flex; align-items:center; gap:8px; }
  .aeng .nm { font-weight:650; font-size:13px; }
  .aeng .nm code { font-family:var(--mono); font-weight:500; font-size:11px; color:var(--faint); margin-left:5px; }
  .adot { width:8px; height:8px; border-radius:99px; flex:0 0 8px; }
  .adot.ok { background:var(--ok); } .adot.err { background:var(--err); } .adot.unk { background:var(--warn); }
  .aeng ul { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:2px; }
  .aeng li { display:flex; gap:7px; font-size:11.5px; color:var(--dim); align-items:baseline; }
  .aeng li b { font-family:var(--mono); font-weight:500; font-size:11px; color:var(--text); }
  .aeng li.miss b, .aeng li.miss span { color:var(--faint); }
  .aeng .fixhint { font-family:var(--mono); font-size:10.5px; color:var(--warn); background:rgba(251,191,36,.07);
                   border:1px dashed rgba(251,191,36,.3); border-radius:8px; padding:5px 8px; word-break:break-all; }
  .aside-pad { padding:4px 12px 14px; display:flex; flex-direction:column; gap:8px; overflow-y:auto; }
  .arefresh { border:1px solid var(--line); background:var(--panel2); color:var(--dim); border-radius:99px;
              padding:5px 12px; font-size:11.5px; cursor:pointer; align-self:flex-start; }
  .arefresh:hover { color:var(--text); border-color:var(--line2); }
  .agrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:12px; }
  .acard { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:13px 14px;
           display:flex; flex-direction:column; gap:10px; position:relative; }
  .acard.dirty::before { content:''; position:absolute; inset:-1px; border-radius:14px; padding:1px;
      background:linear-gradient(135deg,var(--cyan),var(--violet));
      -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
      -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none; }
  .acard .ahead { display:flex; align-items:center; gap:8px; }
  .acard .aname { font-weight:650; font-size:13.5px; }
  .acard .adotbig { width:10px; height:10px; border-radius:99px; flex:0 0 10px; }
  .acard .apurpose { color:var(--dim); font-size:12px; margin:-2px 0 0 18px; }
  .afield { display:flex; flex-direction:column; gap:4px; }
  .afield .albl { color:var(--faint); font-size:10.5px; text-transform:uppercase; letter-spacing:.9px; font-weight:600; }
  .aseg { display:inline-flex; background:var(--panel2); border:1px solid var(--line); border-radius:9px;
          padding:2px; gap:2px; align-self:flex-start; }
  .aseg span { padding:3px 10px; border-radius:7px; font-size:11.5px; color:var(--dim); cursor:pointer;
               font-family:var(--mono); user-select:none; }
  .aseg span:hover { color:var(--text); }
  .aseg span.sel { background:var(--panel); color:var(--text); box-shadow:inset 0 0 0 1px var(--line2); }
  .amodel { position:relative; }
  .amodelbtn { display:flex; align-items:center; gap:8px; width:100%; text-align:left; cursor:pointer;
               background:var(--panel2); border:1px solid var(--line); border-radius:9px; padding:6px 10px; }
  .amodelbtn:hover { border-color:var(--line2); }
  .amodelbtn .m { font-family:var(--mono); font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .amodelbtn .chev { color:var(--faint); font-size:9px; }
  .amenu { position:absolute; z-index:30; top:calc(100% + 4px); left:0; right:0; background:#141a2b;
           border:1px solid var(--line2); border-radius:11px; padding:5px; max-height:250px; overflow-y:auto;
           box-shadow:0 16px 40px -12px rgba(0,0,0,.8); }
  .amenu .g { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.9px; padding:6px 8px 2px; }
  .amenu .mi { display:flex; align-items:baseline; gap:8px; padding:5px 8px; border-radius:7px;
               font-family:var(--mono); font-size:11.5px; color:var(--text); cursor:pointer; }
  .amenu .mi:hover { background:var(--panel2); }
  .amenu .mi.locked { color:var(--faint); }
  .amenu .mi .hint { margin-left:auto; font-family:inherit; font-size:10.5px; color:var(--faint); }
  .amenu .mi.locked .hint { color:var(--warn); }
  .amenu .custom { display:flex; gap:6px; padding:6px 8px 4px; }
  .amenu .custom input { flex:1; background:var(--panel2); border:1px solid var(--line); border-radius:7px;
                         color:var(--text); font-family:var(--mono); font-size:11.5px; padding:4px 8px; outline:none; }
  .amenu .custom input:focus { border-color:var(--cyan); }
  .amenu .custom .okbtn { border:1px solid var(--line2); background:var(--panel2); color:var(--dim);
                          border-radius:7px; padding:3px 10px; font-size:11px; cursor:pointer; }
  .amenu .custom .okbtn:hover { color:var(--text); }
  .apills { display:flex; flex-wrap:wrap; gap:4px; }
  .apills span { border:1px solid var(--line); background:var(--panel2); color:var(--dim); border-radius:99px;
                 padding:2px 10px; font-size:11px; font-family:var(--mono); cursor:pointer; user-select:none; }
  .apills span:hover { color:var(--text); }
  .apills span.sel { color:#04070c; background:linear-gradient(90deg,var(--cyan),var(--violet));
                     border-color:transparent; font-weight:650; }
  .apillnote { color:var(--faint); font-size:11px; }
  .afbrow { display:flex; flex-direction:column; gap:6px; }
  .afb { display:flex; align-items:center; gap:7px; border:1px dashed var(--line2); border-radius:10px; padding:6px 8px; }
  .afb .n { color:var(--faint); font-size:10px; flex:0 0 auto; }
  .afb .amodel { flex:1; min-width:0; }
  .afb .rm { color:var(--faint); cursor:pointer; font-size:13px; padding:0 3px; }
  .afb .rm:hover { color:var(--err); }
  .afbadd { color:var(--faint); border:1px dashed var(--line2); border-radius:10px; padding:5px 10px;
            font-size:11.5px; cursor:pointer; align-self:flex-start; }
  .afbadd:hover { color:var(--text); }
  .aguard { display:flex; gap:8px; align-items:flex-start; font-size:11.5px; color:var(--warn);
            background:rgba(251,191,36,.07); border:1px solid rgba(251,191,36,.3); border-radius:9px; padding:7px 10px; }
  .asavebar { position:sticky; bottom:0; z-index:25; display:flex; align-items:center; gap:12px;
              background:rgba(16,21,34,.97); border:1px solid var(--line2); border-radius:12px; padding:10px 14px; }
  .asavebar .diff { flex:1; min-width:0; font-family:var(--mono); font-size:11px; color:var(--dim);
                    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .asavebar .diff b { color:var(--text); font-weight:500; }
  .abtn { border-radius:9px; padding:6px 14px; font-size:12px; font-weight:650; cursor:pointer; border:none; white-space:nowrap; }
  .abtn.primary { color:#04070c; background:linear-gradient(90deg,var(--cyan),var(--violet)); }
  .abtn.primary:hover { filter:brightness(1.1); }
  .abtn.primary[disabled] { opacity:.5; cursor:default; }
  .abtn.ghost { color:var(--dim); background:none; border:1px solid var(--line); }
  .abtn.ghost:hover { color:var(--text); border-color:var(--line2); }
  .amsg { font-size:12px; border-radius:10px; padding:8px 12px; }
  .amsg.ok { color:var(--ok); background:rgba(52,211,153,.08); border:1px solid rgba(52,211,153,.3); }
  .amsg.err { color:var(--err); background:rgba(248,113,113,.08); border:1px solid rgba(248,113,113,.3); }

  #tooltip { position:fixed; z-index:50; background:#161c2a; border:1px solid var(--line2); border-radius:10px;
             padding:9px 12px; font-size:12px; max-width:360px; pointer-events:none; display:none;
             box-shadow:0 8px 28px rgba(0,0,0,.5); }
  #tooltip .tt-title { font-weight:650; margin-bottom:3px; }
  #tooltip .tt-dim { color:var(--dim); }
  @media (max-width:1100px){ .split{grid-template-columns:1fr} .kpis{grid-template-columns:repeat(3,1fr)} }
</style>
</head>
<body>
<div id="tooltip"></div>
<header>
  <div class="brand"><b>◆ FIA</b><span>the IAI Agent Factory</span></div>
  <div class="crumbs" id="crumbs">sessions</div>
  <div class="viewsw" id="viewsw"><span data-v="fda" class="on">FDAs</span><span data-v="pi">Interactive Pi</span><span data-v="plan">Plan</span><span data-v="agents">Agents</span></div>
  <div class="live"><span class="pulse"></span>live</div>
</header>
<div class="app">
  <aside>
    <div class="search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="filter" placeholder="Filter runs…" spellcheck="false" />
    </div>
    <div class="list" id="list"></div>
  </aside>
  <main id="main"></main>
</div>
<script>
'use strict';
var S = {
  view: 'fda',
  sessions: [], filterText: '', selected: null, detail: null,
  phaseSel: null, tab: 'visao', events: [], lastRid: 0,
  evFilter: 'all', autoScroll: true, promptsCache: {}, openEv: {}, openCollap: { system: false, user: true },
  pi: { sessions: [], dir: '', available: false, selected: null, detail: null,
        lane: 'main', laneDetail: null, filter: 'all', autoScroll: true, openEv: {} },
  plan: { tab: 'resumo', data: null, screens: null, tasks: null, design: null, loaded: false,
          taskSel: null, taskFilter: 'all', docSel: null, docCache: {}, openCollap: {} },
  agents: { data: null, engines: null, edits: {}, open: null, saving: false, msg: null, loading: false },
};
var FALLBACK = ['#a78bfa','#22d3ee','#fbbf24','#fb7185','#e879f9','#34d399','#f97316'];
var KIND_GRAY = { engineer:'#8b96ab', code:'#64748b' };
var EV_FILTERS = [
  ['all','All'], ['tool','Tools'], ['gate','Gates'], ['phase','Phases'], ['log','Logs'], ['error','Errors'],
];

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
// Terminal-outcome labels. Mirrors LABELS in imp/modules/outcome.mjs, which the
// page cannot import (this file is a single template literal) — keep both sides
// in sync by hand. Every value here is a literal, so it is safe to interpolate.
var OUTCOME_LABELS = { goal_met:'goal met', verification_failed:'verification failed',
  attempt_cap:'attempt cap reached', no_progress:'no progress',
  budget_exhausted:'budget exhausted (time or tokens)', breadth_exceeded:'change breadth exceeded',
  blocked_by_gate:'blocked by a gate', engine_exhausted:'engines exhausted',
  stopped_by_request:'stopped by request', aborted:'aborted', failed:'failed' };
// The NAMED outcome as display text, already escaped, or '' when the trace
// carries none (older runs, and databases a new Tracer has not opened yet).
// An unrecognised value degrades exactly as outcomeLabel() does.
function outcomeText(outcome){ if(!outcome) return '';
  return OUTCOME_LABELS[outcome] || esc(String(outcome)) + ' (unknown outcome)'; }
function fmtDur(sec){ if(sec == null) return '—'; if(sec < 10) return sec.toFixed(1)+'s';
  var t = Math.round(sec);
  if(t < 60) return t+'s';
  if(t < 3600) return Math.floor(t/60)+'m '+(t%60)+'s';
  return Math.floor(t/3600)+'h '+Math.floor((t%3600)/60)+'m'; }
function fmtTime(iso){ if(!iso) return ''; var d = new Date(iso);
  return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2); }
function ago(iso){ if(!iso) return ''; var s = Math.max(0, Math.floor((Date.now()-Date.parse(iso))/1000));
  if(s < 60) return s+'s'; if(s < 3600) return Math.floor(s/60)+'min';
  if(s < 86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function fmtTokens(n){ n = n||0; if(n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if(n < 1000) return String(n);
  var k = (n/1000).toFixed(1); return k === '1000.0' ? '1.00M' : k+'k'; }
function fmtBytes(n){ n = n||0; if(n < 1024) return n+' B';
  if(n < 1048576) return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
// Roster colors come from a user-edited YAML and land inside style attributes:
// only hex (#RGB..#RRGGBBAA), a simple name or a var(--token) get through.
function safeColor(c){
  c = String(c||'').trim();
  if(/^#[0-9a-fA-F]{3,8}$/.test(c) || /^[a-zA-Z]+$/.test(c) || /^var\\(--[a-zA-Z0-9_-]+\\)$/.test(c)) return c;
  return 'var(--faint)';
}
function colorFor(owner, kind, i){
  var r = S.detail && S.detail.roster && S.detail.roster[owner];
  if(r && r.color) return safeColor(r.color);
  if(KIND_GRAY[kind]) return KIND_GRAY[kind];
  return FALLBACK[i % FALLBACK.length];
}
function niceStep(total){ var steps=[1,2,5,10,15,30,60,120,300,600,1800,3600];
  for(var i=0;i<steps.length;i++) if(total/steps[i] <= 8) return steps[i]; return 7200; }
function fmtTick(s){ if(s < 60) return s+'s';
  if(s < 3600) return s%60 ? Math.floor(s/60)+'m'+(s%60)+'s' : (s/60)+'m';
  return s%3600 ? Math.floor(s/3600)+'h'+Math.round((s%3600)/60)+'m' : (s/3600)+'h'; }
function hiJson(obj){
  var txt; try { txt = JSON.stringify(obj, null, 2); } catch(e){ txt = String(obj); }
  return esc(txt).replace(/(&quot;.*?&quot;)(\\s*:)?|\\b(true|false|null)\\b|-?\\d+\\.?\\d*/g, function(m, str, colon, lit){
    if(str) return colon ? '<span class="jk">'+str+'</span>'+colon : '<span class="js">'+str+'</span>';
    if(lit) return '<span class="jl">'+lit+'</span>';
    return '<span class="jn">'+m+'</span>';
  });
}

// ── Data ─────────────────────────────────────────────────────────────────────
function fetchJson(url){ return fetch(url).then(function(r){ return r.json(); }); }

function loadSessions(){
  return fetchJson('/api/sessions').then(function(data){
    S.sessions = data.sessions || [];
    if(!S.selected && S.sessions.length) selectSession(S.sessions[0].fda_id);
    if(S.view !== 'fda') return;
    renderSidebar();
    if(!S.sessions.length) renderEmptyMain(data.dbPath, data.db);
  });
}
function loadDetail(){
  if(!S.selected) return Promise.resolve();
  return fetchJson('/api/session?fda_id='+encodeURIComponent(S.selected)).then(function(data){
    if(data.error) return;
    S.detail = data;
    if(S.phaseSel == null && data.phases.length) S.phaseSel = data.phases[data.phases.length-1].seq;
    renderMain();
  });
}
function loadEvents(){
  if(!S.selected) return Promise.resolve();
  var sel = S.selected;
  return fetchJson('/api/events?fda_id='+encodeURIComponent(sel)+'&after='+S.lastRid).then(function(data){
    if(sel !== S.selected || !data.events) return;
    if(data.events.length){
      S.events = S.events.concat(data.events);
      if(S.events.length > 900) S.events = S.events.slice(-900);
      S.lastRid = data.last;
      renderEvents();
    }
  });
}
function selectSession(id){
  S.selected = id; S.detail = null; S.phaseSel = null; S.tab = 'visao';
  S.events = []; S.lastRid = 0; S.promptsCache = {}; S.openEv = {};
  renderSidebar();
  loadDetail().then(loadEvents);
}

// ── Sidebar ──────────────────────────────────────────────────────────────────
function renderSidebar(){
  if(S.view === 'plan'){ renderPlanSidebar(); return; }
  if(S.view === 'pi'){ renderPiSidebar(); return; }
  if(S.view === 'agents'){ renderAgentsSidebar(); return; }
  var q = S.filterText.toLowerCase();
  // The outcome slug rides the haystack too, so typing "no_progress" finds the
  // runs that stalled — the label alone would only match its English words.
  var items = S.sessions.filter(function(s){
    return !q || (s.fda_id+' '+(s.fda_name||'')+' '+(s.request||'')+' '+(s.engineer||'')+' '+
      (s.outcome||'')+' '+(s.outcome_reason||'')).toLowerCase().indexOf(q) !== -1;
  });
  var html = items.map(function(s){
    // The NAMED outcome belongs in the LIST: 20 cards that all say "fail" make
    // the student open each one to find the runs that stalled.
    var oc = outcomeText(s.outcome);
    return '<div class="scard'+(s.fda_id===S.selected?' sel':'')+'" data-id="'+esc(s.fda_id)+'"'+(s.stale?' title="abandoned (stale) — the run stopped without finishing"':'')+'>'+
      '<div class="row1"><span class="sdot '+esc(s.stale ? 'fail' : s.status)+'"></span>'+
      '<span class="name">'+esc(s.fda_name||'fda')+'</span><span class="ago">'+(s.stale?'abandoned · ':'')+ago(s.started_at)+'</span></div>'+
      '<div class="id">'+esc(s.fda_id)+'</div>'+
      '<div class="req">'+esc(s.request||'(no request)')+'</div>'+
      '<div class="meta">'+(oc ? '<span class="oc">'+oc+'</span>' : '')+
      '<span>'+esc(s.engineer||'')+'</span><span>'+fmtTokens(s.total_tokens)+' tok</span>'+
      '<span>$'+Number(s.total_cost||0).toFixed(3)+'</span></div></div>';
  }).join('');
  $('list').innerHTML = html || '<div class="side-empty">No runs'+(q?' for this filter':'')+'.</div>';
  var cards = $('list').querySelectorAll('.scard');
  for(var i=0;i<cards.length;i++) cards[i].addEventListener('click', function(){ selectSession(this.getAttribute('data-id')); });
}

// ── Main ─────────────────────────────────────────────────────────────────────
function renderEmptyMain(dbPath, dbOk){
  $('crumbs').innerHTML = 'sessions';
  var lost = dbOk === false;
  $('main').innerHTML = '<div class="hero"><div class="glyph">◆</div>'+
    '<div style="font-size:16px;font-weight:650;color:var(--text)">'+(lost ? 'Cannot see this project' : 'No runs yet')+'</div>'+
    '<div>'+(lost
      ? 'This page is not reading the project database. If you moved the folder, press <code>v</code> in the TUI to open a fresh viewer.'
      : 'Run an FDA and come back — the page refreshes on its own.')+
    '<br/>db: '+esc(dbPath||'imp/data/fia.db')+'</div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">'+
    '<code>npm run fda:quality</code><code>npm run fda:demo</code><code>pi → /task</code></div></div>';
}
function renderMain(){
  if(S.view !== 'fda') return;
  var d = S.detail; if(!d) return;
  var main = $('main');
  if(!main.querySelector('#kpis')){
    main.innerHTML = '<div class="kpis" id="kpis"></div>'+
      '<div class="tokmodels" id="tokmodels"></div>'+
      '<section class="card"><div class="card-head"><h2>Timeline</h2><div class="legend" id="legend"></div></div>'+
      '<div class="tl-wrap"><div class="chart" id="chart"></div></div></section>'+
      '<div class="split">'+
      '<section class="card"><div class="card-head" id="dhead"></div><div class="tabs" id="tabs"></div>'+
      '<div class="detail-body" id="dbody"></div></section>'+
      '<section class="card"><div class="card-head"><h2>Events</h2><div class="ev-filters" id="evf"></div>'+
      '<div class="switch" id="autosw" style="margin-left:10px"><span class="sw"></span>auto-scroll</div></div>'+
      '<div class="events" id="events"></div></section></div>';
    $('autosw').addEventListener('click', function(){ S.autoScroll = !S.autoScroll; this.classList.toggle('on', S.autoScroll); });
    $('autosw').classList.toggle('on', S.autoScroll);
  }
  renderCrumbs(); renderKpis(); renderTokModels(); renderTimeline(); renderDetail(); renderEvFilters(); renderEvents();
}
function phaseTokensMap(){
  var map = {};
  ((S.detail && S.detail.phaseTokens) || []).forEach(function(r){ map[r.phase_id] = r.tokens; });
  return map;
}
function modelForOwner(owner){
  var d = S.detail;
  var as = ((d && d.agentSessions) || []).filter(function(a){ return a.agent === owner; })[0];
  if(as && as.model) return as.model;
  var r = d && d.roster && d.roster[owner];
  return (r && r.model) || null;
}
function renderTokModels(){
  var el = $('tokmodels'); if(!el) return;
  var d = S.detail; var tok = phaseTokensMap();
  var byModel = {}; var total = 0;
  d.phases.forEach(function(p){
    var t = tok[p.phase_id]; if(!t) return;
    var model = modelForOwner(p.owner) || p.owner;
    byModel[model] = (byModel[model] || 0) + t;
    total += t;
  });
  var models = Object.keys(byModel).sort(function(a,b){ return byModel[b]-byModel[a]; });
  if(!models.length){ el.innerHTML = ''; return; }
  el.innerHTML = '<span class="tm-label">Tokens per model</span>' + models.map(function(m){
    var pct = total ? Math.round(byModel[m]/total*100) : 0;
    return '<span class="chip"><b>'+esc(m)+'</b> · '+fmtTokens(byModel[m])+' tok ('+pct+'%)</span>';
  }).join('');
}
function renderCrumbs(){
  var d = S.detail; var ph = currentPhase();
  $('crumbs').innerHTML = 'sessions<i>›</i><b>'+esc(d.session.fda_id)+'</b>'+
    (ph ? '<i>›</i><b>'+esc(ph.name)+'</b>' : '');
}
function currentPhase(){
  var d = S.detail; if(!d) return null;
  for(var i=0;i<d.phases.length;i++) if(d.phases[i].seq === S.phaseSel) return d.phases[i];
  return null;
}
function renderKpis(){
  var s = S.detail.session; var phases = S.detail.phases;
  var end = s.ended_at ? Date.parse(s.ended_at) : (s.stale && s.last_activity) ? Date.parse(s.last_activity) : Date.parse(S.detail.now);
  var dur = s.started_at ? (end - Date.parse(s.started_at))/1000 : null;
  var done = phases.filter(function(p){ return p.status==='success'; }).length;
  // A 'running' session with no recent activity was orphaned (Ctrl-C/crash).
  // A run that closed carries a NAMED terminal outcome; runs recorded before
  // outcomes existed (and databases not yet migrated) carry none, so the old
  // status/staleness derivation stays as the fallback.
  // outcomeText() mirrors LABELS in imp/modules/outcome.mjs — the page cannot
  // import it (it is one big string), so the two are kept in sync by hand.
  var label = outcomeText(s.outcome) ||
    (s.status==='success' ? 'accepted' : s.status==='fail' ? 'failed' : s.stale ? 'abandoned (stale)' : 'running');
  // The reason is a SENTENCE, not a tooltip: a title= attribute is invisible on
  // touch and to anyone scanning the KPI row, which is where it is needed.
  var why = s.outcome_reason ? '<div class="why">'+esc(s.outcome_reason)+'</div>' : '';
  $('kpis').innerHTML =
    kpi('Status', '<span class="v '+esc(s.stale ? 'fail' : s.status)+'">'+label+'</span>'+why) +
    kpi('Duration', '<span class="v">'+fmtDur(dur)+'</span>') +
    kpi('Phases', '<span class="v">'+done+'/'+phases.length+'</span>') +
    kpi('Tokens', '<span class="v">'+fmtTokens(s.total_tokens)+'</span>') +
    kpi('Cost', '<span class="v">$'+Number(s.total_cost||0).toFixed(4)+'</span>');
}
function kpi(k, v){ return '<div class="kpi"><div class="k">'+k+'</div>'+v+'</div>'; }

// ── Timeline ─────────────────────────────────────────────────────────────────
function renderTimeline(){
  var d = S.detail; var phases = d.phases;
  if(!phases.length){ $('chart').innerHTML = '<div class="mini-empty">Session has no phases.</div>'; return; }
  // An abandoned (stale) run stops growing at its last activity instead of
  // stretching the timeline to "now" forever.
  var stale = d.session && d.session.stale;
  var now = (stale && d.session.last_activity) ? Date.parse(d.session.last_activity) : Date.parse(d.now);
  var t0 = Math.min.apply(null, phases.map(function(p){ return Date.parse(p.started_at); }));
  var tEnd = Math.max.apply(null, [t0+1000].concat(phases.map(function(p){
    return p.ended_at ? Date.parse(p.ended_at) : now; })));
  var total = (tEnd - t0)/1000; var step = niceStep(total);
  function pct(ms){ return ((ms - t0)/(tEnd - t0))*100; }

  var lanes = []; phases.forEach(function(p){ if(lanes.indexOf(p.owner)===-1) lanes.push(p.owner); });
  var ticks = '';
  for(var sTick=0; sTick<=total; sTick+=step){
    ticks += '<div class="tick" style="left:'+(sTick/total*100)+'%">'+fmtTick(sTick)+'</div>';
  }
  var tokMap = phaseTokensMap();
  var rows = lanes.map(function(owner, i){
    var mine = phases.filter(function(p){ return p.owner===owner; });
    var color = colorFor(owner, mine[0].kind, i);
    var bars = mine.map(function(p){
      var start = Date.parse(p.started_at);
      var end = p.ended_at ? Date.parse(p.ended_at) : now;
      var running = !p.ended_at && !stale;
      var t = tokMap[p.phase_id];
      var cls = 'bar'+(running?' running':'')+(p.status==='fail'?' fail':'')+(p.seq===S.phaseSel?' selbar':'');
      return '<div class="'+cls+'" data-seq="'+p.seq+'" data-tt="'+esc(p.name+'|'+(p.description||'')+'|'+p.status+'|'+(t?fmtTokens(t)+' tokens':''))+'"'+
        ' style="left:'+pct(start)+'%;width:'+Math.max(pct(end)-pct(start),1.6)+'%;background:'+color+'">'+
        '<span class="dur">'+fmtDur((end-start)/1000)+(t?' · '+fmtTokens(t)+' tok':'')+(running?' · running':'')+'</span>'+esc(p.name)+'</div>';
    }).join('');
    return '<div class="lane"><div class="lane-label"><span class="ldot" style="background:'+color+'"></span>'+
      esc(owner)+'</div><div class="track">'+bars+'</div></div>';
  }).join('');
  $('chart').innerHTML = '<div class="axis">'+ticks+'</div>'+rows;
  $('legend').innerHTML = lanes.map(function(owner, i){
    var mine = phases.filter(function(p){ return p.owner===owner; });
    return '<span class="li"><span class="ldot" style="background:'+colorFor(owner, mine[0].kind, i)+'"></span>'+esc(owner)+'</span>';
  }).join('');
  var bars = $('chart').querySelectorAll('.bar');
  for(var b=0;b<bars.length;b++){
    bars[b].addEventListener('click', function(){
      S.phaseSel = Number(this.getAttribute('data-seq')); S.tab = 'visao';
      renderTimeline(); renderDetail(); renderCrumbs();
    });
    bars[b].addEventListener('mousemove', ttMove);
    bars[b].addEventListener('mouseleave', ttHide);
  }
}
function ttMove(e){
  var parts = this.getAttribute('data-tt').split('|');
  var tt = $('tooltip');
  tt.innerHTML = '<div class="tt-title">'+esc(parts[0])+'</div><div class="tt-dim">'+esc(parts[1])+'</div>'+
    '<div style="margin-top:4px"><span class="chip '+esc(parts[2])+'">'+esc(parts[2])+'</span></div>'+
    (parts[3] ? '<div class="tt-dim" style="margin-top:3px">'+esc(parts[3])+'</div>' : '');
  tt.style.display = 'block';
  var x = Math.min(e.clientX+14, window.innerWidth-380); var y = e.clientY+16;
  tt.style.left = x+'px'; tt.style.top = y+'px';
}
function ttHide(){ $('tooltip').style.display = 'none'; }

// ── Detail panel ─────────────────────────────────────────────────────────────
function renderDetail(){
  var ph = currentPhase();
  if(!ph){ $('dhead').innerHTML = '<h2>Detail</h2>'; $('tabs').innerHTML=''; 
    $('dbody').innerHTML = '<div class="mini-empty">Click a bar in the timeline.</div>'; return; }
  var end = ph.ended_at ? Date.parse(ph.ended_at) : Date.parse(S.detail.now);
  var dur = (end - Date.parse(ph.started_at))/1000;
  var st = ph.ended_at ? ph.status : 'running';
  $('dhead').innerHTML = '<h2 style="text-transform:none;font-size:14px;color:var(--text)">'+esc(ph.name)+'</h2>'+
    '<span class="chip kind">'+esc(ph.kind)+'</span><span class="chip">'+esc(ph.owner)+'</span>'+
    '<span class="chip '+esc(st)+'">'+esc(st)+'</span>'+
    '<span style="margin-left:auto;color:var(--faint);font-size:12px;font-family:var(--mono)">'+fmtDur(dur)+'</span>';
  var tabs = [['visao','Overview'],['gates','Gates'],['output','Output'],['prompts','Prompts']];
  $('tabs').innerHTML = tabs.map(function(t){
    return '<div class="tab'+(S.tab===t[0]?' on':'')+'" data-tab="'+t[0]+'">'+t[1]+'</div>';
  }).join('');
  var tabEls = $('tabs').querySelectorAll('.tab');
  for(var i=0;i<tabEls.length;i++) tabEls[i].addEventListener('click', function(){
    S.tab = this.getAttribute('data-tab'); renderDetail();
  });
  if(S.tab==='visao') renderTabVisao(ph);
  else if(S.tab==='gates') renderTabGates(ph);
  else if(S.tab==='output') renderTabOutput(ph);
  else renderTabPrompts(ph);
}
function renderTabVisao(ph){
  var d = S.detail; var r = d.roster && d.roster[ph.owner];
  var html = '<div class="rows">';
  html += frow('Description', esc(ph.description||'—'));
  var phTok = phaseTokensMap()[ph.phase_id];
  if(phTok) html += frow('Phase tokens', fmtTokens(phTok)+' tokens');
  if(ph.kind==='agent' && r){
    var engine = r.coding_agent==='claude_code' ? '⌘ Claude Code (subscription)'
      : r.coding_agent==='cursor' ? '▮ Cursor (subscription)'
      : 'π Pi — '+esc(String(r.model||'').split('/')[0]||'codex');
    html += frow('Engine', engine);
    html += frow('Model', '<span class="fv mono">'+esc(r.model)+'</span>');
    html += frow(r.coding_agent==='claude_code' ? 'Effort' : 'Thinking', esc(r.effort || r.thinking || '—'));
    if(r.purpose) html += frow('Role', esc(r.purpose));
    if(r.tools && r.tools.length) html += frow('Tools',
      '<div class="toolchips">'+r.tools.map(function(t){ return '<span class="tchip">'+esc(t)+'</span>'; }).join('')+'</div>');
    html += frow('Writes to', r.writes===null ? 'everything (except protected)' :
      (r.writes.length ? '<div class="toolchips">'+r.writes.map(function(w){ return '<span class="tchip">'+esc(w)+'</span>'; }).join('')+'</div>' : 'nothing (read-only)'));
    var as = (d.agentSessions||[]).filter(function(a){ return a.agent===ph.owner; })[0];
    if(as){
      if(as.context_window > 0){
        var pctx = Math.min(100, Math.round(as.context_tokens/as.context_window*100));
        html += frow('Context', pctx+'% ('+fmtTokens(as.context_tokens)+' / '+fmtTokens(as.context_window)+')'+
          '<div class="ctxbar"><i style="width:'+pctx+'%"></i></div>');
      } else if(as.context_tokens) {
        html += frow('Context', fmtTokens(as.context_tokens)+' tokens');
      }
      if(as.session_id) html += frow('Session', '<span class="fv mono">'+esc(String(as.session_id).slice(0,44))+'</span>');
    }
  }
  html += '</div>';
  if(ph.error) html += '<div class="errbox">'+esc(ph.error)+'</div>';
  $('dbody').innerHTML = html;
}
function frow(k, v){ return '<div class="frow"><div class="fk">'+k+'</div><div class="fv">'+v+'</div></div>'; }
function renderTabGates(ph){
  var gates = (S.detail.gates||[]).filter(function(g){ return g.phase_id===ph.phase_id; });
  if(!gates.length){ $('dbody').innerHTML = '<div class="mini-empty">No gates in this phase.</div>'; return; }
  $('dbody').innerHTML = gates.map(function(g){
    var checks = []; try { checks = JSON.parse(g.checks_json)||[]; } catch(e){}
    var rows = checks.map(function(c){
      return '<div class="gcheck"><span class="ci '+(c.ok?'ok':'bad')+'">'+(c.ok?'✓':'✗')+'</span>'+
        '<span>'+esc(c.item)+'</span><span class="cnote">'+esc(c.note||'')+'</span></div>';
    }).join('');
    return '<div class="gate"><div class="gate-head">'+
      '<span class="gicon '+(g.passed?'ok':'fail')+'">'+(g.passed?'✓':'✗')+'</span>'+
      '<span class="gname">'+esc(g.gate)+'</span>'+
      '<span class="chip">attempt '+g.attempt+'</span>'+
      '<span class="badge">'+checks.length+' checks</span></div>'+
      (rows ? '<div class="gchecks">'+rows+'</div>' : '')+'</div>';
  }).join('');
}
function renderTabOutput(ph){
  var envs = (S.detail.envelopes||[]).filter(function(e){ return e.phase_id===ph.phase_id; });
  if(!envs.length){ $('dbody').innerHTML = '<div class="mini-empty">No envelope in this phase'+
    (ph.kind!=='agent'?' ('+esc(ph.kind)+' phase)':'')+'.</div>'; return; }
  $('dbody').innerHTML = envs.map(function(e){
    var payload; try { payload = JSON.parse(e.payload_json); } catch(err){ payload = e.payload_json; }
    return '<div style="display:flex;gap:7px;align-items:center;margin-bottom:9px">'+
      '<span class="chip kind">'+esc(e.output_type)+'</span>'+
      '<span class="chip '+(e.valid?'ok':'fail')+'">'+(e.valid?'valid':'invalid')+'</span>'+
      '<span class="chip">attempt '+e.attempt+'</span></div>'+
      '<div class="jsonbox"><button class="copybtn" data-copy>copy</button><pre>'+hiJson(payload)+'</pre></div>';
  }).join('');
  var btns = $('dbody').querySelectorAll('[data-copy]');
  for(var i=0;i<btns.length;i++) btns[i].addEventListener('click', function(){
    var pre = this.parentElement.querySelector('pre');
    navigator.clipboard.writeText(pre.textContent).then(function(){});
    this.textContent = 'copied ✓'; var self = this;
    setTimeout(function(){ self.textContent = 'copy'; }, 1400);
  });
}
function renderTabPrompts(ph){
  if(ph.kind !== 'agent'){ $('dbody').innerHTML = '<div class="mini-empty">A '+esc(ph.kind)+' phase has no prompts.</div>'; return; }
  var cached = S.promptsCache[ph.owner];
  if(!cached){
    $('dbody').innerHTML = '<div class="mini-empty">Loading prompts…</div>';
    fetchJson('/api/prompts?fda_id='+encodeURIComponent(S.selected)+'&agent='+encodeURIComponent(ph.owner))
      .then(function(data){ S.promptsCache[ph.owner] = data; if(S.tab==='prompts') renderTabPrompts(ph); });
    return;
  }
  if(cached.system == null && cached.user == null){
    $('dbody').innerHTML = '<div class="mini-empty">No prompts generated for this agent yet.</div>'; return;
  }
  $('dbody').innerHTML = collap('system', 'system prompt', cached.system) + collap('user', 'user prompt', cached.user);
  var heads = $('dbody').querySelectorAll('.collap-head');
  for(var i=0;i<heads.length;i++) heads[i].addEventListener('click', function(){
    var key = this.getAttribute('data-key');
    S.openCollap[key] = !S.openCollap[key];
    this.parentElement.classList.toggle('open', S.openCollap[key]);
  });
}
function collap(key, title, content){
  if(content == null) return '';
  var lines = content.split('\\n').length;
  return '<div class="collap'+(S.openCollap[key]?' open':'')+'"><div class="collap-head" data-key="'+key+'">'+
    '<span class="arrow">▶</span><b>'+esc(title)+'</b><span class="badge">'+lines+' lines</span></div>'+
    '<div class="collap-body"><pre>'+esc(content)+'</pre></div></div>';
}

// ── Events stream ────────────────────────────────────────────────────────────
function evClass(type){
  if(type==='tool_call') return ['ty-tool','tool'];
  if(type==='gate_pass') return ['ty-gatep','gate_pass'];
  if(type==='gate_fail') return ['ty-gatef','gate_fail'];
  if(type==='phase_start'||type==='phase_end') return ['ty-phase',type];
  if(type==='error'||type==='engine_error') return ['ty-error',type];
  if(type==='engine_fallback'||type==='engine_relay') return ['ty-gatef',type];
  if(type==='engine_continuation') return ['ty-log',type];
  if(type==='agent_start'||type==='agent_end') return ['ty-agent',type];
  // The run's closing row — its name IS the terminal outcome. Styled with the
  // lifecycle family, because that is what it is: the last phase-level fact.
  if(type==='run_end') return ['ty-phase','run_end'];
  if(type==='log') return ['ty-log','log'];
  return ['ty-other',type];
}
var ENGINE_EVENTS = ['engine_error','engine_fallback','engine_relay','engine_continuation'];
function evMatches(type, name){
  var f = S.evFilter;
  if(f==='all') return true;
  if(f==='tool') return type==='tool_call';
  if(f==='gate') return type==='gate_pass'||type==='gate_fail';
  // run_end rides BOTH lifecycle and errors: it is the run's last phase-level
  // fact, and it is the first thing someone hunting a failure wants to read.
  // There is exactly one per run, so it cannot crowd either filter. Leaving it
  // out of every filter would make it reachable only under "All".
  if(f==='phase') return type==='phase_start'||type==='phase_end'||type==='run_end';
  if(f==='log') return type==='log';
  // Only a run that did NOT meet its goal belongs under Errors — putting every
  // run_end there made the filter never empty, which is the same as useless.
  if(f==='error') return type==='error'||type==='gate_fail'||(type==='run_end'&&name!=='goal_met')||ENGINE_EVENTS.indexOf(type)>=0;
  return true;
}
function renderEvFilters(){
  $('evf').innerHTML = EV_FILTERS.map(function(f){
    return '<span class="fchip'+(S.evFilter===f[0]?' on':'')+'" data-f="'+f[0]+'">'+f[1]+'</span>';
  }).join('');
  var chips = $('evf').querySelectorAll('.fchip');
  for(var i=0;i<chips.length;i++) chips[i].addEventListener('click', function(){
    S.evFilter = this.getAttribute('data-f'); renderEvFilters(); renderEvents();
  });
}
function renderEvents(){
  var box = $('events'); if(!box) return;
  var rows = S.events.filter(function(e){ return evMatches(e.type, e.name); });
  if(!rows.length){ box.innerHTML = '<div class="mini-empty">No events'+(S.evFilter!=='all'?' for this filter':'')+
    ' — they show up here in real time.</div>'; return; }
  var html = '';
  rows.slice(-400).forEach(function(e){
    var cl = evClass(e.type);
    var payload = null; try { payload = JSON.parse(e.payload_json); } catch(err){}
    var durTxt = '';
    if(e.started_at && e.ended_at){
      durTxt = fmtDur((Date.parse(e.ended_at)-Date.parse(e.started_at))/1000);
    }
    var nm = esc(e.name||'');
    if(e.type==='tool_call' && payload && payload.ok===false) nm = '<span class="bad">'+nm+' ✗</span>';
    var open = S.openEv[e.rid];
    html += '<div class="ev" data-rid="'+e.rid+'"><span class="t">'+fmtTime(e.started_at)+'</span>'+
      '<span class="ty"><span class="tychip '+cl[0]+'">'+esc(cl[1])+'</span></span>'+
      '<span class="nm">'+nm+'</span><span class="d">'+durTxt+'</span></div>'+
      '<div class="ev-payload'+(open?' open':'')+'" data-pl="'+e.rid+'">'+
      (payload!=null?'<div class="jsonbox"><pre>'+hiJson(payload)+'</pre></div>':'<span style="color:var(--faint)">no payload</span>')+
      '</div>';
  });
  var stick = S.autoScroll;
  box.innerHTML = html;
  var evEls = box.querySelectorAll('.ev');
  for(var i=0;i<evEls.length;i++) evEls[i].addEventListener('click', function(){
    var rid = this.getAttribute('data-rid');
    S.openEv[rid] = !S.openEv[rid];
    var pl = box.querySelector('[data-pl="'+rid+'"]');
    if(pl) pl.classList.toggle('open', S.openEv[rid]);
  });
  if(stick) box.scrollTop = box.scrollHeight;
}

// ── Pi (interactive session + subagents) ──────────────────────────────────────
function loadPiSessions(){
  return fetchJson('/api/pi-sessions').then(function(data){
    S.pi.sessions = data.sessions || []; S.pi.dir = data.dir || ''; S.pi.available = !!data.available;
    if(!S.pi.selected && S.pi.sessions.length) return selectPiSession(S.pi.sessions[0].id);
    if(S.view !== 'pi') return;
    renderSidebar();
    if(!S.pi.sessions.length) renderPiEmpty();
  });
}
function loadPiDetail(){
  if(!S.pi.selected) return Promise.resolve();
  var sel = S.pi.selected;
  return fetchJson('/api/pi-session?id='+encodeURIComponent(sel)).then(function(data){
    if(sel !== S.pi.selected || data.error) return;
    S.pi.detail = data;
    if(S.pi.lane !== 'main'){
      var still = (data.subruns||[]).some(function(r){ return r.path === S.pi.lane; });
      if(!still){ S.pi.lane = 'main'; S.pi.laneDetail = null; }
    }
    if(S.view === 'pi') renderPiMain();
    if(S.pi.lane !== 'main') return loadPiLane();
  });
}
function loadPiLane(){
  if(!S.pi.selected || S.pi.lane === 'main') return Promise.resolve();
  var sel = S.pi.selected, lane = S.pi.lane;
  return fetchJson('/api/pi-run?id='+encodeURIComponent(sel)+'&path='+encodeURIComponent(lane)).then(function(data){
    if(sel !== S.pi.selected || lane !== S.pi.lane || data.error) return;
    S.pi.laneDetail = data;
    if(S.view === 'pi'){ renderPiDetailPanel(); renderPiEvents(); }
  });
}
function selectPiSession(id){
  S.pi.selected = id; S.pi.detail = null; S.pi.lane = 'main'; S.pi.laneDetail = null; S.pi.openEv = {};
  renderSidebar();
  return loadPiDetail();
}
function selectPiLane(lane){
  S.pi.lane = lane; S.pi.laneDetail = null; S.pi.openEv = {};
  renderPiMain();
  if(lane !== 'main') loadPiLane();
}
function renderPiSidebar(){
  var q = S.filterText.toLowerCase();
  var items = S.pi.sessions.filter(function(s){
    return !q || (s.id+' '+(s.name||'')+' '+(s.request||'')+' '+(s.model||'')).toLowerCase().indexOf(q) !== -1;
  });
  var html = items.map(function(s){
    var st = s.state || (s.running ? 'running' : 'finished');
    return '<div class="scard'+(s.id===S.pi.selected?' sel':'')+'" data-id="'+esc(s.id)+'">'+
      '<div class="row1"><span class="sdot '+(st==='running'?'running':st==='idle'?'idle':'success')+'"></span>'+
      '<span class="name">'+esc(s.name||s.id)+'</span><span class="ago">'+ago(s.lastAt)+'</span></div>'+
      '<div class="req">'+esc(s.request||'(no message)')+'</div>'+
      '<div class="meta"><span>'+esc(s.model||'—')+'</span><span>'+s.msgCount+' msgs</span>'+
      '<span>'+s.subagents+' sub</span><span>'+fmtTokens(s.tokensOut)+' tok</span></div></div>';
  }).join('');
  $('list').innerHTML = html || '<div class="side-empty">No Pi sessions'+(q?' for this filter':'')+'.</div>';
  var cards = $('list').querySelectorAll('.scard');
  for(var i=0;i<cards.length;i++) cards[i].addEventListener('click', function(){ selectPiSession(this.getAttribute('data-id')); });
}
function renderPiEmpty(){
  $('crumbs').innerHTML = 'pi';
  $('main').removeAttribute('data-view');
  $('main').innerHTML = '<div class="hero"><div class="glyph">π</div>'+
    '<div style="font-size:16px;font-weight:650;color:var(--text)">No Pi sessions in this project</div>'+
    '<div>Open <code>pi</code> in this folder and send a message — sessions and subagents show up here live.<br/>'+
    'folder: '+esc(S.pi.dir||'~/.pi/agent/sessions')+'</div></div>';
}
function piLaneInfo(){
  var d = S.pi.detail; if(!d) return null;
  if(S.pi.lane === 'main'){
    return { label: 'session', agent: null, meta: d.meta, events: d.events, running: d.running, state: d.state, task: '' };
  }
  var run = (d.subruns||[]).filter(function(r){ return r.path === S.pi.lane; })[0];
  var ld = S.pi.laneDetail;
  if(ld) return { label: ld.agent, agent: ld.agent, meta: ld.meta, events: ld.events, running: ld.running, state: ld.state, task: run ? run.task : '' };
  if(run) return { label: run.agent, agent: run.agent, meta: null, events: [], running: run.running, state: run.state, task: run.task };
  return null;
}
function renderPiMain(){
  var d = S.pi.detail; if(!d){ renderPiEmpty(); return; }
  var main = $('main');
  if(main.getAttribute('data-view') !== 'pi'){
    main.setAttribute('data-view', 'pi');
    main.innerHTML = '<div class="kpis" id="pikpis"></div>'+
      '<section class="card"><div class="card-head"><h2>Session + subagents</h2><div class="legend" id="pilegend"></div></div>'+
      '<div class="tl-wrap"><div class="chart" id="pichart"></div></div></section>'+
      '<div class="split">'+
      '<section class="card"><div class="card-head" id="pidhead"></div><div class="detail-body" id="pidbody"></div></section>'+
      '<section class="card"><div class="card-head"><h2>Events</h2><div class="ev-filters" id="pievf"></div>'+
      '<div class="switch" id="piautosw" style="margin-left:10px"><span class="sw"></span>auto-scroll</div></div>'+
      '<div class="events" id="pievents"></div></section></div>';
    $('piautosw').addEventListener('click', function(){ S.pi.autoScroll = !S.pi.autoScroll; this.classList.toggle('on', S.pi.autoScroll); });
    $('piautosw').classList.toggle('on', S.pi.autoScroll);
  }
  renderPiCrumbs(); renderPiKpis(); renderPiTimeline(); renderPiDetailPanel(); renderPiEvFilters(); renderPiEvents();
}
function renderPiCrumbs(){
  var d = S.pi.detail; var info = piLaneInfo();
  $('crumbs').innerHTML = 'pi<i>›</i><b>'+esc((d.meta&&d.meta.name)||d.id)+'</b>'+
    (info && info.agent ? '<i>›</i><b>'+esc(info.agent)+'</b>' : '');
}
function renderPiKpis(){
  var d = S.pi.detail; var m = d.meta || {};
  var end = d.running ? Date.parse(d.now) : (m.lastAt ? Date.parse(m.lastAt) : null);
  var dur = (m.startedAt && end) ? (end - Date.parse(m.startedAt))/1000 : null;
  var subs = (d.subruns||[]).length;
  var live = d.running || (d.subruns||[]).some(function(r){ return r.running; });
  $('pikpis').innerHTML =
    kpi('Status', '<span class="v '+(live?'running':'ok')+'">'+(live?'active':'idle')+'</span>') +
    kpi('Duration', '<span class="v">'+fmtDur(dur)+'</span>') +
    kpi('Messages', '<span class="v">'+(m.msgCount||0)+'</span>') +
    kpi('Subagents', '<span class="v">'+subs+'</span>') +
    kpi('Tokens ↓', '<span class="v">'+fmtTokens(m.tokensOut)+'</span>');
}
function renderPiTimeline(){
  var d = S.pi.detail; var m = d.meta || {};
  var now = Date.parse(d.now);
  var lanes = [{ lane:'main', label:'session', start:m.startedAt, end:m.lastAt, running:d.running, color:'#22d3ee', tt:(m.name||d.id), tokens:m.tokensOut }];
  var subPalette = ['#a78bfa','#fbbf24','#fb7185','#e879f9','#34d399','#f97316'];
  (d.subruns||[]).forEach(function(r, i){
    lanes.push({ lane:r.path, label:r.agent, start:r.startedAt, end:r.lastAt, running:r.running,
      color: subPalette[i % subPalette.length], tt: r.task || r.name, tokens:r.tokensOut });
  });
  var valid = lanes.filter(function(l){ return l.start; });
  if(!valid.length){ $('pichart').innerHTML = '<div class="mini-empty">Empty session.</div>'; return; }
  var t0 = Math.min.apply(null, valid.map(function(l){ return Date.parse(l.start); }));
  var tEnd = Math.max.apply(null, [t0+1000].concat(valid.map(function(l){
    return l.running ? now : Date.parse(l.end || l.start); })));
  var total = (tEnd - t0)/1000; var step = niceStep(total);
  function pct(ms){ return ((ms - t0)/(tEnd - t0))*100; }
  var ticks = '';
  for(var sTick=0; sTick<=total; sTick+=step){
    ticks += '<div class="tick" style="left:'+(sTick/total*100)+'%">'+fmtTick(sTick)+'</div>';
  }
  var rows = valid.map(function(l){
    var start = Date.parse(l.start);
    var end = l.running ? now : Date.parse(l.end || l.start);
    var cls = 'bar'+(l.running?' running':'')+(l.lane===S.pi.lane?' selbar':'');
    var bar = '<div class="'+cls+'" data-lane="'+esc(l.lane)+'" data-tt="'+esc(l.label+'|'+(l.tt||'')+'|'+(l.running?'running':'success'))+'"'+
      ' style="left:'+pct(start)+'%;width:'+Math.max(pct(end)-pct(start),1.6)+'%;background:'+l.color+'">'+
      '<span class="dur">'+fmtDur((end-start)/1000)+(l.tokens?' · '+fmtTokens(l.tokens)+' tok':'')+(l.running?' · running':'')+'</span>'+esc(l.label)+'</div>';
    return '<div class="lane"><div class="lane-label"><span class="ldot" style="background:'+l.color+'"></span>'+
      esc(l.label)+'</div><div class="track">'+bar+'</div></div>';
  }).join('');
  $('pichart').innerHTML = '<div class="axis">'+ticks+'</div>'+rows;
  $('pilegend').innerHTML = valid.map(function(l){
    return '<span class="li"><span class="ldot" style="background:'+l.color+'"></span>'+esc(l.label)+'</span>';
  }).join('');
  var bars = $('pichart').querySelectorAll('.bar');
  for(var b=0;b<bars.length;b++){
    bars[b].addEventListener('click', function(){ selectPiLane(this.getAttribute('data-lane')); });
    bars[b].addEventListener('mousemove', ttMove);
    bars[b].addEventListener('mouseleave', ttHide);
  }
}
function renderPiDetailPanel(){
  var info = piLaneInfo();
  if(!info){ $('pidhead').innerHTML = '<h2>Detail</h2>'; $('pidbody').innerHTML = '<div class="mini-empty">Click a bar.</div>'; return; }
  // 'idle' = quiet but probably still open (the engineer is reading/typing);
  // 'finished' only after an end marker or several minutes of silence.
  var st = info.state || (info.running ? 'running' : 'finished');
  var stCls = st==='running' ? 'running' : st==='finished' ? 'success' : '';
  $('pidhead').innerHTML = '<h2 style="text-transform:none;font-size:14px;color:var(--text)">'+esc(info.label)+'</h2>'+
    (info.agent ? '<span class="chip kind">subagent</span>' : '<span class="chip kind">session</span>')+
    '<span class="chip '+stCls+'">'+esc(st)+'</span>';
  var m = info.meta;
  if(!m){ $('pidbody').innerHTML = '<div class="mini-empty">Loading…</div>'; return; }
  var html = '<div class="rows">';
  html += frow('Engine', 'π Pi — '+esc(m.provider||''));
  html += frow('Model', '<span class="fv mono">'+esc(m.model||'—')+'</span>');
  html += frow('Thinking', esc(m.thinking||'—'));
  if(info.task) html += frow('Task', esc(info.task));
  html += frow('Messages', String(m.msgCount||0));
  html += frow('Tool calls', String(m.toolCalls||0));
  html += frow('Tokens', '↑'+fmtTokens(m.tokensIn)+' · ↓'+fmtTokens(m.tokensOut));
  if(m.name) html += frow('Session', '<span class="fv mono">'+esc(m.name)+'</span>');
  html += '</div>';
  $('pidbody').innerHTML = html;
}
var PI_EV_FILTERS = [['all','All'],['tool','Tools'],['msg','Msgs'],['log','Logs'],['error','Errors']];
function piEvMatches(ev){
  var f = S.pi.filter;
  if(f==='all') return true;
  if(f==='tool') return ev.type==='tool_call';
  if(f==='msg') return ev.type==='user'||ev.type==='assistant';
  if(f==='log') return ev.type==='log';
  if(f==='error') return ev.type==='error'||(ev.type==='tool_call'&&ev.ok===false);
  return true;
}
function piEvClass(type){
  if(type==='tool_call') return ['ty-tool','tool'];
  if(type==='user') return ['ty-user','user'];
  if(type==='assistant') return ['ty-asst','assist'];
  if(type==='error') return ['ty-error','error'];
  return ['ty-log','log'];
}
function renderPiEvFilters(){
  $('pievf').innerHTML = PI_EV_FILTERS.map(function(f){
    return '<span class="fchip'+(S.pi.filter===f[0]?' on':'')+'" data-f="'+f[0]+'">'+f[1]+'</span>';
  }).join('');
  var chips = $('pievf').querySelectorAll('.fchip');
  for(var i=0;i<chips.length;i++) chips[i].addEventListener('click', function(){
    S.pi.filter = this.getAttribute('data-f'); renderPiEvFilters(); renderPiEvents();
  });
}
function renderPiEvents(){
  var box = $('pievents'); if(!box) return;
  var info = piLaneInfo();
  var rows = (info ? info.events : []).filter(piEvMatches);
  if(!rows.length){ box.innerHTML = '<div class="mini-empty">No events'+(S.pi.filter!=='all'?' for this filter':'')+'.</div>'; return; }
  var html = '';
  rows.slice(-400).forEach(function(e){
    var cl = piEvClass(e.type);
    var durTxt = '';
    if(e.started_at && e.ended_at) durTxt = fmtDur((Date.parse(e.ended_at)-Date.parse(e.started_at))/1000);
    var nm = esc(e.name||'');
    if(e.ok===false) nm = '<span class="bad">'+nm+' ✗</span>';
    var open = S.pi.openEv[e.seq];
    html += '<div class="ev" data-rid="'+e.seq+'"><span class="t">'+fmtTime(e.started_at)+'</span>'+
      '<span class="ty"><span class="tychip '+cl[0]+'">'+esc(cl[1])+'</span></span>'+
      '<span class="nm">'+nm+'</span><span class="d">'+durTxt+'</span></div>'+
      '<div class="ev-payload'+(open?' open':'')+'" data-pl="'+e.seq+'">'+
      (e.payload!=null?'<div class="jsonbox"><pre>'+esc(e.payload)+'</pre></div>':'<span style="color:var(--faint)">no payload</span>')+
      '</div>';
  });
  var stick = S.pi.autoScroll;
  box.innerHTML = html;
  var evEls = box.querySelectorAll('.ev');
  for(var i=0;i<evEls.length;i++) evEls[i].addEventListener('click', function(){
    var rid = this.getAttribute('data-rid');
    S.pi.openEv[rid] = !S.pi.openEv[rid];
    var pl = box.querySelector('[data-pl="'+rid+'"]');
    if(pl) pl.classList.toggle('open', S.pi.openEv[rid]);
  });
  if(stick) box.scrollTop = box.scrollHeight;
}

// ── Plan (/map artifacts in ai-docs/) ─────────────────────────────────
// Escape note: this whole file lives inside one template literal — never
// write a backtick (use BT) or interpolation; regexes use double escaping.
var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;
var PLAN_TABS = [['resumo','Overview'],['telas','Screens'],['tarefas','Tasks'],['design','Design System']];
var TASK_FILTERS = [['all','All'],['pending','Pending'],['blocked','Blocked'],['in-progress','In progress'],['done','Done']];

function statusLabel(st){
  return st==='done'?'done':st==='in-progress'?'in progress':st==='blocked'?'blocked':st==='deferred'?'deferred':'pending';
}

// Minimal markdown renderer. Rule: esc() ALWAYS before formatting.
function mdInline(s){
  s = s.replace(new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'), '<code>$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
  s = s.replace(/\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g, function(m, txt, href){
    if(/^(https?:|mailto:)/.test(href)) return '<a href="'+href+'" target="_blank" rel="noreferrer">'+txt+'</a>';
    return '<span class="mdlink" data-doc="'+href+'">'+txt+'</span>';
  });
  return s;
}
function mdCells(line){
  var s = line.trim();
  if(s.charAt(0) === '|') s = s.slice(1);
  if(s.charAt(s.length-1) === '|') s = s.slice(0, -1);
  return s.split('|').map(function(c){ return c.trim(); });
}
function mdIsSep(l){ return /^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)+\\|?\\s*$/.test(l||''); }
function mdIsSpecial(l, next){
  return /^#{1,6}\\s+/.test(l) || /^\\s*>\\s?/.test(l) || /^\\s*([-*+]|\\d+[.)])\\s+/.test(l) ||
    l.indexOf(FENCE) === 0 || /^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(l) ||
    (l.indexOf('|') !== -1 && mdIsSep(next));
}
function mdToHtml(md){
  if(md == null) return '';
  md = String(md);
  if(md.length > 400000) md = md.slice(0, 400000) + ' …(truncated)';
  var L = md.split('\\n'), out = [], i = 0;
  while(i < L.length){
    var l = L[i];
    if(l.indexOf(FENCE) === 0){
      var buf = []; i++;
      while(i < L.length && L[i].indexOf(FENCE) !== 0){ buf.push(L[i]); i++; }
      i++;
      out.push('<pre class="mdpre">'+esc(buf.join('\\n'))+'</pre>');
      continue;
    }
    var h = /^(#{1,6})\\s+(.*)$/.exec(l);
    if(h){ var n = Math.min(h[1].length, 4);
      out.push('<div class="mdh mdh'+n+'">'+mdInline(esc(h[2]))+'</div>'); i++; continue; }
    if(l.indexOf('|') !== -1 && mdIsSep(L[i+1])){
      var head = mdCells(l), body = []; i += 2;
      while(i < L.length && L[i].indexOf('|') !== -1 && !mdIsSep(L[i])){ body.push(mdCells(L[i])); i++; }
      var thtml = '<div class="ptable-wrap"><table class="ptable"><thead><tr>';
      for(var hh=0; hh<head.length; hh++) thtml += '<th>'+mdInline(esc(head[hh]))+'</th>';
      thtml += '</tr></thead><tbody>';
      for(var rr=0; rr<body.length; rr++){
        thtml += '<tr>';
        for(var cc=0; cc<head.length; cc++) thtml += '<td>'+mdInline(esc(body[rr][cc] == null ? '' : body[rr][cc]))+'</td>';
        thtml += '</tr>';
      }
      out.push(thtml+'</tbody></table></div>');
      continue;
    }
    if(/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(l)){ out.push('<hr class="mdhr"/>'); i++; continue; }
    if(/^\\s*>\\s?/.test(l)){
      var q = [];
      while(i < L.length && /^\\s*>\\s?/.test(L[i])){ q.push(L[i].replace(/^\\s*>\\s?/, '')); i++; }
      out.push('<blockquote class="mdq">'+mdToHtml(q.join('\\n'))+'</blockquote>');
      continue;
    }
    if(/^\\s*([-*+]|\\d+[.)])\\s+/.test(l)){
      var items = [], ordered = /^\\s*\\d+[.)]\\s+/.test(l);
      while(i < L.length && /^\\s*([-*+]|\\d+[.)])\\s+/.test(L[i])){
        var indent = (/^(\\s*)/.exec(L[i])[1] || '').length;
        var bodyTxt = L[i].replace(/^\\s*([-*+]|\\d+[.)])\\s+/, '');
        var cb = /^\\[([ xX])\\]\\s*(.*)$/.exec(bodyTxt);
        items.push('<li class="mdli'+(indent >= 2 ? ' mdli-sub' : '')+'">'+
          (cb ? '<span class="mdcb'+(cb[1] === ' ' ? '' : ' on')+'">'+(cb[1] === ' ' ? '' : '✓')+'</span>'+mdInline(esc(cb[2]))
              : mdInline(esc(bodyTxt)))+'</li>');
        i++;
      }
      out.push((ordered ? '<ol class="mdlist">' : '<ul class="mdlist">')+items.join('')+(ordered ? '</ol>' : '</ul>'));
      continue;
    }
    if(!l.trim()){ i++; continue; }
    var p = [l]; i++;
    while(i < L.length && L[i].trim() && !mdIsSpecial(L[i], L[i+1])){ p.push(L[i]); i++; }
    out.push('<div class="mdp">'+mdInline(esc(p.join(' ')))+'</div>');
  }
  return out.join('');
}

function loadPlan(){
  return Promise.all([
    fetchJson('/api/plan'),
    fetchJson('/api/plan-screens'),
    fetchJson('/api/plan-tasks'),
    fetchJson('/api/plan-design')
  ]).then(function(rs){
    S.plan.data = rs[0]; S.plan.screens = rs[1]; S.plan.tasks = rs[2]; S.plan.design = rs[3];
    S.plan.loaded = true;
    if(S.view !== 'plan') return;
    renderSidebar();
    // Do not repaint over an open document view (it would lose the scroll).
    if(S.plan.docSel){ renderPlanCrumbs(); return; }
    renderPlanMain();
  });
}
function resolveDocPath(p){
  var files = (S.plan.data && S.plan.data.files) || [];
  var known = files.some(function(f){ return f.path === p; });
  if(known || !S.plan.docSel) return p;
  var idx = S.plan.docSel.lastIndexOf('/');
  var dir = idx !== -1 ? S.plan.docSel.slice(0, idx) : '';
  var joined = dir ? dir + '/' + p : p;
  return files.some(function(f){ return f.path === joined; }) ? joined : p;
}
function openPlanDoc(path){
  S.plan.docSel = resolveDocPath(path);
  renderSidebar();
  renderPlanBody();
}
function bindDocLinks(root){
  var els = root.querySelectorAll('[data-doc]');
  for(var i=0;i<els.length;i++) els[i].addEventListener('click', function(ev){
    ev.stopPropagation();
    openPlanDoc(this.getAttribute('data-doc'));
  });
}
function renderPlanSidebar(){
  var d = S.plan.data;
  var files = (d && d.files) || [];
  var q = S.filterText.toLowerCase();
  var items = files.filter(function(f){
    return !q || (f.path+' '+(f.label||'')).toLowerCase().indexOf(q) !== -1;
  });
  var html = items.map(function(f){
    return '<div class="scard'+(f.path===S.plan.docSel?' sel':'')+'" data-doc="'+esc(f.path)+'">'+
      '<div class="row1"><span class="name">'+esc(f.label||f.path)+'</span><span class="ago">'+ago(f.updatedAt)+'</span></div>'+
      '<div class="id">'+esc(f.path)+'</div>'+
      '<div class="meta"><span>'+esc(f.kind)+'</span><span>'+fmtBytes(f.bytes)+'</span></div></div>';
  }).join('');
  $('list').innerHTML = html || '<div class="side-empty">'+
    (files.length ? 'No documents for this filter.' : 'No documents yet — run <code>/map</code> inside <code>pi</code>.')+'</div>';
  bindDocLinks($('list'));
}
function renderPlanEmpty(){
  $('crumbs').innerHTML = 'plan';
  $('main').removeAttribute('data-view');
  $('main').innerHTML = '<div class="hero"><div class="glyph">▤</div>'+
    '<div style="font-size:16px;font-weight:650;color:var(--text)">No plan yet</div>'+
    '<div>With the PRD ready, run <code>/map</code> inside <code>pi</code> — the map, screens and tasks show up here.<br/>'+
    'folder: '+esc((S.plan.data&&S.plan.data.dir)||'ai-docs')+'</div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><code>pi</code><code>/map</code></div></div>';
}
function renderPlanCrumbs(){
  var d = S.plan.data;
  var name = (d && d.project && d.project.name) || 'project';
  var extra = S.plan.docSel ? S.plan.docSel :
    (PLAN_TABS.filter(function(t){ return t[0]===S.plan.tab; })[0]||[])[1];
  $('crumbs').innerHTML = 'plan<i>›</i><b>'+esc(name)+'</b>'+(extra?'<i>›</i><b>'+esc(extra)+'</b>':'');
}
function renderPlanMain(){
  if(S.view !== 'plan') return;
  var d = S.plan.data;
  if(!d || !d.available){ renderPlanEmpty(); return; }
  var main = $('main');
  if(main.getAttribute('data-view') !== 'plan'){
    main.setAttribute('data-view', 'plan');
    main.innerHTML = '<div class="kpis" id="plkpis"></div>'+
      '<div class="tabs plantabs" id="pltabs"></div>'+
      '<div id="plbody" style="display:flex;flex-direction:column;gap:12px"></div>';
  }
  renderPlanCrumbs(); renderPlanKpis(); renderPlanTabs(); renderPlanBody();
}
function renderPlanKpis(){
  var el = $('plkpis'); if(!el) return;
  var d = S.plan.data; var c = d.counts || {};
  var sc = c.screens || {}; var tk = c.tasks || {}; var cp = c.components || {};
  var wf = d.workflow || {}; var steps = wf.steps || [];
  var wfDone = steps.filter(function(s){ return s.status==='completed'; }).length;
  var stCls = wf.status==='completed' ? 'ok' : wf.status==='failed' ? 'fail' : wf.status==='in_progress' ? 'running' : '';
  el.innerHTML =
    kpi('Screens', '<span class="v">'+(sc.implemented||0)+'/'+(sc.total||0)+'</span>') +
    kpi('Tasks', '<span class="v">'+(tk.done||0)+'/'+(tk.total||0)+'</span>') +
    kpi('Components', '<span class="v">'+(cp.total||0)+'</span>') +
    kpi('Documents', '<span class="v">'+(c.docs||0)+'</span>') +
    kpi('Map', '<span class="v '+stCls+'">'+(steps.length ? wfDone+'/'+steps.length : '—')+'</span>');
}
function renderPlanTabs(){
  var el = $('pltabs'); if(!el) return;
  var html = PLAN_TABS.map(function(t){
    return '<div class="tab'+(S.plan.tab===t[0] && !S.plan.docSel?' on':'')+'" data-tab="'+t[0]+'">'+t[1]+'</div>';
  }).join('');
  // Inbox badge: unchecked "- [ ]" ideas in ai-docs/inbox.md. No file → no badge.
  var ib = S.plan.data && S.plan.data.inbox;
  if(ib && ib.available){
    html += '<span class="badge" data-doc="inbox.md" style="cursor:pointer;align-self:center'+
      (ib.open?';color:var(--warn)':'')+'" title="unchecked ideas in ai-docs/inbox.md — /note adds, /feature and /map promote">'+
      'inbox · '+(ib.open||0)+' open</span>';
  }
  el.innerHTML = html;
  var els = el.querySelectorAll('.tab');
  for(var i=0;i<els.length;i++) els[i].addEventListener('click', function(){
    S.plan.tab = this.getAttribute('data-tab'); S.plan.docSel = null;
    renderSidebar(); renderPlanTabs(); renderPlanCrumbs(); renderPlanBody();
  });
  bindDocLinks(el);
}
function renderPlanBody(){
  var box = $('plbody'); if(!box) return;
  renderPlanTabs(); renderPlanCrumbs();
  if(S.plan.docSel){ renderPlanDocView(box); return; }
  if(S.plan.tab==='telas') renderPlanTelas(box);
  else if(S.plan.tab==='tarefas') renderPlanTarefas(box);
  else if(S.plan.tab==='design') renderPlanDesignTab(box);
  else renderPlanResumo(box);
}
function renderPlanResumo(box){
  var d = S.plan.data;
  var html = '';
  if(d.project && (d.project.name || d.project.description)){
    html += '<section class="card"><div class="card-head"><h2>Project</h2></div><div class="rows" style="padding:13px 16px">';
    if(d.project.name) html += frow('Name', esc(d.project.name));
    if(d.project.description) html += frow('Description', esc(d.project.description));
    var stk = d.stack || {}; var chips = [];
    ['framework','styling','uiLibrary','database','auth','hosting'].forEach(function(k){ if(stk[k]) chips.push(stk[k]); });
    if(chips.length) html += frow('Stack', '<div class="toolchips">'+chips.map(function(v2){
      return '<span class="tchip">'+esc(v2)+'</span>'; }).join('')+'</div>');
    html += '</div></section>';
  }
  if(d.mapError) html += '<div class="errbox">map.yaml has a syntax error: '+esc(d.mapError)+'</div>';
  // Milestones — status is shown exactly as DECLARED in milestones.md; the bar
  // is task progress, never a reason to flip the status here.
  var ms = d.milestones || {};
  if(ms.available && ms.milestones && ms.milestones.length){
    html += '<section class="card"><div class="card-head"><h2>Milestones</h2>'+
      '<span class="badge" style="cursor:pointer;color:var(--cyan)" data-doc="milestones.md">view the original document</span></div>'+
      '<div style="padding:12px 16px;display:flex;flex-direction:column;gap:15px">'+
      ms.milestones.map(function(m){
        var stCls = m.status==='done' ? 'ok' : m.status==='in-progress' ? 'running' : '';
        var pr = m.progress || { done:0, total:0 };
        var pct = pr.total ? Math.round(pr.done/pr.total*100) : 0;
        var head = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'+
          '<span style="font-weight:650">'+esc(m.id)+(m.name?' — '+esc(m.name):'')+'</span>'+
          (m.statusRaw?'<span class="chip '+stCls+'">'+esc(m.statusRaw)+'</span>':'')+
          (pr.total?'<span style="margin-left:auto;color:var(--dim);font-size:12px">'+pr.done+' of '+pr.total+' tasks done</span>':'')+'</div>';
        var goal = m.goal ? '<div style="color:var(--dim);font-size:12.5px;margin-top:3px">'+esc(m.goal)+'</div>' : '';
        var bar = pr.total ? '<div class="ctxbar" style="margin-top:7px"><i style="width:'+pct+'%"></i></div>' : '';
        var chips = (m.tasks && m.tasks.length) ? '<div class="toolchips" style="margin-top:7px">'+
          m.tasks.map(function(r){
            if(!r.known) return '<span class="tchip" style="opacity:.55" title="not found in the task index">'+esc(r.num)+' ?</span>';
            return '<span class="tchip" data-mtask="'+esc(r.num)+'" style="cursor:pointer'+(r.status==='done'?';color:var(--ok)':'')+'"'+
              ' title="'+esc(r.title||'')+'">'+esc(r.num)+(r.status==='done'?' ✓':r.status==='in-progress'?' ●':'')+'</span>';
          }).join('')+'</div>' : '';
        var dw = (m.doneWhen && m.doneWhen.length) ?
          '<div style="color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;margin-top:8px">Done when</div>'+
          m.doneWhen.map(function(w){ return '<div style="padding:1px 0;font-size:12.5px">• '+esc(w)+'</div>'; }).join('') : '';
        return '<div>'+head+goal+bar+chips+dw+'</div>';
      }).join('')+'</div></section>';
  } else if(ms.available){
    html += '<section class="card"><div class="card-head"><h2>Milestones</h2></div>'+
      '<div class="mini-empty">Nothing recognized in <span class="mdlink" data-doc="milestones.md">milestones.md</span> yet.</div></section>';
  }
  // Specs — the durable spec files under ai-docs/specs/. No dir or no specs → quiet skip.
  var sp = d.specs || {};
  if(sp.available && sp.specs && sp.specs.length){
    html += '<section class="card"><div class="card-head"><h2>Specs</h2>'+
      '<span class="badge">'+sp.specs.length+' spec'+(sp.specs.length===1?'':'s')+'</span></div>'+
      '<div class="ptable-wrap" style="padding:4px 8px 10px"><table class="ptable"><thead><tr>'+
      '<th>Spec</th><th>Title</th><th>Status</th><th>Tasks</th><th>Gate log</th></tr></thead><tbody>'+
      sp.specs.map(function(s2){
        var stCls = s2.status==='done'?'ok':s2.status==='in-progress'?'running':s2.status==='defined'?'kind':'';
        var gl = (s2.gateLog||[]).map(function(g){ return esc(g); }).join('<br/>');
        return '<tr><td><span class="mdlink" style="font-family:var(--mono)" data-doc="'+esc(s2.file)+'">'+esc(s2.id)+'</span></td>'+
          '<td>'+esc(s2.title||'—')+'</td>'+
          '<td><span class="chip '+stCls+'">'+esc(s2.statusRaw||s2.status)+'</span></td>'+
          '<td style="font-family:var(--mono);font-size:11.5px">'+esc((s2.tasks||[]).join(', ')||'—')+'</td>'+
          '<td style="font-family:var(--mono);font-size:11px;color:var(--dim)">'+(gl||'—')+'</td></tr>';
      }).join('')+'</tbody></table></div></section>';
  }
  // Example library — the shelf of external references under ai-docs/examples/.
  // An empty shelf is a NORMAL state (never a gate): the card then just says
  // where /example files them. The license chip carries the copy guardrail.
  var ex = d.examples || {};
  if(ex.available && ex.examples && ex.examples.length){
    html += '<section class="card"><div class="card-head"><h2>Example library</h2>'+
      '<span class="badge">'+ex.examples.length+' example'+(ex.examples.length===1?'':'s')+'</span></div>'+
      '<div style="padding:2px 16px 4px;color:var(--faint);font-size:11.5px">References consulted before inventing a shape '+
      '(<span class="mdlink" data-doc="examples/registry.md">examples/registry.md</span>) — they teach the approach; code is only '+
      'copied verbatim when the license allows it and the attribution is added.</div>'+
      '<div class="ptable-wrap" style="padding:4px 8px 10px"><table class="ptable"><thead><tr>'+
      '<th>Example</th><th>Kind</th><th>Tags</th><th>What to take</th><th>License</th></tr></thead><tbody>'+
      ex.examples.map(function(e){
        var lowUrl = (e.source||'').toLowerCase(); // user file content — only http(s) schemes
        var safeUrl = (lowUrl.indexOf('http://')===0 || lowUrl.indexOf('https://')===0) ? e.source : null;
        var name = e.file ? '<span class="mdlink" data-doc="'+esc(e.file)+'">'+esc(e.name)+'</span>' : esc(e.name);
        var lic = e.licenseRisk==='restricted' ?
          '<span class="chip running" title="GPL family or license not stated — read and reimplement, never paste">'+
            esc(e.license||'unknown')+' ⚠</span>' :
          (e.license ? '<span class="chip">'+esc(e.license)+'</span>' : '—');
        return '<tr'+(e.status==='archived'?' style="opacity:.5"':'')+'><td>'+name+
          (safeUrl?' <a href="'+esc(safeUrl)+'" target="_blank" rel="noreferrer" style="color:var(--cyan);text-decoration:none">↗</a>':'')+'</td>'+
          '<td>'+(e.kind?'<span class="chip kind">'+esc(e.kind)+'</span>':'—')+
          (e.status!=='referenced'?' <span class="chip">'+esc(e.status)+'</span>':'')+'</td>'+
          '<td><div class="toolchips">'+(e.tags||[]).map(function(tg){
            return '<span class="tchip">'+esc(tg)+'</span>'; }).join('')+'</div></td>'+
          '<td style="color:var(--dim)">'+esc(e.take||'')+'</td>'+
          '<td>'+lic+'</td></tr>';
      }).join('')+'</tbody></table></div></section>';
  } else if(ex.available){
    html += '<section class="card"><div class="card-head"><h2>Example library</h2></div>'+
      '<div class="mini-empty">Nothing on the shelf yet — <code>/example &lt;url&gt;</code> reads the source and files it in '+
      '<span class="mdlink" data-doc="examples/registry.md">examples/registry.md</span>.</div></section>';
  }
  var steps = (d.workflow && d.workflow.steps) || [];
  html += '<section class="card"><div class="card-head"><h2>What has already run</h2></div><div class="steps" style="padding:9px 16px">';
  if(!steps.length) html += '<div class="mini-empty">No progress recorded in map.yaml yet.</div>';
  steps.forEach(function(s){
    var ic = s.status==='completed' ? ['done','✓'] : s.status==='in_progress' ? ['run','●'] :
             s.status==='failed' ? ['fail','✗'] : s.status==='skipped' ? ['','⊘'] : ['','○'];
    html += '<div class="step"><span class="stepdot '+ic[0]+'">'+ic[1]+'</span><div style="flex:1;min-width:0">'+
      '<div class="sname">'+esc(s.name)+(s.completedAt?' <span style="color:var(--faint);font-size:11px">· '+ago(s.completedAt)+'</span>':'')+'</div>'+
      (s.details && s.details.length ? '<div class="smeta"><div class="toolchips" style="margin-top:3px">'+
        s.details.map(function(dd){ return '<span class="tchip">'+esc(dd)+'</span>'; }).join('')+'</div></div>' : '')+
      '</div></div>';
  });
  html += '</div></section>';
  html += '<section class="card"><div class="card-head"><h2>Next step</h2></div><div style="padding:13px 16px">';
  if(d.next){
    html += '<div style="font-size:14px;font-weight:650">Task '+esc(d.next.num)+' — '+esc(d.next.title)+'</div>'+
      '<div style="display:flex;gap:6px;margin-top:7px;flex-wrap:wrap">'+
      (d.next.priority?'<span class="chip">priority '+esc(d.next.priority)+'</span>':'')+
      (d.next.complexity?'<span class="chip">complexity '+esc(d.next.complexity)+'</span>':'')+
      (d.next.milestone?'<span class="chip kind">'+esc(d.next.milestone)+'</span>':'')+'</div>'+
      '<div style="margin-top:10px;color:var(--dim)">To execute: open <code>pi</code> and type '+
      '<code>/task</code> (one task) or <code>/goal</code> (all of them, to the end).</div>';
  } else if(S.plan.tasks && S.plan.tasks.counts && S.plan.tasks.counts.total){
    var tc = S.plan.tasks.counts;
    if(tc.done >= tc.total) html += '<div style="color:var(--ok)">All '+tc.total+' tasks are done. 🎉</div>';
    else html += '<div class="mini-empty">No task is unblocked right now — check the blockers in the Tasks tab.</div>';
  } else {
    html += '<div class="mini-empty">No tasks yet — run <code>/map</code> inside <code>pi</code>.</div>';
  }
  html += '</div></section>';
  var files = d.files || [];
  html += '<section class="card"><div class="card-head"><h2>Generated files</h2><span class="badge">'+files.length+' files</span></div>'+
    '<div class="plan-grid" style="padding:12px 16px">'+
    (files.length ? files.map(function(f){
      return '<div class="scard" data-doc="'+esc(f.path)+'"><div class="row1"><span class="name">'+esc(f.label||f.path)+'</span></div>'+
        '<div class="id">'+esc(f.path)+'</div>'+
        '<div class="meta"><span>'+fmtBytes(f.bytes)+'</span><span>'+ago(f.updatedAt)+'</span></div></div>';
    }).join('') : '<div class="mini-empty">Nothing generated yet.</div>')+'</div></section>';
  box.innerHTML = html;
  var mchips = box.querySelectorAll('[data-mtask]');
  for(var mi=0;mi<mchips.length;mi++) mchips[mi].addEventListener('click', function(){
    S.plan.tab = 'tarefas'; S.plan.taskSel = this.getAttribute('data-mtask');
    renderPlanBody();
  });
  bindDocLinks(box);
}
function renderPlanTelas(box){
  var s = S.plan.screens;
  if(!s){ box.innerHTML = '<div class="mini-empty">Loading…</div>'; return; }
  if(!s.available){
    box.innerHTML = '<section class="card"><div class="mini-empty">No ai-docs/screens-routes.md yet — run <code>/map</code>.</div></section>';
    return;
  }
  var c = s.counts || {};
  var html = '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">'+
    kpi('Screens', '<span class="v">'+(c.total||0)+'</span>')+
    kpi('Implemented', '<span class="v ok">'+(c.implemented||0)+'</span>')+
    kpi('Partial', '<span class="v running">'+(c.partial||0)+'</span>')+
    kpi('To implement', '<span class="v">'+(c.todo||0)+'</span>')+'</div>';
  if(s.screens && s.screens.length){
    html += '<section class="card"><div class="card-head"><h2>Screens and routes</h2>'+
      '<span class="badge" style="cursor:pointer;color:var(--cyan)" data-doc="screens-routes.md">view the original document</span></div>'+
      '<div class="ptable-wrap" style="padding:4px 8px 10px"><table class="ptable"><thead><tr>'+
      '<th>Route</th><th>Screen</th><th>File</th><th>Auth</th><th>Status</th></tr></thead><tbody>'+
      s.screens.map(function(r, i){
        var st = r.status==='implemented' ? ['ok','✅ implemented'] : r.status==='partial' ? ['running','🔄 partial'] : ['','⏳ to do'];
        return '<tr data-row="'+i+'"><td><code>'+esc(r.route)+'</code></td><td>'+esc(r.component||'—')+'</td>'+
          '<td style="font-family:var(--mono);font-size:11.5px;color:var(--dim)">'+esc(r.file||'—')+'</td>'+
          '<td>'+esc(r.auth||'—')+'</td><td><span class="chip '+st[0]+'">'+st[1]+'</span></td></tr>'+
          (r.sectionId ? '<tr data-detail="'+i+'" style="display:none"><td colspan="5"><div class="md" data-md-section="'+esc(r.sectionId)+'"></div></td></tr>' : '');
      }).join('')+'</tbody></table></div></section>';
  }
  if(s.fallbackMarkdown){
    html += '<section class="card"><div class="card-head"><h2>screens-routes.md</h2></div>'+
      '<div class="md" style="padding:13px 16px">'+mdToHtml(s.fallbackMarkdown)+'</div></section>';
  }
  box.innerHTML = html;
  var rows = box.querySelectorAll('tr[data-row]');
  for(var i=0;i<rows.length;i++) rows[i].addEventListener('click', function(){
    var idx = this.getAttribute('data-row');
    var det = box.querySelector('tr[data-detail="'+idx+'"]');
    if(!det) return;
    var show = det.style.display === 'none';
    det.style.display = show ? '' : 'none';
    if(show){
      var md = det.querySelector('[data-md-section]');
      if(md && !md.innerHTML){
        var secId = md.getAttribute('data-md-section');
        var sec = (s.sections||[]).filter(function(x){ return x.id===secId; })[0];
        if(sec) md.innerHTML = mdToHtml(sec.markdown);
      }
    }
  });
  bindDocLinks(box);
}
function renderPlanTarefas(box){
  var t = S.plan.tasks;
  if(!t){ box.innerHTML = '<div class="mini-empty">Loading…</div>'; return; }
  if(!t.available || !t.tasks.length){
    box.innerHTML = '<section class="card"><div class="mini-empty">No tasks yet — run <code>/map</code> inside <code>pi</code>.</div></section>';
    return;
  }
  var c = t.counts;
  var pctDone = c.total ? Math.round(c.done/c.total*100) : 0;
  var filtered = t.tasks.filter(function(x){ return S.plan.taskFilter==='all' || x.status===S.plan.taskFilter; });
  if(S.plan.taskSel == null || !t.tasks.some(function(x){ return x.num===S.plan.taskSel; }))
    S.plan.taskSel = t.next || (t.tasks[0] && t.tasks[0].num);
  var sel = t.tasks.filter(function(x){ return x.num===S.plan.taskSel; })[0];

  var html = '<section class="card"><div class="card-head"><h2>Progress</h2>'+
    '<div class="ev-filters" id="pltf">'+TASK_FILTERS.map(function(f){
      return '<span class="fchip'+(S.plan.taskFilter===f[0]?' on':'')+'" data-f="'+f[0]+'">'+f[1]+'</span>';
    }).join('')+'</div></div>'+
    '<div style="padding:12px 16px"><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--dim)">'+
    '<span>'+c.done+' of '+c.total+' tasks done</span><span>'+pctDone+'%</span></div>'+
    '<div class="ctxbar"><i style="width:'+pctDone+'%"></i></div></div></section>';
  html += '<div class="split" style="min-height:300px">'+
    '<section class="card"><div class="card-head"><h2>Tasks</h2><span class="badge">'+filtered.length+'</span></div>'+
    '<div style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:520px">'+
    (filtered.length ? filtered.map(function(x){
      var dotCls = x.status==='done' ? 'success' : x.status==='in-progress' ? 'running' : x.status==='blocked' ? 'fail' : '';
      return '<div class="scard'+(x.num===S.plan.taskSel?' sel':'')+'" data-task="'+esc(x.num)+'">'+
        '<div class="row1"><span class="sdot '+dotCls+'"'+(dotCls?'':' style="background:var(--line2)"')+'></span>'+
        '<span class="name">'+esc(x.num)+' — '+esc(x.title)+'</span></div>'+
        '<div class="meta"><span>'+esc(statusLabel(x.status))+'</span>'+
        (x.milestone?'<span>'+esc(x.milestone)+'</span>':'')+
        (x.blockedBy.length?'<span>depends on: '+esc(x.blockedBy.join(', '))+'</span>':'')+'</div></div>';
    }).join('') : '<div class="mini-empty">No tasks in this filter.</div>')+'</div></section>'+
    '<section class="card"><div class="card-head" id="pltdh"></div><div class="detail-body" id="pltdb"></div></section></div>';
  box.innerHTML = html;
  fillTaskDetail(sel);
  var chips = box.querySelectorAll('#pltf .fchip');
  for(var i=0;i<chips.length;i++) chips[i].addEventListener('click', function(){
    S.plan.taskFilter = this.getAttribute('data-f'); renderPlanBody();
  });
  var cards = box.querySelectorAll('[data-task]');
  for(var j=0;j<cards.length;j++) cards[j].addEventListener('click', function(){
    S.plan.taskSel = this.getAttribute('data-task'); renderPlanBody();
  });
}
function planSection(title, md){
  return '<div style="margin-top:13px"><div class="card-head" style="padding:0 0 7px;border:none;min-height:0"><h2>'+esc(title)+'</h2></div>'+
    '<div class="md">'+mdToHtml(md)+'</div></div>';
}
function fillTaskDetail(x){
  var dh = $('pltdh'); var db = $('pltdb');
  if(!dh || !db) return;
  if(!x){ dh.innerHTML = '<h2>Detail</h2>'; db.innerHTML = '<div class="mini-empty">Click a task.</div>'; return; }
  var stCls = x.status==='done'?'ok':x.status==='in-progress'?'running':x.status==='blocked'?'fail':'';
  dh.innerHTML = '<h2 style="text-transform:none;font-size:14px;color:var(--text)">'+esc(x.num)+' — '+esc(x.title)+'</h2>'+
    '<span class="chip '+stCls+'">'+esc(statusLabel(x.status))+'</span>'+
    (x.priority?'<span class="chip">'+esc(x.priority)+'</span>':'')+
    (x.complexity?'<span class="chip">complexity '+esc(x.complexity)+'</span>':'');
  var html = '';
  if(x.statusMismatch) html += '<div class="errbox" style="margin:0 0 11px">⚠ The index (task-master.md) says "'+esc(x.indexStatus)+
    '", but the task file says "'+esc(statusLabel(x.status))+'". Worth checking.</div>';
  html += '<div class="rows">';
  if(x.milestone) html += frow('Milestone', esc(x.milestone));
  if(x.blockedBy.length) html += frow('Depends on', '<div class="toolchips">'+x.blockedBy.map(function(b){
    return '<span class="tchip" data-task-link="'+esc(b)+'" style="cursor:pointer">'+esc(b)+'</span>'; }).join('')+'</div>');
  if(x.blocks.length) html += frow('Unblocks', '<div class="toolchips">'+x.blocks.map(function(b){
    return '<span class="tchip" data-task-link="'+esc(b)+'" style="cursor:pointer">'+esc(b)+'</span>'; }).join('')+'</div>');
  if(x.file) html += frow('File', '<span class="fv mono mdlink" data-doc="'+esc(x.file)+'">'+esc(x.file)+'</span>');
  html += '</div>';
  if(x.delivers) html += planSection('What it delivers', x.delivers);
  if(x.scope) html += planSection('Scope', x.scope);
  if(x.criteria && x.criteria.length){
    html += '<div style="margin-top:13px"><div class="card-head" style="padding:0 0 7px;border:none;min-height:0"><h2>Acceptance criteria</h2></div>'+
      x.criteria.map(function(cr){
        return '<div style="padding:2px 0">'+
          '<span class="mdcb'+(cr.done?' on':'')+'">'+(cr.done?'✓':'')+'</span>'+esc(cr.text)+'</div>';
      }).join('')+'</div>';
  }
  if(x.seams) html += planSection('Seams to test', x.seams);
  db.innerHTML = html;
  var links = db.querySelectorAll('[data-task-link]');
  for(var i=0;i<links.length;i++) links[i].addEventListener('click', function(){
    S.plan.taskSel = this.getAttribute('data-task-link'); renderPlanBody();
  });
  bindDocLinks(db);
}
// Registry vocabulary is EN canonical (installed/planned/default/alternative)
// but older registries still carry the pt-BR words — accept BOTH and compare
// on the normalized EN value.
function normRegWord(v){
  var t = String(v||'').trim().toLowerCase();
  if(t==='instalado'||t==='installed') return 'installed';
  if(t==='planejado'||t==='planned'||t==='a instalar') return 'planned';
  if(t==='padrão'||t==='padrao'||t==='default') return 'default';
  if(t==='alternativa'||t==='alternative') return 'alternative';
  return t;
}
function renderPlanDesignTab(box){
  var d = S.plan.design;
  if(!d){ box.innerHTML = '<div class="mini-empty">Loading…</div>'; return; }
  var ds = d.designSystem || {};
  var html = '<section class="card"><div class="card-head"><h2>Design System</h2></div><div class="rows" style="padding:13px 16px">';
  html += frow('Library', ds.library ? esc(ds.library) : '—');
  if(ds.themeConfig) html += frow('Theme', '<span class="fv mono">'+esc(ds.themeConfig)+'</span>');
  if(ds.globalStyles) html += frow('Global styles', '<span class="fv mono">'+esc(ds.globalStyles)+'</span>');
  html += '</div>';
  if(d.uiPage && d.uiPage.exists){
    html += '<div style="padding:0 16px 14px"><a href="http://localhost:3000'+esc(d.uiPage.route)+'" target="_blank" rel="noreferrer" '+
      'style="display:inline-block;padding:7px 14px;border-radius:9px;background:linear-gradient(90deg,var(--cyan),var(--violet));'+
      'color:#04070c;font-weight:650;text-decoration:none;font-size:12.5px">open the live page '+esc(d.uiPage.route)+' ↗</a>'+
      '<span style="color:var(--faint);font-size:11.5px;margin-left:9px">needs the app running (npm run dev)</span></div>';
  } else {
    html += '<div style="padding:0 16px 14px;color:var(--faint);font-size:12px">The live components page ('+
      esc((d.uiPage&&d.uiPage.route)||'/ui-components')+') does not exist yet — it is born in /map (Pi), in the Claude Code /start (step 6) or in the first /component.</div>';
  }
  html += '</section>';
  if(d.registry && d.registry.exists && d.registry.entries.length){
    html += '<section class="card"><div class="card-head"><h2>Component registry</h2>'+
      '<span class="badge">'+d.registry.entries.length+' in the registry</span></div>'+
      '<div style="padding:2px 16px 4px;color:var(--faint);font-size:11.5px">Source of truth for the design system '+
      '(<span class="mdlink" data-doc="components/registry.md">components/registry.md</span>) — tasks only use components from here.</div>'+
      '<div class="ptable-wrap" style="padding:4px 8px 10px"><table class="ptable"><thead><tr>'+
      '<th>Component</th><th>Category</th><th>File</th><th>Status</th><th>When to use</th></tr></thead><tbody>'+
      d.registry.entries.map(function(e){
        var lowUrl = (e.url||'').toLowerCase(); // user file content — only http(s) schemes
        var safeUrl = (lowUrl.indexOf('http://')===0 || lowUrl.indexOf('https://')===0) ? e.url : null;
        var st = normRegWord(e.status); var role = normRegWord(e.papel);
        return '<tr><td>'+esc(e.name)+(safeUrl?' <a href="'+esc(safeUrl)+'" target="_blank" rel="noreferrer" style="color:var(--cyan);text-decoration:none">↗</a>':'')+'</td>'+
          '<td>'+esc(e.category||'—')+'</td>'+
          '<td style="font-family:var(--mono);font-size:11px">'+esc(e.file||'—')+'</td>'+
          '<td>'+(st?'<span class="chip '+(st==='installed'?'ok':'')+'">'+esc(st)+'</span>':'—')+
          (role?' <span class="chip'+(role==='default'?' ok':'')+'">'+esc(role)+'</span>':'')+'</td>'+
          '<td style="color:var(--dim)">'+esc(e.when||'')+'</td></tr>';
      }).join('')+'</tbody></table></div></section>';
  }
  if(d.categories && d.categories.length){
    html += '<section class="card"><div class="card-head"><h2>Reusable components</h2>'+
      '<span class="badge">'+d.counts.total+' components</span></div><div style="padding:11px 13px">'+
      d.categories.map(function(cat, ci){
        var key = 'cat'+ci;
        var items = cat.items.map(function(it){
          return '<div class="frow" style="align-items:center"><div class="fk" style="width:150px;flex-basis:150px">'+esc(it.name||'—')+'</div>'+
            '<div class="fv"><div class="toolchips">'+
            (it.status?'<span class="chip '+(it.status==='installed'?'ok':'')+'">'+esc(it.status)+'</span>':'')+
            (it.path?'<span class="tchip">'+esc(it.path)+'</span>':'')+
            it.variants.map(function(v2){ return '<span class="tchip">'+esc(v2)+'</span>'; }).join('')+
            it.sizes.map(function(v2){ return '<span class="tchip">'+esc(v2)+'</span>'; }).join('')+
            it.features.map(function(v2){ return '<span class="tchip">'+esc(v2)+'</span>'; }).join('')+
            '</div></div></div>';
        }).join('');
        return '<div class="collap'+(S.plan.openCollap[key]?' open':'')+'"><div class="collap-head" data-ckey="'+key+'">'+
          '<span class="arrow">▶</span><b>'+esc(cat.label)+'</b><span class="badge">'+cat.items.length+'</span></div>'+
          '<div class="collap-body"><div class="rows">'+items+'</div></div></div>';
      }).join('')+'</div></section>';
  }
  if(d.libraries && d.libraries.length){
    html += '<section class="card"><div class="card-head"><h2>Project libraries</h2></div>'+
      '<div class="ptable-wrap" style="padding:4px 8px 10px"><table class="ptable"><thead><tr>'+
      '<th>Use</th><th>Package</th><th>Status</th><th>Description</th></tr></thead><tbody>'+
      d.libraries.map(function(l){
        return '<tr><td>'+esc(l.key)+'</td><td style="font-family:var(--mono);font-size:11.5px">'+esc(l.library||'—')+'</td>'+
          '<td>'+(l.status?'<span class="chip '+(l.status==='installed'?'ok':'')+'">'+esc(l.status)+'</span>':'—')+'</td>'+
          '<td style="color:var(--dim)">'+esc(l.description||'')+'</td></tr>';
      }).join('')+'</tbody></table></div></section>';
  }
  if(d.docs && (d.docs.idealComponents.exists || (d.docs.libraries||[]).length)){
    html += '<section class="card"><div class="card-head"><h2>Component docs</h2></div><div class="rows" style="padding:11px 16px">';
    if(d.docs.idealComponents.exists)
      html += frow('Ideal', '<span class="mdlink" data-doc="components/ideal-components.md">components/ideal-components.md</span>');
    (d.docs.libraries||[]).forEach(function(l){
      html += frow(esc(l.name), l.files+' file'+(l.files===1?'':'s')+' in ai-docs/components/'+esc(l.name)+'/');
    });
    html += '</div></section>';
  }
  box.innerHTML = html;
  var heads = box.querySelectorAll('[data-ckey]');
  for(var i=0;i<heads.length;i++) heads[i].addEventListener('click', function(){
    var k = this.getAttribute('data-ckey');
    S.plan.openCollap[k] = !S.plan.openCollap[k];
    this.parentElement.classList.toggle('open', S.plan.openCollap[k]);
  });
  bindDocLinks(box);
}
function renderPlanDocView(box){
  var path = S.plan.docSel;
  var doc = S.plan.docCache[path];
  if(!doc){
    box.innerHTML = '<div class="mini-empty">Loading '+esc(path)+'…</div>';
    fetchJson('/api/plan-doc?path='+encodeURIComponent(path)).then(function(d){
      S.plan.docCache[path] = d;
      if(S.view==='plan' && S.plan.docSel===path) renderPlanBody();
    });
    return;
  }
  box.innerHTML = '<section class="card"><div class="card-head">'+
    '<span class="badge" style="margin:0;cursor:pointer;color:var(--cyan)" id="plback">← back</span>'+
    '<h2 style="text-transform:none;font-family:var(--mono)">'+esc(path)+'</h2>'+
    '<span class="badge">'+fmtBytes(doc.bytes)+(doc.updatedAt?' · '+ago(doc.updatedAt):'')+'</span></div>'+
    '<div class="detail-body" style="max-height:none">'+
    (!doc.exists ? '<div class="mini-empty">File no longer exists.</div>' :
      doc.kind==='md' ? '<div class="md">'+mdToHtml(doc.text)+'</div>' :
      '<div class="jsonbox"><button class="copybtn" data-copy>copy</button><pre>'+esc(doc.text)+'</pre></div>')+
    (doc.truncated?'<div class="mini-empty">(file truncated for display)</div>':'')+
    '</div></section>';
  $('plback').addEventListener('click', function(){ S.plan.docSel = null; renderSidebar(); renderPlanBody(); });
  var btns = box.querySelectorAll('[data-copy]');
  for(var i=0;i<btns.length;i++) btns[i].addEventListener('click', function(){
    var pre = this.parentElement.querySelector('pre');
    navigator.clipboard.writeText(pre.textContent).then(function(){});
    this.textContent = 'copied ✓'; var self = this;
    setTimeout(function(){ self.textContent = 'copy'; }, 1400);
  });
  bindDocLinks(box);
}

// ── Agents view ──────────────────────────────────────────────────────────────
var AG_EFFORTS = ['low','medium','high','xhigh','max','ultracode'];
var AG_THINKING = ['minimal','low','medium','high'];
var AG_DEFAULT_MODEL = { claude_code:'opus', pi:'openai-codex/gpt-5.6-sol', cursor:'sonnet-4.5-thinking' };
var AG_DEFAULT_LEVEL = { claude_code:'high', pi:'medium', cursor:'' };
var FDA_MAP = [
  { fda:'fda_sdlc', via:'/task · /goal · /bug', phases:[['request',''],['plan','planner'],['build','builder'],['test',''],['review','reviewer'],['commit',''],['document','documenter']] },
  { fda:'fda_plan_build_test', via:'build with test/fix loop', phases:[['request',''],['plan','planner'],['build','builder'],['test_n',''],['fix_n','builder'],['commit','']] },
  { fda:'fda_plan', via:'plan only', phases:[['request',''],['plan','planner']] },
  { fda:'fda_build', via:'build only', phases:[['request',''],['build','builder']] },
  { fda:'fda_scout', via:'recon — changes nothing', phases:[['request',''],['scout','scout']] },
  { fda:'fda_quality', via:'/launch · npm run fda:quality', phases:[['request',''],['quality','']] },
  { fda:'fda_document', via:'docs only', phases:[['request',''],['document','documenter']] },
  { fda:'fda_prompt', via:'npm run fda:demo — any agent', phases:[['request',''],['prompt','*']] },
];

function agStored(name){
  var d = S.agents.data;
  var list = (d && d.roster && d.roster.agents) || [];
  for(var i=0;i<list.length;i++) if(list[i].name === name) return list[i];
  return null;
}
function agInitEdits(){
  var d = S.agents.data; if(!d) return;
  (d.roster.agents || []).forEach(function(a){
    if(S.agents.edits[a.name]) return;
    S.agents.edits[a.name] = {
      coding_agent: a.coding_agent, model: a.model,
      level: a.coding_agent === 'claude_code' ? (a.effort || 'high') : a.coding_agent === 'pi' ? (a.thinking || 'medium') : '',
      fallbacks: (a.fallbacks || []).map(function(fb){
        return { coding_agent: fb.coding_agent, model: fb.model,
                 level: fb.coding_agent === 'claude_code' ? (fb.effort || '') : fb.coding_agent === 'pi' ? (fb.thinking || '') : '' };
      }),
    };
  });
}
function agDirty(name){
  var a = agStored(name); var e = S.agents.edits[name];
  if(!a || !e) return [];
  var out = [];
  if(e.coding_agent !== a.coding_agent) out.push('engine ' + a.coding_agent + ' → ' + e.coding_agent);
  if(e.model !== a.model) out.push('model ' + a.model + ' → ' + e.model);
  var storedLevel = a.coding_agent === 'claude_code' ? (a.effort || 'high') : a.coding_agent === 'pi' ? (a.thinking || 'medium') : '';
  if(e.coding_agent === a.coding_agent && e.level !== storedLevel) out.push('reasoning ' + storedLevel + ' → ' + e.level);
  var sf = JSON.stringify((a.fallbacks || []).map(function(fb){ return [fb.coding_agent, fb.model, fb.effort || fb.thinking || '']; }));
  var ef = JSON.stringify((e.fallbacks || []).map(function(fb){ return [fb.coding_agent, fb.model, fb.level || '']; }));
  if(sf !== ef) out.push('fallbacks changed');
  return out;
}
function agDirtyNames(){
  var d = S.agents.data; if(!d) return [];
  return (d.roster.agents || []).map(function(a){ return a.name; }).filter(function(n){ return agDirty(n).length; });
}
function agProviderReady(provider){
  var eng = S.agents.engines && S.agents.engines.engines;
  return Boolean(eng && eng.pi && eng.pi.providers && eng.pi.providers[provider]);
}
function agProviderHint(provider){
  var E = S.agents.engines || {};
  var envKey = (E.piEnvKeys || {})[provider];
  return envKey ? ('set ' + envKey) : ('pi → /login ' + provider);
}
function agModelGroups(engine){
  var E = S.agents.engines || {};
  var eng = E.engines || {};
  if(engine === 'claude_code'){
    var locked = !(eng.claude_code && eng.claude_code.installed);
    return [{ g:'Claude plan (subscription)', items:['sonnet','opus','haiku','fable'].map(function(m){
      return { id:m, locked:locked, hint: locked ? 'install claude' : '' }; }) }];
  }
  if(engine === 'cursor'){
    var installed = eng.cursor && eng.cursor.installed;
    var ms = E.cursorModels && E.cursorModels.length ? E.cursorModels : ['sonnet-4.5','sonnet-4.5-thinking','gpt-5','composer-1'];
    return [{ g: E.cursorModels ? 'cursor-agent --list-models' : 'examples — confirm with cursor-agent --list-models',
      items: ms.map(function(m){ return { id:m, locked:!installed, hint: installed ? '' : 'install cursor-agent' }; }) }];
  }
  // pi: curated ids + every pi model already present in the config, grouped by provider
  var ids = ['openai-codex/gpt-5.6-sol','openai-codex/gpt-5.6','github-copilot/gpt-5.6','openrouter/moonshotai/kimi-k3','xai/grok-4.5'];
  var d = S.agents.data;
  ((d && d.roster && d.roster.agents) || []).forEach(function(a){
    var all = [{ coding_agent:a.coding_agent, model:a.model }].concat(a.fallbacks || []);
    all.forEach(function(x){ if(x.coding_agent === 'pi' && x.model && ids.indexOf(x.model) === -1) ids.push(x.model); });
  });
  var byProv = {};
  ids.forEach(function(id){
    var i = id.indexOf('/'); var prov = i === -1 ? '?' : id.slice(0, i);
    (byProv[prov] = byProv[prov] || []).push(id);
  });
  return Object.keys(byProv).sort().map(function(prov){
    var ready = agProviderReady(prov);
    return { g: prov + (ready ? ' — ready' : ' — ' + agProviderHint(prov)),
      items: byProv[prov].map(function(id){ return { id:id, locked:!ready, hint: ready ? '' : '🔒' }; }) };
  });
}
function agEngineIssueFor(edit){
  var E = S.agents.engines; if(!E) return null;
  var eng = E.engines || {};
  if(edit.coding_agent === 'claude_code' && eng.claude_code && !eng.claude_code.installed) return 'claude CLI is not installed';
  if(edit.coding_agent === 'cursor' && eng.cursor && !eng.cursor.installed) return 'cursor-agent is not installed';
  if(edit.coding_agent === 'pi'){
    if(eng.pi && !eng.pi.installed) return 'pi is not installed';
    var i = edit.model.indexOf('/');
    var prov = i === -1 ? null : edit.model.slice(0, i);
    if(prov && !agProviderReady(prov)) return 'provider "' + prov + '" has no login/key — ' + agProviderHint(prov);
  }
  return null;
}

function loadAgents(force){
  if(S.agents.loading) return;
  S.agents.loading = true;
  var wantRoster = force || !S.agents.data;
  var jobs = [fetchJson('/api/engines')];
  if(wantRoster) jobs.push(fetchJson('/api/roster'));
  Promise.all(jobs).then(function(rs){
    S.agents.loading = false;
    S.agents.engines = rs[0];
    if(wantRoster && rs[1] && !rs[1].error){ S.agents.data = rs[1]; agInitEdits(); }
    if(S.view === 'agents'){ renderSidebar(); renderAgentsMain(); }
  }).catch(function(){ S.agents.loading = false; });
}
function loadAgentsStatus(){
  fetchJson('/api/engines').then(function(d){
    S.agents.engines = d;
    if(S.view === 'agents'){ renderAgentsSidebar(); renderAgentsSaveBar(); }
  });
}

function renderAgentsSidebar(){
  var E = S.agents.engines;
  var html = '<div class="aside-pad">';
  if(!E){ html += '<div class="side-empty">Checking engines…</div></div>'; $('list').innerHTML = html; return; }
  var eng = E.engines || {};
  var cc = eng.claude_code || {}; var pi = eng.pi || {}; var cu = eng.cursor || {};
  var ccDot = cc.installed ? (cc.logged === false ? 'err' : 'ok') : 'err';
  html += '<div class="aeng"><div class="top"><span class="adot ' + ccDot + '"></span><span class="nm">Claude<code>claude</code></span></div><ul>' +
    (cc.installed
      ? '<li><span>✓</span><span>installed' + (cc.logged === true ? ' · logged in' : cc.logged === null ? ' · login state: run <b>claude</b> to confirm' : '') + '</span></li>' +
        '<li><span>·</span><span>models: <b>sonnet · opus · haiku · fable</b></span></li>'
      : '<li class="miss"><span>✗</span><span>not found on PATH</span></li>') +
    '</ul>' + (cc.installed ? '' : '<div class="fixhint">npm install -g @anthropic-ai/claude-code</div>') + '</div>';
  var provs = pi.providers || {};
  var provNames = Object.keys(provs).sort(function(a,b){ return (provs[b]?1:0)-(provs[a]?1:0) || (a<b?-1:1); });
  html += '<div class="aeng"><div class="top"><span class="adot ' + (pi.installed ? 'ok' : 'err') + '"></span><span class="nm">Pi<code>pi</code></span></div><ul>' +
    (pi.installed
      ? provNames.slice(0, 7).map(function(p){
          return '<li' + (provs[p] ? '' : ' class="miss"') + '><span>' + (provs[p] ? '✓' : '✗') + '</span><b>' + esc(p) + '</b><span>' +
            (provs[p] ? '' : '— ' + esc(agProviderHint(p))) + '</span></li>';
        }).join('')
      : '<li class="miss"><span>✗</span><span>not found on PATH</span></li>') +
    '</ul>' + (pi.installed ? '' : '<div class="fixhint">npm install -g @earendil-works/pi-coding-agent</div>') + '</div>';
  html += '<div class="aeng"><div class="top"><span class="adot ' + (cu.installed ? 'unk' : 'err') + '"></span><span class="nm">Cursor<code>cursor-agent</code></span></div><ul>' +
    (cu.installed
      ? '<li><span>✓</span><span>installed · login: <b>cursor-agent status</b></span></li>'
      : '<li class="miss"><span>✗</span><span>not found on PATH</span></li>') +
    '</ul>' + (cu.installed ? '' : '<div class="fixhint">curl https://cursor.com/install -fsS | bash</div>') + '</div>';
  html += '<span class="arefresh" id="aengrefresh">↻ check again</span>';
  html += '</div>';
  $('list').innerHTML = html;
  var rb = $('aengrefresh');
  if(rb) rb.addEventListener('click', function(){ loadAgents(true); });
}

function agPickerHtml(name, slot, edit){
  var id = name + '_' + slot;
  var open = S.agents.open && S.agents.open.id === id;
  var html = '<div class="amodel" data-picker="' + esc(id) + '">' +
    '<div class="amodelbtn" data-mbtn="' + esc(id) + '"><span class="m">' + esc(edit.model) + '</span><span class="chev">▼</span></div>';
  if(open){
    html += '<div class="amenu">';
    agModelGroups(edit.coding_agent).forEach(function(group){
      html += '<div class="g">' + esc(group.g) + '</div>';
      group.items.forEach(function(it){
        html += '<div class="mi' + (it.locked ? ' locked' : '') + '" data-mpick="' + esc(id) + '" data-model="' + esc(it.id) + '">' +
          esc(it.id) + (it.hint ? '<span class="hint">' + esc(it.hint) + '</span>' : '') + '</div>';
      });
    });
    html += '<div class="g">custom</div><div class="custom"><input data-mcustom="' + esc(id) + '" placeholder="' +
      (edit.coding_agent === 'pi' ? 'provider/model-id' : 'model id') + '" /><span class="okbtn" data-mcustomok="' + esc(id) + '">set</span></div>';
    html += '</div>';
  }
  return html + '</div>';
}
function agSegHtml(name, slot, edit){
  var id = name + '_' + slot;
  return '<div class="aseg">' + ['claude_code','pi','cursor'].map(function(engv){
    var label = engv === 'claude_code' ? 'claude' : engv;
    return '<span data-seg="' + esc(id) + '" data-eng="' + engv + '"' + (edit.coding_agent === engv ? ' class="sel"' : '') + '>' + label + '</span>';
  }).join('') + '</div>';
}
function agLevelHtml(name, slot, edit){
  var id = name + '_' + slot;
  if(edit.coding_agent === 'cursor') return '<span class="apillnote">on Cursor, reasoning lives in the model id (…-thinking)</span>';
  var levels = edit.coding_agent === 'claude_code' ? AG_EFFORTS : AG_THINKING;
  return '<div class="apills">' + levels.map(function(lv){
    return '<span data-lvl="' + esc(id) + '" data-v="' + lv + '"' + (edit.level === lv ? ' class="sel"' : '') + '>' + lv + '</span>';
  }).join('') + '</div>';
}

function renderAgentsMap(){
  var d = S.agents.data;
  var colorOf = {};
  ((d && d.merged) ? Object.keys(d.merged) : []).forEach(function(n){ colorOf[n] = d.merged[n].color; });
  return '<section class="card"><div class="card-head"><h2>Commands → phases → agents</h2>' +
    '<span class="badge">each phase has one owner; the owner decides engine + model</span></div>' +
    '<div class="ptable-wrap" style="padding:4px 8px 10px"><table class="ptable"><thead><tr><th>FDA</th><th>Phases and owners</th></tr></thead><tbody>' +
    FDA_MAP.map(function(row){
      var chips = row.phases.map(function(ph){
        var phase = ph[0]; var owner = ph[1];
        if(!owner) return '<span class="chip">' + esc(phase) + '</span>';
        if(owner === '*') return '<span class="chip kind">' + esc(phase) + ' · --agent</span>';
        var col = safeColor(colorOf[owner]);
        return '<span class="chip" style="color:var(--text)"><span class="ldot" style="width:7px;height:7px;border-radius:99px;background:' + esc(col) + '"></span>' +
          esc(phase) + ' · ' + esc(owner) + '</span>';
      }).join('<span style="color:var(--faint);font-size:10px"> → </span>');
      return '<tr><td style="white-space:nowrap"><div style="font-family:var(--mono);font-size:11.5px">' + esc(row.fda) + '</div>' +
        '<div style="color:var(--faint);font-size:11px;margin-top:2px">' + esc(row.via) + '</div></td>' +
        '<td><div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">' + chips + '</div></td></tr>';
    }).join('') + '</tbody></table></div></section>';
}

function renderAgentsSaveBar(){
  var bar = $('asavebar'); if(!bar) return;
  var dirty = agDirtyNames();
  if(!dirty.length){ bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  var running = (S.agents.engines && S.agents.engines.running) || 0;
  var parts = [];
  dirty.forEach(function(n){ agDirty(n).forEach(function(c){ parts.push('<b>' + esc(n) + '</b>: ' + esc(c)); }); });
  bar.querySelector('.diff').innerHTML = parts.length + ' change' + (parts.length === 1 ? '' : 's') + ' — ' + parts.join(' · ');
  var save = bar.querySelector('[data-asave]');
  if(running > 0){ save.setAttribute('disabled',''); save.textContent = 'FDA running — save locked'; }
  else { save.removeAttribute('disabled'); save.textContent = S.agents.saving ? 'Saving…' : 'Save to fia.config.yaml'; }
}

function renderAgentsMain(){
  if(S.view !== 'agents') return;
  var main = $('main');
  var d = S.agents.data;
  $('crumbs').innerHTML = d ? 'agent roster · <b>' + esc(d.configPath || 'imp/fia.config.yaml') + '</b>' : 'agent roster';
  if(!d){
    main.innerHTML = '<div class="hero"><div class="glyph">⚙</div><div>Loading the roster…</div></div>';
    return;
  }
  var html = renderAgentsMap();
  if(S.agents.msg) html += '<div class="amsg ' + (S.agents.msg.kind === 'ok' ? 'ok' : 'err') + '">' + esc(S.agents.msg.text) + '</div>';
  html += '<div class="agrid">';
  (d.roster.agents || []).forEach(function(a){
    var e = S.agents.edits[a.name]; if(!e) return;
    var dirty = agDirty(a.name).length > 0;
    var issue = agEngineIssueFor(e);
    var extraUsage = e.coding_agent === 'pi' && e.model.indexOf('anthropic/') === 0;
    html += '<div class="acard' + (dirty ? ' dirty' : '') + '">' +
      '<div class="ahead"><span class="adotbig" style="background:' + safeColor(a.color) + '"></span>' +
      '<span class="aname">' + esc(a.name) + '</span></div>' +
      (a.purpose ? '<div class="apurpose">' + esc(a.purpose) + '</div>' : '') +
      '<div class="afield"><span class="albl">Engine</span>' + agSegHtml(a.name, 'p', e) + '</div>' +
      '<div class="afield"><span class="albl">Model</span>' + agPickerHtml(a.name, 'p', e) + '</div>' +
      '<div class="afield"><span class="albl">Reasoning</span>' + agLevelHtml(a.name, 'p', e) + '</div>' +
      (extraUsage ? '<div class="aguard">⚠ <span><b>Claude inside Pi bills as per-token extra usage.</b> Switch the engine to <b>claude</b> to stay on the Pro/Max plan.</span></div>' : '') +
      (issue && !extraUsage ? '<div class="aguard">⚠ <span>' + esc(issue) + ' — the run will use this agent\\'s fallbacks.</span></div>' : '') +
      '<div class="afield"><span class="albl">If unavailable, fall back to</span><div class="afbrow">' +
      e.fallbacks.map(function(fb, i){
        return '<div class="afb"><span class="n">' + (i + 1) + '</span>' + agSegHtml(a.name, 'f' + i, fb) +
          agPickerHtml(a.name, 'f' + i, fb) + '<span class="rm" data-fbrm="' + esc(a.name) + '" data-i="' + i + '" title="remove">×</span></div>' +
          (fb.coding_agent !== 'cursor' ? '<div style="margin-left:22px">' + agLevelHtml(a.name, 'f' + i, fb) + '</div>' : '');
      }).join('') +
      (e.fallbacks.length < ${MAX_FALLBACKS} ? '<span class="afbadd" data-fbadd="' + esc(a.name) + '">+ add fallback</span>' : '') +
      '</div></div>';
  });
  html += '</div>';
  html += '<div class="asavebar" id="asavebar" style="display:none"><div class="diff"></div>' +
    '<button class="abtn ghost" data-adiscard>Discard</button>' +
    '<button class="abtn primary" data-asave>Save to fia.config.yaml</button></div>';
  main.innerHTML = html;
  bindAgentsEvents(main);
  renderAgentsSaveBar();
}

function agEditFor(name, slot){
  var e = S.agents.edits[name]; if(!e) return null;
  if(slot === 'p') return e;
  var i = parseInt(slot.slice(1), 10);
  return e.fallbacks[i] || null;
}
function bindAgentsEvents(root){
  var each = function(sel, fn){ var els = root.querySelectorAll(sel); for(var i=0;i<els.length;i++) fn(els[i]); };
  each('[data-seg]', function(el){
    el.addEventListener('click', function(){
      var parts = this.getAttribute('data-seg').split('_');
      var edit = agEditFor(parts[0], parts[1]); if(!edit) return;
      var eng = this.getAttribute('data-eng');
      if(edit.coding_agent === eng) return;
      edit.coding_agent = eng;
      edit.model = AG_DEFAULT_MODEL[eng];
      edit.level = AG_DEFAULT_LEVEL[eng];
      S.agents.msg = null;
      renderAgentsMain();
    });
  });
  each('[data-mbtn]', function(el){
    el.addEventListener('click', function(ev){
      ev.stopPropagation();
      var id = this.getAttribute('data-mbtn');
      S.agents.open = (S.agents.open && S.agents.open.id === id) ? null : { id:id };
      renderAgentsMain();
      var inp = root.querySelector('[data-mcustom="' + id + '"]');
      if(inp){ /* leave focus to the user */ }
    });
  });
  each('[data-mpick]', function(el){
    el.addEventListener('click', function(ev){
      ev.stopPropagation();
      var parts = this.getAttribute('data-mpick').split('_');
      var edit = agEditFor(parts[0], parts[1]); if(!edit) return;
      edit.model = this.getAttribute('data-model');
      S.agents.open = null; S.agents.msg = null;
      renderAgentsMain();
    });
  });
  each('[data-mcustomok]', function(el){
    el.addEventListener('click', function(ev){
      ev.stopPropagation();
      var id = this.getAttribute('data-mcustomok');
      var inp = root.querySelector('[data-mcustom="' + id + '"]');
      var v = inp && inp.value ? inp.value.trim() : '';
      if(!v) return;
      var parts = id.split('_');
      var edit = agEditFor(parts[0], parts[1]); if(!edit) return;
      edit.model = v;
      S.agents.open = null; S.agents.msg = null;
      renderAgentsMain();
    });
  });
  each('[data-mcustom]', function(el){
    el.addEventListener('click', function(ev){ ev.stopPropagation(); });
    el.addEventListener('keydown', function(ev){
      if(ev.key !== 'Enter') return;
      var id = this.getAttribute('data-mcustom');
      var ok = root.querySelector('[data-mcustomok="' + id + '"]');
      if(ok) ok.click();
    });
  });
  each('[data-lvl]', function(el){
    el.addEventListener('click', function(){
      var parts = this.getAttribute('data-lvl').split('_');
      var edit = agEditFor(parts[0], parts[1]); if(!edit) return;
      edit.level = this.getAttribute('data-v');
      S.agents.msg = null;
      renderAgentsMain();
    });
  });
  each('[data-fbadd]', function(el){
    el.addEventListener('click', function(){
      var e = S.agents.edits[this.getAttribute('data-fbadd')]; if(!e) return;
      var eng = e.coding_agent === 'pi' ? 'claude_code' : 'pi';
      e.fallbacks.push({ coding_agent:eng, model:AG_DEFAULT_MODEL[eng], level:AG_DEFAULT_LEVEL[eng] });
      S.agents.msg = null;
      renderAgentsMain();
    });
  });
  each('[data-fbrm]', function(el){
    el.addEventListener('click', function(){
      var e = S.agents.edits[this.getAttribute('data-fbrm')]; if(!e) return;
      e.fallbacks.splice(parseInt(this.getAttribute('data-i'), 10), 1);
      S.agents.msg = null;
      renderAgentsMain();
    });
  });
  var saveBtn = root.querySelector('[data-asave]');
  if(saveBtn) saveBtn.addEventListener('click', agentsSave);
  var discardBtn = root.querySelector('[data-adiscard]');
  if(discardBtn) discardBtn.addEventListener('click', function(){
    S.agents.edits = {}; S.agents.msg = null; agInitEdits(); renderAgentsMain();
  });
}
document.addEventListener('click', function(){
  if(S.agents.open){ S.agents.open = null; if(S.view === 'agents') renderAgentsMain(); }
});

function agentsSave(){
  if(S.agents.saving) return;
  var payload = { agents: agDirtyNames().map(function(n){
    var e = S.agents.edits[n];
    return {
      name: n, coding_agent: e.coding_agent, model: e.model,
      effort: e.coding_agent === 'claude_code' ? (e.level || null) : null,
      thinking: e.coding_agent === 'pi' ? (e.level || null) : null,
      fallbacks: e.fallbacks.map(function(fb){
        var out = { coding_agent: fb.coding_agent, model: fb.model };
        if(fb.coding_agent === 'claude_code' && fb.level) out.effort = fb.level;
        if(fb.coding_agent === 'pi' && fb.level) out.thinking = fb.level;
        return out;
      }),
    };
  }) };
  if(!payload.agents.length) return;
  S.agents.saving = true; S.agents.msg = null;
  renderAgentsSaveBar();
  fetch('/api/roster', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload) })
    .then(function(r){ return r.json().then(function(j){ return { status:r.status, j:j }; }); })
    .then(function(res){
      S.agents.saving = false;
      if(res.j && res.j.ok){
        S.agents.msg = { kind:'ok', text:'Saved. Comments preserved; previous version backed up at ' + (res.j.backup || 'imp/data/backups/') + '. Applies from the next run.' };
        S.agents.data = null; S.agents.edits = {};
        loadAgents(true);
      } else if(res.status === 409){
        var j = res.j || {};
        var who = j.fda_id ? ' (' + j.fda_id + (j.age_s != null ? ', last activity ' + (j.age_s < 120 ? j.age_s + 's' : Math.round(j.age_s/60) + ' min') + ' ago' : '') + ')' : '';
        S.agents.msg = { kind:'err', text:'An FDA is running' + who + ' — saving is locked until it finishes (external changes during a phase would be reverted).' };
        renderAgentsMain();
      } else {
        S.agents.msg = { kind:'err', text:(res.j && res.j.error) || 'Save failed.' };
        renderAgentsMain();
      }
    })
    .catch(function(){
      S.agents.saving = false;
      S.agents.msg = { kind:'err', text:'Save failed — is the viewer still running?' };
      renderAgentsMain();
    });
}

// ── Boot + polling ───────────────────────────────────────────────────────────
function setFilterPlaceholder(v){
  $('filter').placeholder = v === 'plan' ? 'Filter documents…' : v === 'pi' ? 'Filter Pi sessions…' : 'Filter runs…';
}
function switchView(v){
  if(v !== 'fda' && v !== 'pi' && v !== 'plan' && v !== 'agents') v = 'fda';
  if(S.view === v) return;
  S.view = v;
  var chips = $('viewsw').querySelectorAll('span');
  for(var i=0;i<chips.length;i++) chips[i].classList.toggle('on', chips[i].getAttribute('data-v')===v);
  $('main').removeAttribute('data-view');
  $('main').innerHTML = '';
  setFilterPlaceholder(v);
  if(location.hash.slice(1) !== v) location.hash = v;
  renderSidebar();
  if(v === 'fda'){
    if(S.detail) renderMain();
    else if(!S.sessions.length) renderEmptyMain(null);
    loadSessions();
  } else if(v === 'pi'){
    if(S.pi.detail) renderPiMain();
    else renderPiEmpty();
    loadPiSessions();
  } else if(v === 'agents'){
    renderAgentsMain();
    loadAgents(!S.agents.data);
  } else {
    if(S.plan.loaded) renderPlanMain();
    else $('main').innerHTML = '<div class="hero"><div class="glyph">▤</div><div>Loading the plan…</div></div>';
    loadPlan();
  }
}
(function(){
  var chips = $('viewsw').querySelectorAll('span');
  for(var i=0;i<chips.length;i++) chips[i].addEventListener('click', function(){ switchView(this.getAttribute('data-v')); });
})();
window.addEventListener('hashchange', function(){ switchView(location.hash.slice(1) || 'fda'); });
$('filter').addEventListener('input', function(){ S.filterText = this.value; renderSidebar(); });
loadSessions();
loadPiSessions();
if(location.hash.slice(1) && location.hash.slice(1) !== 'fda') switchView(location.hash.slice(1));
var tickN = 0;
setInterval(function(){
  if(document.hidden) return;
  tickN++;
  if(S.view === 'fda'){
    if(tickN % 2 === 0) loadSessions();
    loadDetail();
    loadEvents();
  } else if(S.view === 'pi'){
    if(tickN % 2 === 0) loadPiSessions();
    loadPiDetail();
  } else if(S.view === 'agents'){
    // Only engine/login status is polled — never the roster, so edits survive.
    if(tickN % 5 === 0) loadAgentsStatus();
  } else {
    // Documents change slowly — 10 s is plenty, and only while the view is active.
    if(tickN % 5 === 0) loadPlan();
  }
}, 2000);
</script>
</body>
</html>`;
