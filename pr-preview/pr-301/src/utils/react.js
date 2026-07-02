import useMedia from "../../node_modules/react-use/esm/useMedia.js";
//#region src/utils/react.tsx
var useIsMobile = () => {
	return useMedia("(max-width: 767px)", false);
};
/** Whether the PRIMARY pointing device is coarse (touch/stylus) — i.e. a
*  phone, tablet, or a convertible in tablet mode. Reads `false` on desktops,
*  laptops, and touch laptops / convertibles in laptop mode, where the primary
*  pointer is a mouse/trackpad (`fine`) even if a touchscreen is also present.
*  Reactive: attaching a mouse can flip the primary pointer to fine. */
var usePointerCoarse = () => {
	return useMedia("(pointer: coarse)", false);
};
//#endregion
export { useIsMobile, usePointerCoarse };

//# sourceMappingURL=react.js.map