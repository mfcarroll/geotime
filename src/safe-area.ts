// src/safe-area.ts
//
// Keeps the status-bar strip (#safe-area-spacer) over the status bar while the
// iOS keyboard is up.
//
// The strip is position: fixed, which pins it to the LAYOUT viewport. Focusing a
// field on iOS pans the VISUAL viewport to make room for the keyboard instead,
// so the strip slid off the top of the screen with the page, and the Sharing
// card's text drew under the clock and battery for as long as the keyboard was
// open. visualViewport.offsetTop is how far that pan has gone; following it puts
// the strip back where the status bar is. It is zero whenever nothing is panned,
// which is always on Android and the web, so there this does nothing.

export function pinSafeAreaStrip(): void {
    const strip = document.getElementById('safe-area-spacer');
    const viewport = window.visualViewport;
    if (!strip || !viewport) return;

    const follow = () => {
        const offset = Math.max(0, viewport.offsetTop);
        strip.style.transform = offset ? `translateY(${offset}px)` : '';
    };
    viewport.addEventListener('resize', follow);
    viewport.addEventListener('scroll', follow);
    follow();
}
