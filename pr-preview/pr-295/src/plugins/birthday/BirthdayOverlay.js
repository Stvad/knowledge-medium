import { useEffect } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/birthday/BirthdayOverlay.tsx
var PAW_COUNT = 28;
var STAR_COUNT = 60;
/** A friendly first name for the banner. Users without a display name fall
*  back to their email (`getUserName` in services/supabase), and
*  "Happy Birthday you@example.com" reads badly — so derive a name from
*  the email local-part (drop +tags, split on . _ -, title-case). A
*  non-email name is used as-is. */
function prettyName(name) {
	const trimmed = name?.trim();
	if (!trimmed) return void 0;
	if (!trimmed.includes("@")) return trimmed;
	const words = (trimmed.split("@")[0]?.split("+")[0] ?? "").split(/[._-]+/).filter(Boolean);
	if (words.length === 0) return void 0;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
/** Deterministic pseudo-random in [0, 1) from a seed. Lets the confetti
*  stay varied without calling the impure Math.random during render (and
*  with no empty first frame), computed once at module load. */
var hash = (n) => {
	const x = Math.sin(n * 12.9898) * 43758.5453;
	return x - Math.floor(x);
};
var PAWS = Array.from({ length: PAW_COUNT }, (_, i) => ({
	left: hash(i * 1.7 + 1) * 100,
	delay: hash(i * 2.3 + 2) * 4,
	duration: 4 + hash(i * 3.1 + 3) * 5,
	size: 14 + hash(i * 4.7 + 4) * 22,
	drift: (hash(i * 5.3 + 5) - .5) * 80,
	opacity: .3 + hash(i * 6.1 + 6) * .5
}));
var STARS = Array.from({ length: STAR_COUNT }, (_, i) => ({
	cx: hash(i * 1.9 + 7) * 400,
	cy: hash(i * 2.7 + 8) * 190,
	r: hash(i * 3.3 + 9) * 1.3 + .3,
	delay: hash(i * 4.1 + 10) * 3,
	dur: 1.6 + hash(i * 5.9 + 11) * 2.6
}));
function BirthdayOverlay({ name, onClose }) {
	useEffect(() => {
		const onKey = (e) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	const display = prettyName(name);
	return /* @__PURE__ */ jsxs("div", {
		className: "wolf-overlay",
		role: "dialog",
		"aria-label": "Birthday celebration",
		onClick: onClose,
		children: [
			/* @__PURE__ */ jsx("style", { children: KEYFRAMES }),
			/* @__PURE__ */ jsx("div", {
				className: "wolf-paws",
				"aria-hidden": true,
				children: PAWS.map((p, i) => /* @__PURE__ */ jsx("span", {
					className: "wolf-paw",
					style: {
						left: `${p.left}%`,
						fontSize: `${p.size}px`,
						opacity: p.opacity,
						animationDelay: `${p.delay}s`,
						animationDuration: `${p.duration}s`,
						["--drift"]: `${p.drift}px`
					},
					children: "🐾"
				}, i))
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "wolf-scene",
				children: [
					/* @__PURE__ */ jsxs("svg", {
						viewBox: "0 0 400 300",
						className: "wolf-sky",
						"aria-hidden": true,
						children: [
							/* @__PURE__ */ jsxs("defs", { children: [/* @__PURE__ */ jsxs("radialGradient", {
								id: "wolf-moon-glow",
								cx: "50%",
								cy: "50%",
								r: "50%",
								children: [
									/* @__PURE__ */ jsx("stop", {
										offset: "0%",
										stopColor: "#fdfbf0",
										stopOpacity: "0.9"
									}),
									/* @__PURE__ */ jsx("stop", {
										offset: "35%",
										stopColor: "#cfe3ff",
										stopOpacity: "0.35"
									}),
									/* @__PURE__ */ jsx("stop", {
										offset: "100%",
										stopColor: "#cfe3ff",
										stopOpacity: "0"
									})
								]
							}), /* @__PURE__ */ jsxs("radialGradient", {
								id: "wolf-moon-body",
								cx: "42%",
								cy: "40%",
								r: "60%",
								children: [/* @__PURE__ */ jsx("stop", {
									offset: "0%",
									stopColor: "#fffdf5"
								}), /* @__PURE__ */ jsx("stop", {
									offset: "100%",
									stopColor: "#dfe8f5"
								})]
							})] }),
							STARS.map((s, i_0) => /* @__PURE__ */ jsx("circle", {
								cx: s.cx,
								cy: s.cy,
								r: s.r,
								fill: "#eaf2ff",
								className: "wolf-star",
								style: {
									animationDelay: `${s.delay}s`,
									animationDuration: `${s.dur}s`
								}
							}, i_0)),
							/* @__PURE__ */ jsx("circle", {
								cx: "200",
								cy: "120",
								r: "120",
								fill: "url(#wolf-moon-glow)",
								className: "wolf-glow"
							}),
							/* @__PURE__ */ jsx("circle", {
								cx: "200",
								cy: "118",
								r: "58",
								fill: "url(#wolf-moon-body)"
							}),
							/* @__PURE__ */ jsx("circle", {
								cx: "182",
								cy: "104",
								r: "9",
								fill: "#cdd8ea",
								opacity: "0.6"
							}),
							/* @__PURE__ */ jsx("circle", {
								cx: "216",
								cy: "132",
								r: "6",
								fill: "#cdd8ea",
								opacity: "0.5"
							}),
							/* @__PURE__ */ jsx("circle", {
								cx: "210",
								cy: "100",
								r: "4",
								fill: "#cdd8ea",
								opacity: "0.5"
							})
						]
					}),
					/* @__PURE__ */ jsx("div", {
						className: "wolf-figure",
						"aria-hidden": true,
						children: "🐺"
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "wolf-text",
						children: [
							/* @__PURE__ */ jsx("div", {
								className: "wolf-title",
								children: "Happy Birthday"
							}),
							display ? /* @__PURE__ */ jsx("div", {
								className: "wolf-name",
								children: display
							}) : null,
							/* @__PURE__ */ jsx("div", {
								className: "wolf-sub",
								children: "the pack howls for you tonight 🌙"
							})
						]
					})
				]
			}),
			/* @__PURE__ */ jsx("button", {
				type: "button",
				className: "wolf-close",
				onClick: (e_0) => {
					e_0.stopPropagation();
					onClose();
				},
				"aria-label": "Dismiss",
				children: "✕"
			})
		]
	});
}
var KEYFRAMES = `
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
`;
//#endregion
export { BirthdayOverlay };

//# sourceMappingURL=BirthdayOverlay.js.map