//#region src/shortcuts/gestureBinding.ts
/** Realize a {@link GestureBindingSpec}'s declared/defaulted fields into the
*  descriptor the matcher compares against. */
var gestureBindingDescriptor = (spec) => ({
	gesture: spec.gesture,
	phase: spec.phase ?? "commit"
});
/**
* Does an emitted gesture satisfy a {@link GestureDescriptor}? Name and phase
* match exactly — there are no modifier/button fields to compare, since the
* recognizer has already classified the motion into a discrete named gesture.
*/
var matchesGestureEvent = (descriptor, event) => descriptor.gesture === event.gesture && descriptor.phase === event.phase;
//#endregion
export { gestureBindingDescriptor, matchesGestureEvent };

//# sourceMappingURL=gestureBinding.js.map