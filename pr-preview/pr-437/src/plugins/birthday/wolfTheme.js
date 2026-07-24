import{THEME_STORAGE_KEY as e}from"../../themeBootDefaults.js";import"../theme-toggle/theme.js";var t=`wolf`,n=`birthday:wolf:prev`,r=`birthday:wolf:active`,i=`birthday-wolf-theme`,a=`sunset-warm-light`,o={background:`224 47% 8%`,foreground:`210 30% 88%`,card:`224 44% 11%`,"card-foreground":`210 30% 88%`,popover:`224 44% 11%`,"popover-foreground":`210 30% 88%`,primary:`205 90% 72%`,"primary-foreground":`224 47% 9%`,secondary:`221 30% 18%`,"secondary-foreground":`210 30% 90%`,muted:`221 26% 16%`,"muted-foreground":`214 22% 68%`,accent:`250 38% 30%`,"accent-foreground":`220 40% 92%`,destructive:`0 62% 47%`,"destructive-foreground":`0 0% 98%`,border:`212 26% 30%`,input:`214 25% 24%`,ring:`205 90% 72%`,link:`205 90% 76%`,wikilink:`258 70% 80%`,code:`221 26% 16%`,success:`142 50% 52%`,radius:`0.65rem`,"chart-1":`205 90% 72%`,"chart-2":`250 60% 70%`,"chart-3":`190 70% 60%`,"chart-4":`280 55% 68%`,"chart-5":`160 50% 55%`},s=`
[data-theme="${t}"] .bullet {
  background-color: transparent;
  position: relative;
  overflow: visible;
}
[data-theme="${t}"] .bullet::before {
  content: "🐺";
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 13px;
  line-height: 1;
  pointer-events: none;
  filter: saturate(0.85);
}
[data-theme="${t}"] .bullet-with-children {
  border-color: transparent;
  box-shadow:
    0 0 0 1.5px hsl(var(--ring) / 0.35),
    0 0 8px 2px hsl(var(--ring) / 0.40);
}
[data-theme="${t}"] .bullet-with-children::before {
  font-size: 12px;
}
[data-theme="${t}"] .bullet-link:hover .bullet::before {
  transform: translate(-50%, -50%) scale(1.15);
}
`;function c(){return`[data-theme="${t}"] {\n${Object.entries(o).map(([e,t])=>`  --${e}: ${t};`).join(`
`)}\n}\n${s}`}function l(){if(document.getElementById(i))return;let e=document.createElement(`style`);e.id=i,e.textContent=c(),document.head.appendChild(e)}function u(){document.getElementById(i)?.remove()}function d(){return document.documentElement.dataset.theme??``}function f(t){document.documentElement.dataset.theme=t;try{window.localStorage?.setItem(e,t)}catch{}}function p(){l(),f(t)}function m(e){try{return window.localStorage?.getItem(e)??null}catch{return null}}function h(e,t){try{window.localStorage?.setItem(e,t)}catch{}}function g(e){try{window.localStorage?.removeItem(e)}catch{}}function _(e,i){let o=m(r);if(e){if(l(),o!==i){let e=d();h(n,e===`wolf`?m(n)??a:e),h(r,i),f(t)}return}o&&(d()===`wolf`&&f(m(n)??a),g(r),g(n),u())}export{t as WOLF_THEME_ID,p as applyWolfTheme,_ as syncWolfTheme};
//# sourceMappingURL=wolfTheme.js.map