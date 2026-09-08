// src/toast.ts
//
// Something that says what just happened and then stops saying it.
//
// The sharing card used to keep one line of status text under the buttons
// forever: you stopped a share in the morning and "Stopped. They can no longer
// see your time." was still sitting there at lunchtime, describing an event
// nobody remembered. A message that never leaves stops being a message and
// becomes a label — and a label that is sometimes a lie about the present.
//
// So: outcomes go here and disappear; only field validation stays put, because
// somebody looking at a form they have not submitted needs the reason to still
// be on screen when they look back down at it.
//
// Deliberately not a component framework. One container, appended once, and
// text nodes — the same reasoning the rest of this app renders by.

/** Long enough to read twice, short enough not to become furniture. */
const LINGER_MS = { good: 3200, plain: 3200, bad: 6000 } as const;

export type ToastTone = keyof typeof LINGER_MS;

let host: HTMLElement | null = null;

function container(): HTMLElement {
    if (host) return host;
    host = document.createElement('div');
    host.id = 'toasts';
    // aria-live rather than a role of alert: these are confirmations of things
    // the user just did, and a screen reader should mention them without
    // interrupting whatever it was in the middle of saying.
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
    return host;
}

/**
 * Says something, briefly.
 *
 * Dismissible by tapping, because the one thing worse than a message that
 * never goes is a message that will not go when you are trying to read what is
 * behind it. Failures linger about twice as long as successes: "done" is
 * confirming something you already believe, while "that did not work" is news.
 */
export function toast(text: string, tone: ToastTone = 'plain'): void {
    const el = document.createElement('div');
    el.className = `toast toast-${tone}`;
    el.textContent = text;

    const dismiss = () => {
        // Guard rather than assume: the timer and a tap race every time, and
        // the loser would otherwise animate an element that is already gone.
        if (!el.isConnected) return;
        el.classList.add('is-leaving');
        el.addEventListener('transitionend', () => el.remove(), { once: true });
        // A belt for the braces: transitionend never fires if the element is
        // display:none by the time it would have, and a stuck toast is exactly
        // the bug this module exists to remove.
        setTimeout(() => el.remove(), 400);
    };

    el.addEventListener('click', dismiss);
    container().append(el);

    // Two frames, not one. A single frame is enough in Chrome and is not in
    // WebKit, where the element can still be pre-layout and the transition is
    // skipped — the toast then appears fully formed rather than rising.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')));
    setTimeout(dismiss, LINGER_MS[tone]);
}
