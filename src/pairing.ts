// src/pairing.ts
//
// Handing somebody a code, and typing in theirs.
//
// The only screen in 2.0 where a person is waiting on an answer from the relay,
// which is why anchor-share.ts breaks its own never-explain rule for exactly one
// call: redeemInvitation returns a reason, and this is what the reason is for.
// Everything else in the feature can fail quietly and age; a code that will not
// work has to say why, immediately, to somebody who is standing there.
//
// Native only, and not for want of trying. The web build has no widget to feed,
// which is most of the point, and localStorage on a page anybody can visit is a
// far weaker place to keep an identity than an app container is. `DEV` is the
// escape hatch so the flow can be exercised in a browser.

import { formatShareCode } from './share-code';
import { createInvitation, redeemInvitation } from './anchor-share';
import { myAnchorLabel, refreshFollowing, sharingAvailable } from './anchor-sync';
import { persistFollowedPeople, state } from './state';

/** What to say when a code comes back refused. */
const REASONS: Record<string, string> = {
    invalid: 'That code is not one we know. Codes are good for 24 hours and can only be used once.',
    yourself: 'That is your own code — you would only be following yourself.',
    full: 'You are already following as many people as an account can hold.',
    unreachable: 'Could not reach the server. Try again in a moment.',
};

let card: HTMLElement;
let anchorEl: HTMLElement;
let codePanel: HTMLElement;
let codeEl: HTMLElement;
let codeNote: HTMLElement;
let redeemPanel: HTMLElement;
let codeInput: HTMLInputElement;
let nameInput: HTMLInputElement;
let statusEl: HTMLElement;

/** One line, one colour, and never cleared by anything but the next attempt. */
function say(text: string, tone: 'good' | 'bad' | 'plain' = 'plain'): void {
    statusEl.textContent = text;
    statusEl.className =
        `text-sm mt-3 ${tone === 'bad' ? 'text-red-400' : tone === 'good' ? 'text-green-400' : 'text-gray-400'}`;
}

function show(panel: HTMLElement | null): void {
    codePanel.classList.toggle('hidden', panel !== codePanel);
    redeemPanel.classList.toggle('hidden', panel !== redeemPanel);
    statusEl.classList.add('hidden');
}

/**
 * Mints a code and puts it on screen.
 *
 * This is the first moment an account can be created — see ensureAccount, which
 * createInvitation calls — and that is deliberate: it is the first moment the
 * person has actually asked for one.
 */
async function invite(): Promise<void> {
    show(codePanel);
    codeEl.textContent = '·····';
    codeNote.textContent = 'Asking the server…';

    const invitation = await createInvitation();
    if (!invitation?.code) {
        codeEl.textContent = '--------';
        codeNote.textContent = '';
        statusEl.classList.remove('hidden');
        say(REASONS.unreachable, 'bad');
        return;
    }

    // Hyphenated for reading aloud, and only for that: the relay normalises
    // whatever is typed, so nobody has to reproduce the punctuation.
    codeEl.textContent = formatShareCode(invitation.code);
    codeNote.textContent = 'Good for 24 hours, once. They type it into their app.';
}

/**
 * Takes a code and a name and turns them into a row.
 *
 * The name is written here, locally, and never sent — see people.ts. Which
 * means the row exists the moment the relay says the pairing took, with no
 * anchor yet and a sub-label that says so, rather than appearing later out of
 * nowhere when the other person next opens their app.
 */
async function follow(): Promise<void> {
    const typed = codeInput.value.trim();
    const name = nameInput.value.trim();
    statusEl.classList.remove('hidden');

    if (!typed) return say('Enter the code they gave you.', 'bad');
    if (!name) return say('Give them a name — it is only stored on this device.', 'bad');

    say('Checking…');
    const result = await redeemInvitation(typed);
    if (!result.ok) return say(REASONS[result.reason] ?? REASONS.unreachable, 'bad');

    // Replacing rather than appending, so redeeming a second code from the same
    // person updates the name instead of drawing two rows for one share.
    persistFollowedPeople([
        ...state.followedPeople.filter((person) => person.shareId !== result.shareId),
        { shareId: result.shareId, name, anchor: null, updatedAt: null },
    ]);

    codeInput.value = '';
    nameInput.value = '';
    // The keyboard goes, or it sits on top of the very line that says whether
    // this worked — which on a phone is the whole answer to what just happened.
    nameInput.blur();
    say(`Following ${name}.`, 'good');

    // They may already have pushed, in which case the row can have a time on it
    // before the person looks away from this card. persistFollowedPeople says
    // so both times; nothing here has to.
    void refreshFollowing();
}

/** Keeps the "you appear as" line honest as the device moves or boards a ship. */
export function refreshSharingCard(): void {
    if (anchorEl) anchorEl.textContent = myAnchorLabel();
}

export function initPairing(): void {
    card = document.getElementById('sharing-card')!;
    if (!card || !sharingAvailable()) return;

    anchorEl = document.getElementById('sharing-anchor')!;
    codePanel = document.getElementById('sharing-code-panel')!;
    codeEl = document.getElementById('sharing-code')!;
    codeNote = document.getElementById('sharing-code-note')!;
    redeemPanel = document.getElementById('sharing-redeem-panel')!;
    codeInput = document.getElementById('sharing-code-input') as HTMLInputElement;
    nameInput = document.getElementById('sharing-name-input') as HTMLInputElement;
    statusEl = document.getElementById('sharing-status')!;

    card.classList.remove('hidden');
    refreshSharingCard();

    document.getElementById('sharing-invite')!.addEventListener('click', () => { void invite(); });
    document.getElementById('sharing-redeem')!.addEventListener('click', () => {
        show(redeemPanel);
        codeInput.focus();
    });
    document.getElementById('sharing-confirm')!.addEventListener('click', () => { void follow(); });

    // Enter from the code field goes to the name field, and from the name field
    // submits — the order somebody types them in.
    codeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); nameInput.focus(); }
    });
    nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void follow(); }
    });

    // The same events anchor-sync watches, for the same reason: this line
    // describes what those events change.
    document.addEventListener('aboardshipchanged', refreshSharingCard);
    document.addEventListener('shipclockschanged', refreshSharingCard);
    document.addEventListener('gpstimezonefound', refreshSharingCard);
}
