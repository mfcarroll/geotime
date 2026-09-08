// src/pairing.ts
//
// The sharing screen: who you are to other people, how much they are told, and
// the two lists of who is on each end.
//
// It is the only screen in the app where somebody is standing there waiting on
// an answer from a server, which is why anchor-share.ts breaks its own
// never-explain rule for exactly two calls — minting and redeeming both return
// a reason. "Something went wrong" is not an answer to a person who has just
// tapped a button.
//
// WHAT SAYS WHAT, AND FOR HOW LONG. Outcomes are toasts and go away: a line of
// status text under the buttons that said "Stopped. They can no longer see your
// time." was still saying it hours later, describing an event nobody
// remembered. Field validation stays put, because a reason to fix the box in
// front of you has to still be there while you fix it.
//
// ONE FLOW AT A TIME. The two action buttons hide while a panel is open.
// Offering both while one is half-finished is offering to abandon it without
// saying so, and it was the thing that made this card feel unfinished.
//
// Native only, and not for want of trying: the web build has no widget to feed,
// which is most of the point, and localStorage on a page anybody can visit is a
// far weaker place to keep an identity than an app container is. `DEV` is the
// escape hatch so the flow can be exercised in a browser.

import { Share } from '@capacitor/share';

import { anchorAsSeen } from './anchor';
import { formatShareCode, normaliseShareCode } from './share-code';
import { storedAccountId } from './account';
import {
    createInvitation,
    deleteAccount,
    fetchInvitations,
    redeemInvitation,
    revokeShare,
} from './anchor-share';
import {
    myAnchor,
    pushMyAnchorNow,
    pushProfile,
    refreshFollowing,
    sharingAvailable,
    stopFollowing,
} from './anchor-sync';
import type { ClockEntry } from './clocks';
import { describeInvitation } from './people';
import { persistFollowedPeople, setSharePrefs, state } from './state';
import { onClockTick } from './time';
import { toast } from './toast';
import { buildPreviewRow, fillPreviewRow } from './map';

/** Where a follow link points. See the Worker route and the .well-known files. */
const FOLLOW_LINK_BASE = 'https://geotime-api.matthewcarroll.ca/f';

/** Why a code did not work, for a person who is standing there waiting. */
const REASONS: Record<string, string> = {
    invalid: 'That code is not one we know. Codes last 24 hours and work once.',
    yourself: 'That is your own code — you would only be following yourself.',
    full: 'You are already following as many people as an account can hold.',
    unreachable: 'Could not reach the server. Try again in a moment.',
};

/**
 * Being at the cap is not a network problem and must not be reported as one:
 * the way out is to stop a share below, not to go and look at the wifi.
 */
const INVITE_REASONS: Record<string, string> = {
    full: 'As many people can see your time as an account allows. Stop one below to make room.',
    unreachable: REASONS.unreachable,
};

let card: HTMLElement;
let actions: HTMLElement;
let codePanel: HTMLElement;
let codeEl: HTMLElement;
let codeNote: HTMLElement;
let redeemPanel: HTMLElement;
let codeInput: HTMLInputElement;
let redeemError: HTMLElement;
let followingEl: HTMLElement;
let followingList: HTMLElement;
let followersEl: HTMLElement;
let followerList: HTMLElement;
let deleteBtn: HTMLElement;
let myNameInput: HTMLInputElement;
let exactBox: HTMLInputElement;
let exactNote: HTMLElement;
let previewEl: HTMLElement;
let previewRow: HTMLElement | null = null;

/** The code currently on screen, so the share sheet has something to send. */
let liveCode: string | null = null;

/**
 * Opens one panel and closes the rest, hiding the buttons that opened it.
 *
 * Passing null is "back to the resting state", which is the only state where
 * both actions are offered.
 */
function show(panel: HTMLElement | null): void {
    codePanel.classList.toggle('hidden', panel !== codePanel);
    redeemPanel.classList.toggle('hidden', panel !== redeemPanel);
    actions.classList.toggle('hidden', panel !== null);
    fieldError(null);
}

/** The one message that stays: what is wrong with the box in front of you. */
function fieldError(text: string | null): void {
    redeemError.textContent = text ?? '';
    redeemError.classList.toggle('hidden', !text);
}

// ---------------------------------------------------------------------------
// How you appear
// ---------------------------------------------------------------------------

/**
 * Your own row, as the person on the other end will see it.
 *
 * Computed through anchorAsSeen — the same function the relay runs to decide
 * what to send. A preview with its own idea of the rules would eventually
 * reassure somebody about a rule the server is not applying, and this is the
 * one screen where that would be a privacy bug rather than a cosmetic one.
 *
 * Null while the device still has no idea what time it is here, which is a real
 * state on a cold start and worth saying rather than faking.
 */
function previewEntry(): ClockEntry | null {
    const seen = anchorAsSeen(myAnchor(), state.shareExact);
    if (!seen) return null;
    return {
        kind: 'person',
        person: {
            shareId: 'preview',
            name: state.shareName || 'You',
            anchor: seen,
            // Now, so the row never draws itself as stale. It is a preview of a
            // fresh answer; ageing is a fact about a real one.
            updatedAt: Date.now(),
        },
    };
}

function renderPreview(): void {
    const entry = previewEntry();
    if (!entry) {
        previewEl.textContent = '';
        previewRow = null;
        return;
    }
    const row = buildPreviewRow(entry);
    previewEl.replaceChildren(row);
    fillPreviewRow(row, entry);
    previewRow = row;
}

/**
 * Says what a follower is actually shown, in the words of the row they see.
 *
 * The note under the switch describes the CURRENT state rather than what
 * ticking it would do — "they see X" is checkable against the preview directly
 * below it, where "tick to share your zone" would be a promise about a
 * different screen.
 */
export function refreshSharingCard(): void {
    if (!exactNote) return;

    const seen = anchorAsSeen(myAnchor(), state.shareExact);
    exactNote.textContent = !seen
        ? 'Waiting to work out what time it is here.'
        : seen.kind === 'offset'
            ? 'They see how far your clock is from theirs, and nothing about where you are.'
            : 'They see which timezone you are in — a region, never a place.';
    renderPreview();
}

function saveSharePrefs(prefs: { name?: string | null; exact?: boolean }): void {
    setSharePrefs(prefs);
    refreshSharingCard();
    // Both lists show names, so a rename of yours changes what your followers
    // see the next time they look.
    void pushProfile();
}

// ---------------------------------------------------------------------------
// Handing out a code
// ---------------------------------------------------------------------------

async function invite(): Promise<void> {
    if (!state.shareName) {
        myNameInput.focus();
        toast('Put your name in first — it is what they will see.', 'bad');
        return;
    }

    show(codePanel);
    liveCode = null;
    codeEl.textContent = '·····';
    codeNote.textContent = 'Asking the server…';

    const result = await createInvitation(state.shareName);
    if (!result.ok) {
        show(null);
        toast(INVITE_REASONS[result.reason] ?? REASONS.unreachable, 'bad');
        // A cap is only comprehensible beside the list it is a cap on.
        if (result.reason === 'full') void refreshFollowers();
        return;
    }

    liveCode = result.invitation.code;
    // Hyphenated for reading aloud, and only for that: the relay normalises
    // whatever is typed, so nobody has to reproduce the punctuation.
    codeEl.textContent = formatShareCode(liveCode);
    codeNote.textContent = 'Good for 24 hours, and works once.';

    // The account may have been created by the call above, which means the relay
    // has never heard this device's time — and somebody is about to send a code.
    // Waiting for the next five-minute tick is what made the other end sit on
    // "Not shared yet" long enough to look broken.
    void pushMyAnchorNow();
    void refreshFollowers();
}

/**
 * Hands the code to the platform's own share sheet.
 *
 * Both a link and the code in plain text. The link is the whole point — one tap
 * and their app opens on the right screen — but a message that is ONLY a link
 * is useless to somebody who has not installed the app yet, and the code is
 * what they will read back to you over the phone instead.
 *
 * The panel closes afterwards. A code that has been sent has done its job, and
 * leaving it on screen indefinitely turned the card into a noticeboard.
 */
async function sendCode(): Promise<void> {
    if (!liveCode) return;

    const url = `${FOLLOW_LINK_BASE}/${liveCode}`;
    try {
        await Share.share({
            title: 'GeoTime',
            text: `${state.shareName} wants to share their time with you on GeoTime.\n\n`
                + `Tap to follow: ${url}\n\n`
                + `Or open GeoTime, tap "Follow someone" and enter ${formatShareCode(liveCode)}.`,
            url,
            dialogTitle: 'Share your GeoTime code',
        });
        show(null);
        toast('Code sent. It works once, and lasts 24 hours.', 'good');
    } catch {
        // Cancelling the sheet throws, and cancelling is not a failure — it is
        // somebody changing their mind, which deserves silence rather than an
        // error about it.
    }
}

// ---------------------------------------------------------------------------
// Taking one
// ---------------------------------------------------------------------------

async function paste(): Promise<void> {
    try {
        const text = await navigator.clipboard.readText();
        // Whatever they copied might be the whole message rather than the code,
        // so the code is fished out of it rather than demanded on its own.
        const found = /([0-9A-Za-z]{4}-?[0-9A-Za-z]{4})/.exec(text);
        const code = normaliseShareCode(found?.[1] ?? text);
        if (!code) { fieldError('Nothing on the clipboard looks like a code.'); return; }
        codeInput.value = formatShareCode(code);
        fieldError(null);
    } catch {
        fieldError('This device would not let the app read the clipboard.');
    }
}

/**
 * Redeems a code and puts the row on the list.
 *
 * The name comes back with the share, so the row arrives already called
 * something rather than making somebody invent a label before they have seen
 * who it is. Renaming afterwards is what the list below is for, and the label
 * never leaves this device either way.
 */
async function follow(typed: string): Promise<void> {
    const code = typed.trim();
    if (!code) { fieldError('Enter the code they sent you.'); return; }

    fieldError(null);
    const result = await redeemInvitation(code);
    if (!result.ok) {
        // Back into the box for the three reasons that are things to fix here;
        // a full account is not, so it goes past as a toast.
        if (result.reason === 'full') toast(REASONS.full, 'bad');
        else fieldError(REASONS[result.reason] ?? REASONS.unreachable);
        return;
    }

    const name = result.name || 'Someone';
    // Replacing rather than appending, so redeeming a second code from the same
    // person updates the row instead of drawing two for one share.
    persistFollowedPeople([
        ...state.followedPeople.filter((person) => person.shareId !== result.shareId),
        { shareId: result.shareId, name, anchor: null, updatedAt: null },
    ]);

    codeInput.value = '';
    show(null);
    renderFollowing();
    toast(`Following ${name}.`, 'good');

    void catchUp(result.shareId);
}

/**
 * Looks again, a few times, for a row that has no time yet.
 *
 * The sharer pushes their anchor the moment they mint a code, but "the moment"
 * is two round trips away and a code can be redeemed inside it. Rather than
 * leave a new row reading "Not shared yet" until the next five-minute tick,
 * check a few times and stop — the regular sync catches anything slower, and a
 * row that stays empty is a person who genuinely has not shared.
 */
async function catchUp(shareId: string): Promise<void> {
    for (const wait of [0, 1500, 4000]) {
        if (wait) await new Promise((done) => setTimeout(done, wait));
        await refreshFollowing();
        const person = state.followedPeople.find((row) => row.shareId === shareId);
        if (!person || person.anchor) return;
    }
}

// ---------------------------------------------------------------------------
// The two lists
// ---------------------------------------------------------------------------

/** A row in either list: something on the left, one quiet action on the right. */
function listRow(body: Node, action: HTMLElement): HTMLElement {
    const row = document.createElement('li');
    row.className = 'flex items-center justify-between gap-3 text-sm';
    const left = document.createElement('div');
    left.className = 'min-w-0 flex-1';
    left.append(body);
    row.append(left, action);
    return row;
}

function quietButton(label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'shrink-0 text-xs text-gray-500 hover:text-red-400 transition-colors';
    button.textContent = label;
    return button;
}

/**
 * The people you follow, for renaming and for letting go.
 *
 * The label is yours: the relay suggested it and has no further opinion, and
 * "Mum" is a perfectly good thing to call somebody whose account says Matthew.
 * Renaming lives here rather than on the clock row because that row's job is to
 * be read at a glance, and a text field in it would be a trap for a thumb aimed
 * at the map.
 */
function renderFollowing(): void {
    followingEl.classList.toggle('hidden', state.followedPeople.length === 0);
    followingList.replaceChildren(...state.followedPeople.map((person) => {
        const name = document.createElement('input');
        name.type = 'text';
        name.value = person.name;
        name.maxLength = 40;
        name.className = 'w-full bg-transparent border-b border-transparent focus:border-gray-500 '
            + 'text-gray-200 focus:outline-none py-1';
        name.addEventListener('change', () => {
            const label = name.value.trim();
            // An empty label is not a rename, it is a slip. Put it back.
            if (!label) { name.value = person.name; return; }
            persistFollowedPeople(state.followedPeople.map((row) =>
                row.shareId === person.shareId ? { ...row, name: label } : row));
            toast(`Renamed to ${label}.`, 'good');
        });

        const stop = quietButton('Stop');
        stop.addEventListener('click', () => {
            void stopFollowingPerson(person.shareId, person.name);
        });
        return listRow(name, stop);
    }));
}

/**
 * Who can currently read this device's time, and the way to stop each of them.
 *
 * Hidden when the answer is nobody, which for most installs is always. A null
 * answer is unreachable, not empty, and leaves whatever was last drawn
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
        const body = document.createElement('div');

        // A name where somebody has taken the code up, the code itself where
        // nobody has yet. Two lines, like a clock row: what it is, then what it
        // is doing.
        const title = document.createElement('p');
        title.className = code ? 'font-mono tracking-wider text-gray-200' : 'text-gray-200';
        title.textContent = code ? formatShareCode(code) : (invitation.name ?? 'Someone');

        const note = document.createElement('p');
        note.className = 'text-xs text-gray-500';
        note.textContent = text;
        body.append(title, note);

        const stop = quietButton('Stop');
        stop.addEventListener('click', () => { void stopSharing(invitation.shareId); });
        return listRow(body, stop);
    }));
}

/** Ends a share you receive. Local first; see stopFollowing in anchor-sync. */
async function stopFollowingPerson(shareId: string, name: string): Promise<void> {
    await stopFollowing(shareId);
    renderFollowing();
    toast(`Stopped following ${name}.`, 'good');
}

/** Ends one share from the sharing side. The same call the follower's × makes. */
async function stopSharing(shareId: string): Promise<void> {
    // Awaited, unlike the follower's ×. There the row is the thing you wanted
    // gone and it should go with no signal at all. Here the relay IS the state —
    // there is nothing local to remove — so saying "stopped" before it has
    // answered would be a claim this device is not in a position to make, about
    // the one thing somebody most needs told straight.
    if (await revokeShare(shareId)) {
        toast('Stopped. They can no longer see your time.', 'good');
    } else {
        toast('Could not reach the server, so nothing changed. They can still see your time.', 'bad');
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
    const following = state.followedPeople.length;
    const rows = following === 1 ? 'row' : `${following} rows`;
    const warning = following > 0
        ? `Delete your sharing data? Your ${rows} for other people will go, and anybody who can see your time will stop being able to. This cannot be undone.`
        : 'Delete your sharing data? Anybody who can see your time will stop being able to. This cannot be undone.';
    if (!window.confirm(warning)) return;

    if (!await deleteAccount()) {
        toast('Could not reach the server, so nothing was deleted.', 'bad');
        return;
    }

    persistFollowedPeople([]);
    show(null);
    renderFollowing();
    await refreshFollowers();
    toast('Deleted. Nothing about you is left on the server.', 'good');
}

// ---------------------------------------------------------------------------

/**
 * Follows somebody from a link they sent, with no code to type.
 *
 * The link IS a one-time secret that somebody deliberately sent, so it is
 * redeemed rather than confirmed: a "follow this person?" step would be asking
 * whether they meant to tap the thing they just tapped. Exported for main.ts,
 * where the platform's URL events arrive.
 */
export async function followFromLink(code: string): Promise<void> {
    const normalised = normaliseShareCode(code);
    if (!normalised || !card || !sharingAvailable()) return;
    await follow(normalised);
}

export function initPairing(): void {
    card = document.getElementById('sharing-card')!;
    if (!card || !sharingAvailable()) return;

    actions = document.getElementById('sharing-actions')!;
    codePanel = document.getElementById('sharing-code-panel')!;
    codeEl = document.getElementById('sharing-code')!;
    codeNote = document.getElementById('sharing-code-note')!;
    redeemPanel = document.getElementById('sharing-redeem-panel')!;
    codeInput = document.getElementById('sharing-code-input') as HTMLInputElement;
    redeemError = document.getElementById('sharing-redeem-error')!;
    followingEl = document.getElementById('sharing-following')!;
    followingList = document.getElementById('sharing-following-list')!;
    followersEl = document.getElementById('sharing-followers')!;
    followerList = document.getElementById('sharing-follower-list')!;
    deleteBtn = document.getElementById('sharing-delete')!;
    myNameInput = document.getElementById('sharing-my-name') as HTMLInputElement;
    exactBox = document.getElementById('sharing-exact') as HTMLInputElement;
    exactNote = document.getElementById('sharing-exact-note')!;
    previewEl = document.getElementById('sharing-preview')!;

    myNameInput.value = state.shareName ?? '';
    exactBox.checked = state.shareExact;
    // `change` rather than `input`: a half-typed name is not worth a request,
    // and this fires on blur and on Enter, which is when somebody has finished.
    myNameInput.addEventListener('change', () => saveSharePrefs({ name: myNameInput.value }));
    exactBox.addEventListener('change', () => saveSharePrefs({ exact: exactBox.checked }));

    card.classList.remove('hidden');
    show(null);
    refreshSharingCard();
    renderFollowing();
    void refreshFollowers();

    document.getElementById('sharing-invite')!.addEventListener('click', () => { void invite(); });
    document.getElementById('sharing-redeem')!.addEventListener('click', () => {
        show(redeemPanel);
        codeInput.focus();
    });
    document.getElementById('sharing-send')!.addEventListener('click', () => { void sendCode(); });
    document.getElementById('sharing-code-done')!.addEventListener('click', () => show(null));
    document.getElementById('sharing-paste')!.addEventListener('click', () => { void paste(); });
    document.getElementById('sharing-confirm')!
        .addEventListener('click', () => { void follow(codeInput.value); });
    document.getElementById('sharing-redeem-cancel')!.addEventListener('click', () => {
        codeInput.value = '';
        show(null);
    });
    deleteBtn.addEventListener('click', () => { void deleteEverything(); });

    codeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void follow(codeInput.value); }
    });

    // The preview is a clock and moves when the other clocks do, rather than
    // running an interval of its own — see onClockTick.
    onClockTick(() => { if (previewRow) fillPreviewRow(previewRow, previewEntry()); });

    // The same events anchor-sync watches, for the same reason: this card
    // describes what those events change.
    document.addEventListener('aboardshipchanged', refreshSharingCard);
    document.addEventListener('shipclockschanged', refreshSharingCard);
    document.addEventListener('gpstimezonefound', refreshSharingCard);
    document.addEventListener('followedpeoplechanged', renderFollowing);

    // Somebody may have redeemed a code since this app was last looked at, and
    // the sharer should see who without having to mint another one.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void refreshFollowers();
    });
}
