// Which kind of pointer the person is using right now. Media queries answer
// what the device has, not what is in the hand: an iPad with a trackpad keeps
// reporting a coarse, hover-less primary pointer, and some phones report a
// hovering pointer they do not have. The last pointer event settles it.

export const pointerMode = $state({ mouse: false });

const ATTRIBUTE = "data-pointer-mode";

let started = false;

// startPointerModeTracking flips the mode on real pointer events: a mouse or
// trackpad move turns it on, a touch turns it off. It is reflected on the
// root element so stylesheets can key off it. A mouse event only counts on a
// device that reports a fine pointer somewhere, which is what a tablet does
// once a trackpad or mouse is attached; a phone never does.
export function startPointerModeTracking(): () => void {
  if (started || typeof window === "undefined") return () => {};
  started = true;
  const finePointer = window.matchMedia("(any-pointer: fine)");
  const apply = (mouse: boolean) => {
    if (pointerMode.mouse === mouse) return;
    pointerMode.mouse = mouse;
    if (mouse) document.documentElement.setAttribute(ATTRIBUTE, "mouse");
    else document.documentElement.removeAttribute(ATTRIBUTE);
  };
  const onPointer = (event: PointerEvent) => {
    if (event.pointerType === "mouse") apply(finePointer.matches);
    else if (event.pointerType === "touch") apply(false);
  };
  window.addEventListener("pointermove", onPointer, { capture: true, passive: true });
  window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  return () => {
    window.removeEventListener("pointermove", onPointer, { capture: true });
    window.removeEventListener("pointerdown", onPointer, { capture: true });
    started = false;
  };
}
