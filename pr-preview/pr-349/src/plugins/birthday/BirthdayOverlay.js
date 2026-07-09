import{useEffect as e}from"react";import{jsx as t,jsxs as n}from"react/jsx-runtime";var r=28,i=60;function a(e){let t=e?.trim();if(!t)return;if(!t.includes(`@`))return t;let n=(t.split(`@`)[0]?.split(`+`)[0]??``).split(/[._-]+/).filter(Boolean);if(n.length!==0)return n.map(e=>e.charAt(0).toUpperCase()+e.slice(1)).join(` `)}var o=e=>{let t=Math.sin(e*12.9898)*43758.5453;return t-Math.floor(t)},s=Array.from({length:r},(e,t)=>({left:o(t*1.7+1)*100,delay:o(t*2.3+2)*4,duration:4+o(t*3.1+3)*5,size:14+o(t*4.7+4)*22,drift:(o(t*5.3+5)-.5)*80,opacity:.3+o(t*6.1+6)*.5})),c=Array.from({length:i},(e,t)=>({cx:o(t*1.9+7)*400,cy:o(t*2.7+8)*190,r:o(t*3.3+9)*1.3+.3,delay:o(t*4.1+10)*3,dur:1.6+o(t*5.9+11)*2.6}));function l({name:r,onClose:i}){e(()=>{let e=e=>{e.key===`Escape`&&i()};return window.addEventListener(`keydown`,e),()=>window.removeEventListener(`keydown`,e)},[i]);let o=a(r);return n(`div`,{className:`wolf-overlay`,role:`dialog`,"aria-label":`Birthday celebration`,onClick:i,children:[t(`style`,{children:u}),t(`div`,{className:`wolf-paws`,"aria-hidden":!0,children:s.map((e,n)=>t(`span`,{className:`wolf-paw`,style:{left:`${e.left}%`,fontSize:`${e.size}px`,opacity:e.opacity,animationDelay:`${e.delay}s`,animationDuration:`${e.duration}s`,"--drift":`${e.drift}px`},children:`🐾`},n))}),n(`div`,{className:`wolf-scene`,children:[n(`svg`,{viewBox:`0 0 400 300`,className:`wolf-sky`,"aria-hidden":!0,children:[n(`defs`,{children:[n(`radialGradient`,{id:`wolf-moon-glow`,cx:`50%`,cy:`50%`,r:`50%`,children:[t(`stop`,{offset:`0%`,stopColor:`#fdfbf0`,stopOpacity:`0.9`}),t(`stop`,{offset:`35%`,stopColor:`#cfe3ff`,stopOpacity:`0.35`}),t(`stop`,{offset:`100%`,stopColor:`#cfe3ff`,stopOpacity:`0`})]}),n(`radialGradient`,{id:`wolf-moon-body`,cx:`42%`,cy:`40%`,r:`60%`,children:[t(`stop`,{offset:`0%`,stopColor:`#fffdf5`}),t(`stop`,{offset:`100%`,stopColor:`#dfe8f5`})]})]}),c.map((e,n)=>t(`circle`,{cx:e.cx,cy:e.cy,r:e.r,fill:`#eaf2ff`,className:`wolf-star`,style:{animationDelay:`${e.delay}s`,animationDuration:`${e.dur}s`}},n)),t(`circle`,{cx:`200`,cy:`120`,r:`120`,fill:`url(#wolf-moon-glow)`,className:`wolf-glow`}),t(`circle`,{cx:`200`,cy:`118`,r:`58`,fill:`url(#wolf-moon-body)`}),t(`circle`,{cx:`182`,cy:`104`,r:`9`,fill:`#cdd8ea`,opacity:`0.6`}),t(`circle`,{cx:`216`,cy:`132`,r:`6`,fill:`#cdd8ea`,opacity:`0.5`}),t(`circle`,{cx:`210`,cy:`100`,r:`4`,fill:`#cdd8ea`,opacity:`0.5`})]}),t(`div`,{className:`wolf-figure`,"aria-hidden":!0,children:`🐺`}),n(`div`,{className:`wolf-text`,children:[t(`div`,{className:`wolf-title`,children:`Happy Birthday`}),o?t(`div`,{className:`wolf-name`,children:o}):null,t(`div`,{className:`wolf-sub`,children:`the pack howls for you tonight 🌙`})]})]}),t(`button`,{type:`button`,className:`wolf-close`,onClick:e=>{e.stopPropagation(),i()},"aria-label":`Dismiss`,children:`✕`})]})}var u=`
.wolf-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  background:
    radial-gradient(120% 90% at 50% 18%, rgba(40,58,110,0.55), transparent 60%),
    linear-gradient(180deg, #070b1c 0%, #0c1430 45%, #0a0f24 100%);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  animation: wolf-fade-in 600ms ease-out both;
}
@keyframes wolf-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.wolf-scene {
  position: relative;
  width: min(90vw, 520px);
  text-align: center;
  pointer-events: none;
  animation: wolf-rise 900ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes wolf-rise {
  from { opacity: 0; transform: translateY(28px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.wolf-sky { width: 100%; display: block; }
.wolf-glow { animation: wolf-pulse 5s ease-in-out infinite; transform-origin: 200px 120px; }
@keyframes wolf-pulse {
  0%, 100% { opacity: 0.85; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.06); }
}
.wolf-star { animation: wolf-twinkle ease-in-out infinite; }
@keyframes wolf-twinkle {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}
.wolf-figure {
  position: absolute;
  left: 50%;
  top: 40%;
  transform: translate(-50%, -50%);
  font-size: 96px;
  line-height: 1;
  filter: drop-shadow(0 6px 18px rgba(0,0,0,0.6));
  animation: wolf-howl 4s ease-in-out infinite;
}
@keyframes wolf-howl {
  0%, 100% { transform: translate(-50%, -50%) rotate(0deg); }
  35% { transform: translate(-50%, -54%) rotate(-7deg); }
  70% { transform: translate(-50%, -52%) rotate(-4deg); }
}
.wolf-text {
  position: relative;
  margin-top: -18px;
  color: #eef3ff;
  text-shadow: 0 2px 20px rgba(120,160,255,0.45);
}
.wolf-title {
  font-size: clamp(28px, 6vw, 48px);
  font-weight: 800;
  letter-spacing: 0.02em;
}
.wolf-name {
  font-size: clamp(18px, 3.6vw, 26px);
  font-weight: 600;
  margin-top: 2px;
  color: #bcd2ff;
}
.wolf-sub {
  margin-top: 10px;
  font-size: clamp(12px, 2.4vw, 15px);
  color: #9fb2db;
  letter-spacing: 0.04em;
}
.wolf-paws { position: absolute; inset: 0; pointer-events: none; }
.wolf-paw {
  position: absolute;
  top: -8%;
  animation-name: wolf-fall;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}
@keyframes wolf-fall {
  from { transform: translateY(-10vh) translateX(0) rotate(0deg); }
  to { transform: translateY(115vh) translateX(var(--drift, 0px)) rotate(220deg); }
}
.wolf-close {
  position: absolute;
  top: 18px;
  right: 18px;
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  border: 1px solid rgba(190,210,255,0.25);
  background: rgba(20,28,56,0.6);
  color: #cdd9f5;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  transition: background 150ms ease, transform 150ms ease;
}
.wolf-close:hover { background: rgba(40,54,100,0.8); transform: scale(1.06); }
@media (prefers-reduced-motion: reduce) {
  .wolf-overlay, .wolf-scene { animation: none; }
  .wolf-glow, .wolf-star, .wolf-figure, .wolf-paw { animation: none; }
}
`;export{l as BirthdayOverlay};
//# sourceMappingURL=BirthdayOverlay.js.map