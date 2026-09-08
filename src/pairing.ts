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
import { storedAccountId } from './account';
import {
    createInvitation,
    deleteAccount,
    fetchInvitations,
    redeemInvitation,
    revokeShare,
} from './anchor-share';
import { myAnchorLabel, refreshFollowing, sharingAvailable } from './anchor-sync';
import { describeInvitation } from './people';
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
let followersEl: HTMLElement;
let followerList: HTMLElement;
let deleteBtn: HTMLElement;

/**
 * One line, one colour, and never cleared by anything but the next attempt.
 *
 * Saying something is what makes it visible — the whole class list is rewritten
 * here, `hidden` included, so there is one place that decides both what the line
 * says and whether it is on screen. It used to happen by accident, which is a
 * fine way for a line to go missing the day somebody adds a class to it.
 */
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
        say(REASONS.unreachable, 'bad');
        return;
    }

    // Hyphenated for reading aloud, and only for that: the relay normalises
    // whatever is typed, so nobody has to reproduce the punctuation.
    codeEl.textContent = formatShareCode(invitation.code);
    codeNote.textContent = 'Good for 24 hours, once. They type it into their app.';
    // The mint IS a row in the list below — an outstanding code is a door that
    // is already open, and it should be visible and closeable from the moment
    // it exists rather than only after somebody walks through it.
    void refreshFollowers();
}

/**
 * Who can currently read this device's time, and the way to stop each of them.
 *
 * Hidden entirely when the answer is nobody, which for most installs is always.
 * A null answer is unreachable, not empty, and leaves whatever was last drawn
 * standing — the same rule fetchFollowing lives by, and for the same reason: a
 * list that empties itself when the network drops would say the sharing has
 * stopped when all that has stopped is the asking.
 */
async function refreshFollowers(): Promise<void> {
    if (!storedAccountId()) {
        followersEl.classList.add('hidden');
        deleteBtn.classList.add('hidden');
        return;
    }
    // There IS an account, so there is something on a server to delete, whether
    // or not anybody is reading it.
    deleteBtn.classList.remove('hidden');

    const invitations = await fetchInvitations();
    if (!invitations) return;

    followersEl.classList.toggle('hidden', invitations.length === 0);
    followerList.replaceChildren(...invitations.map((invitation) => {
        const { text, code } = describeInvitation(invitation);
        const row = document.createElement('li');
        row.className = 'flex items-center justify-between gap-3 text-sm';

        // Two lines, like a world clock row: what it is, then what it is doing.
        // One line would have to be monospaced throughout, since the code has to
        // be — and prose set in a code font reads as something to be typed.
        const label = document.createElement('div');
        label.className = 'min-w-0';
        if (code) {
            // Shown again rather than reminted, so somebody who lost the slip of
            // paper does not end up with two live codes for one intent.
            const shown = document.createElement('p');
            shown.className = 'font-mono tracking-wider text-gray-200';
            shown.textContent = formatShareCode(code);
            label.append(shown);
        }
        const note = document.createElement('p');
        note.className = code ? 'text-xs text-gray-500' : 'text-gray-300';
        note.textContent = text;
        label.append(note);

        const stop = document.createElement('button');
        stop.className = 'shrink-0 text-gray-500 hover:text-red-400 transition-colors text-xs';
        stop.textContent = 'Stop';
        stop.addEventListener('click', () => { void stopSharing(invitation.shareId); });

        row.append(label, stop);
        return row;
    }));
}

/** Ends one share from the sharing side. The same call the follower's × makes. */
async function stopSharing(shareId: string): Promise<void> {
    say('Stopping…');

    // Awaited, unlike the follower's ×. There the row goes locally first and the
    // relay catches up, because the row is the thing the person wanted rid of
    // and it should go even with no signal. Here the relay IS the state — there
    // is nothing local to remove — so saying "stopped" before it has answered
    // would be a claim this device is not in a position to make, about the one
    // thing somebody most needs to be told the truth about.
    if (await revokeShare(shareId)) {
        say('Stopped. They can no longer see your time.', 'good');
    } else {
        say('Could not reach the server, so nothing has changed. They can still see your time — try again in a moment.', 'bad');
    }
    await refreshFollowers();
}

/**
 * Removes everything the relay holds about this install.
 *
 * Confirmed first, because it cannot be undone and it silently breaks every
 * share in both directions — the people you follow stop reaching you, and the
 * people following you stop seeing you, with nothing on their screens to say
 * why beyond a row that quietly ages.
 *
 * The local list goes too, and only after the relay agrees. Keeping it would
 * leave rows that can never update again and can never be revoked, because the
 * token that could have asked is gone.
 */
async function deleteEverything(): Promise<void> {
    const followedCount = state.followedPeople.length;
    const warning = followedCount > 0
        ? `Delete your sharing data? Your ${followedCount === 1 ? 'row' : `${followedCount} rows`} for other people will go, and anybody who can see your time will stop being able to. This cannot be undone.`
        : 'Delete your sharing data? Anybody who can see your time will stop being able to. This cannot be undone.';
    if (!window.confirm(warning)) return;

    say('Deleting…');

    if (!await deleteAccount()) {
        say('Could not reach the server, so nothing was deleted. Try again in a moment.', 'bad');
        return;
    }

    persistFollowedPeople([]);
    show(null);
    await refreshFollowers();
    say('Deleted. Nothing about you is left on the server.', 'good');
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
    followersEl = document.getElementById('sharing-followers')!;
    followerList = document.getElementById('sharing-follower-list')!;
    deleteBtn = document.getElementById('sharing-delete')!;

    card.classList.remove('hidden');
    refreshSharingCard();
    void refreshFollowers();

    document.getElementById('sharing-invite')!.addEventListener('click', () => { void invite(); });
    document.getElementById('sharing-redeem')!.addEventListener('click', () => {
        show(redeemPanel);
        codeInput.focus();
    });
    document.getElementById('sharing-confirm')!.addEventListener('click', () => { void follow(); });
    deleteBtn.addEventListener('click', () => { void deleteEverything(); });

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
