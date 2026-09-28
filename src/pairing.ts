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
// MORE THAN ONE DEVICE. One person may read their people on a phone, a tablet
// and a browser on a computer. A new one is linked from one that already is: it
// types a code that device shows, and that device then asks whether the one
// that took it is really yours. Everything is shared across them except the
// time itself, which only one device — the primary — reports, because two in
// two places would take turns being where you are.
//
// A browser joins only by being linked. It cannot start an account or share
// anybody's time: it knows where the computer is, not where the person is, and
// the page's own storage is a weaker home for a credential than an app's. What
// it is for is seeing your family's times on the screen in front of you.

import { Share } from '@capacitor/share';

import { anchorAsSeen } from './anchor';
import { findShareCode, formatShareCode, normaliseShareCode, shapeCodeField } from './share-code';
import { forgetCredential, rememberPrimary, storedToken } from './account';
import {
    approveDevice,
    claimLinkCode,
    createInvitation,
    createLinkCode,
    deleteAccount,
    fetchInvitations,
    fetchMe,
    makePrimary,
    redeemInvitation,
    removeDevice,
    revokeShare,
    type LinkedDevice,
} from './anchor-share';
import {
    currentMe,
    isBrowser,
    pushMyAnchorNow,
    pushProfile,
    refreshFollowing,
    sharedAnchor,
    stopFollowing,
    syncNow,
} from './anchor-sync';
import type { ClockEntry } from './clocks';
import { describeAge, describeInvitation } from './people';
import { persistFollowedPeople, setSharePrefs, state } from './state';
import { onClockTick } from './time';
import { toast } from './toast';
import { buildPreviewRow, fillPreviewRow } from './map';

/** Where a follow link points. See the Worker route and the .well-known files. */
const FOLLOW_LINK_BASE = 'https://geotime.app/f';

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

const LINK_REASONS: Record<string, string> = {
    invalid: 'That code is not one we know. Link codes last 10 minutes and work once.',
    full: 'That account already has as many devices as it can. Remove one from it first.',
    unreachable: REASONS.unreachable,
};

/** How often a panel waiting on the other device looks again. */
const WATCH_MS = 2000;
/** How long a link code, and the claim it makes, can be waited on. As at the relay. */
const LINK_TTL_MS = 10 * 60 * 1000;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
let introEl: HTMLElement;
let profileEl: HTMLElement;
let joinButton: HTMLButtonElement;
let joinPanel: HTMLElement;
let joinStatus: HTMLElement;
let joinForm: HTMLElement;
let joinInput: HTMLInputElement;
let joinError: HTMLElement;
let joinConfirm: HTMLElement;
let linkPanel: HTMLElement;
let linkWaiting: HTMLElement;
let linkCodeEl: HTMLElement;
let linkNote: HTMLElement;
let linkAsk: HTMLElement;
let linkQuestion: HTMLElement;
let linkCancel: HTMLElement;
let devicesEl: HTMLElement;
let deviceList: HTMLElement;
let noPrimaryEl: HTMLElement;

/** The panel open now, if any. See show. */
let openPanel: HTMLElement | null = null;
/** Bumped to call off whichever wait on the other device is running. */
let watchGeneration = 0;
/** A claim this device made, waiting for its owner's other device to say yes. */
let joining = false;
/** The claim on screen for approval. */
let askingAbout: LinkedDevice | null = null;

/** The code currently on screen, so the share sheet has something to send. */
let liveCode: string | null = null;

/**
 * Opens one panel and closes the rest, hiding the buttons that opened it.
 *
 * Passing null is "back to the resting state", which is the only state where
 * both actions are offered.
 */
function show(panel: HTMLElement | null): void {
    openPanel = panel;
    for (const each of [codePanel, redeemPanel, joinPanel, linkPanel]) {
        each.classList.toggle('hidden', panel !== each);
    }
    fieldError(null);
    joinFieldError(null);
    renderMode();
}

/**
 * What the card offers, given whether this device is linked and what it is.
 *
 * Three states: not linked, waiting to be approved, linked. A browser that is
 * not linked sees only the way in, because it can do nothing else; an app that
 * is not linked sees everything, with the way in as a quiet line for the few
 * who have a second device.
 */
function renderMode(): void {
    const token = storedToken();
    const standing = currentMe();
    const linked = !!token && standing?.status !== 'pending';
    const browserOutside = isBrowser() && !linked;

    introEl.textContent = browserOutside
        ? 'See the people you follow on this computer. Link it to GeoTime on your phone.'
        : 'Let someone see what time it is for you — never where you are.';
    profileEl.classList.toggle('hidden', browserOutside);
    actions.classList.toggle('hidden', openPanel !== null || browserOutside);

    joinButton.textContent = isBrowser()
        ? 'Link this browser to GeoTime on your phone'
        : 'Link to GeoTime on your other device';
    joinButton.className = isBrowser()
        ? 'w-full mt-5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors'
        : 'w-full mt-3 text-sm text-gray-400 hover:text-white transition-colors';
    if (openPanel !== null || !!token) joinButton.classList.add('hidden');

    renderDevices();
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
    const seen = anchorAsSeen(sharedAnchor(), state.shareExact);
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

    const seen = anchorAsSeen(sharedAnchor(), state.shareExact);
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
    // "Not shared yet" long enough to look broken. The profile goes with it for
    // the same reason: the account was created with a name and nothing else, so
    // until this lands the relay treats the exact switch as off, whatever it
    // says here. Then a whole sync, which also learns this device's standing:
    // without it, "Your devices" stayed hidden until the next tick, which is
    // exactly when somebody who just started sharing looks for it.
    void (async () => {
        await pushMyAnchorNow();
        await syncNow();
    })();
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
    const text = `${state.shareName} wants to share their time with you on GeoTime.\n\n`
        + `Tap to follow: ${url}\n\n`
        + `Or open GeoTime, tap "Follow someone" and enter ${formatShareCode(liveCode)}.`;

    // A browser on a computer usually has no share sheet. The message goes on
    // the clipboard instead, which is what somebody would have done by hand.
    const { value: canShare } = await Share.canShare().catch(() => ({ value: false }));
    if (!canShare) {
        try {
            await navigator.clipboard.writeText(text);
            show(null);
            toast('Copied. Paste it into a message to them.', 'good');
        } catch {
            toast('This browser would not let the app copy it. Read them the code instead.', 'bad');
        }
        return;
    }

    try {
        await Share.share({ title: 'GeoTime', text, url, dialogTitle: 'Share your GeoTime code' });
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
        const code = findShareCode(text);
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

    // Redeeming may have created this device's account, and with no name on it:
    // the sharer's list of who can see their time would say "Someone". A whole
    // sync sends the profile and learns this device's standing — see invite.
    void syncNow();
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
    if (!storedToken() || currentMe()?.status === 'pending') {
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
    const standing = currentMe();
    const others = standing?.status === 'active'
        ? standing.devices.filter((device) => !device.pending && device.deviceId !== standing.deviceId).length
        : 0;
    // Deleting is about the person, so it reaches every device they linked.
    const everywhere = others > 0
        ? ` It goes from your ${others === 1 ? 'other device' : `${others} other devices`} too.`
        : '';
    const warning = following > 0
        ? `Delete your sharing data? Your ${rows} for other people will go, and anybody who can see your time will stop being able to.${everywhere} This cannot be undone.`
        : `Delete your sharing data? Anybody who can see your time will stop being able to.${everywhere} This cannot be undone.`;
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
// Linking another device — from one already linked
// ---------------------------------------------------------------------------

/**
 * Shows a code for the new device, then waits for it to be claimed and asks
 * whether the device that claimed it is yours.
 *
 * The asking is the point. A link code hands over more than a share code does,
 * and reading one out to the wrong person should get them a request that can
 * be refused, not the account. Only while this panel is open: nobody is asked
 * about a device they did not just try to link.
 */
async function startLink(): Promise<void> {
    show(linkPanel);
    linkWaiting.classList.remove('hidden');
    linkAsk.classList.add('hidden');
    linkCancel.classList.remove('hidden');
    linkCodeEl.textContent = '·····';
    linkNote.textContent = 'Asking the server…';

    const result = await createLinkCode();
    if (openPanel !== linkPanel) return;
    if (!result.ok) {
        show(null);
        toast(result.reason === 'full'
            ? 'This account already has as many devices as it can. Remove one below first.'
            : REASONS.unreachable, 'bad');
        return;
    }

    linkCodeEl.textContent = formatShareCode(result.code);
    linkNote.textContent = 'On the other device, open Sharing and tap “Link”. Good for 10 minutes, once.';

    const generation = ++watchGeneration;
    while (generation === watchGeneration && Date.now() < result.expiresAt) {
        await wait(WATCH_MS);
        if (generation !== watchGeneration) return;
        const answer = await fetchMe();
        const claim = answer?.status === 'active' ? answer.devices.find((device) => device.pending) : undefined;
        if (claim) {
            askAbout(claim);
            return;
        }
    }
    if (generation === watchGeneration) {
        linkNote.textContent = 'That code has run out. Cancel, and link again for a new one.';
    }
}

function askAbout(claim: LinkedDevice): void {
    askingAbout = claim;
    linkWaiting.classList.add('hidden');
    linkAsk.classList.remove('hidden');
    // "Don't link" is the way out now, and says what it does.
    linkCancel.classList.add('hidden');
    linkQuestion.textContent = `Link ${claim.label ?? 'a new device'}?`;
}

async function answerClaim(yes: boolean): Promise<void> {
    const claim = askingAbout;
    if (!claim) return;
    askingAbout = null;
    const label = claim.label ?? 'the new device';

    if (yes) {
        if (!await approveDevice(claim.deviceId)) {
            toast('Could not reach the server, or it waited too long. Try linking again.', 'bad');
            show(null);
            return;
        }
        show(null);
        toast(`Linked ${label}.`, 'good');
    } else {
        // Turning it down removes it outright; it never had access to anything.
        await removeDevice(claim.deviceId);
        show(null);
        toast(`Not linked. ${label} has no access to anything.`, 'good');
    }
    await syncNow();
}

// ---------------------------------------------------------------------------
// Linking this device — to one already linked
// ---------------------------------------------------------------------------

function joinFieldError(text: string | null): void {
    joinError.textContent = text ?? '';
    joinError.classList.toggle('hidden', !text);
}

function startJoin(): void {
    show(joinPanel);
    joinForm.classList.remove('hidden');
    joinConfirm.classList.remove('hidden');
    joinStatus.textContent = 'On your other device, open Sharing, tap “Link another device”, and enter the code it shows here.';
    joinInput.value = '';
    joinInput.focus();
}

async function confirmJoin(): Promise<void> {
    const code = joinInput.value.trim();
    if (!code) { joinFieldError('Enter the code your other device is showing.'); return; }

    joinFieldError(null);
    const result = await claimLinkCode(code);
    if (!result.ok) {
        joinFieldError(LINK_REASONS[result.reason] ?? REASONS.unreachable);
        return;
    }
    void waitForApproval();
}

/**
 * Waits for the other device to say yes. Resumed on launch if the app was
 * closed while waiting — see the anchorsynced listener in initPairing.
 */
async function waitForApproval(): Promise<void> {
    if (openPanel !== joinPanel) show(joinPanel);
    joinForm.classList.add('hidden');
    joinConfirm.classList.add('hidden');
    joinStatus.textContent = 'Now say yes on your other device. This carries on by itself.';
    joining = true;

    const generation = ++watchGeneration;
    const deadline = Date.now() + LINK_TTL_MS;
    while (generation === watchGeneration && Date.now() < deadline) {
        await wait(WATCH_MS);
        if (generation !== watchGeneration) return;
        const answer = await fetchMe();
        // Turned down, or lapsed: the relay no longer knows this token, and
        // signedOutIf has already forgotten it.
        if (!storedToken()) {
            joining = false;
            show(null);
            toast('Not linked. It was turned down, or the ten minutes ran out.', 'bad');
            return;
        }
        if (answer?.status === 'active') {
            joining = false;
            show(null);
            toast('Linked. Your people are on their way.', 'good');
            await syncNow();
            return;
        }
    }
    if (generation === watchGeneration) {
        joining = false;
        forgetCredential();
        show(null);
        toast('Not linked. The ten minutes ran out — start again from your other device.', 'bad');
    }
}

function cancelJoin(): void {
    watchGeneration++;
    // A claim still waiting is abandoned here; the relay lets it lapse.
    if (joining) forgetCredential();
    joining = false;
    show(null);
}

// ---------------------------------------------------------------------------
// Your devices
// ---------------------------------------------------------------------------

const PLATFORM_NAMES: Record<LinkedDevice['platform'], string> = {
    ios: 'An iPhone or iPad', android: 'An Android device', web: 'A browser',
};

function renderDevices(): void {
    const standing = currentMe();
    if (!storedToken() || standing?.status !== 'active') {
        devicesEl.classList.add('hidden');
        return;
    }
    devicesEl.classList.remove('hidden');

    const linked = standing.devices.filter((device) => !device.pending);
    noPrimaryEl.classList.toggle('hidden', linked.some((device) => device.primary));
    deviceList.replaceChildren(...linked.map((device) => {
        const isThis = device.deviceId === standing.deviceId;
        const label = device.label ?? PLATFORM_NAMES[device.platform];

        const body = document.createElement('div');
        const title = document.createElement('p');
        title.className = 'text-gray-200';
        title.textContent = isThis ? `${label} (this one)` : label;
        const note = document.createElement('p');
        note.className = 'text-xs text-gray-500';
        note.textContent = device.primary
            ? 'Shares your time'
            : isThis ? 'Shows your people' : `Last used ${describeAge(Date.now() - device.lastSeenAt)}`;
        body.append(title, note);

        const buttons = document.createElement('div');
        buttons.className = 'flex shrink-0 gap-3';
        // Never a browser: see makePrimary in the relay.
        if (!device.primary && device.platform !== 'web') {
            const share = document.createElement('button');
            share.className = 'text-xs text-blue-400 hover:text-blue-300 transition-colors';
            share.textContent = 'Share from this';
            share.addEventListener('click', () => { void shareFrom(device, isThis, label); });
            buttons.append(share);
        }
        // Not on the only one: the relay would refuse, since that would leave an
        // account nothing can reach. Leaving entirely is "Delete my sharing data".
        if (linked.length > 1) {
            const remove = quietButton(isThis ? 'Unlink' : 'Remove');
            remove.addEventListener('click', () => { void removeFromAccount(device, isThis, label); });
            buttons.append(remove);
        }
        return listRow(body, buttons);
    }));
}

/** Moves "shares your time" to another device, say when the phone is replaced. */
async function shareFrom(device: LinkedDevice, isThis: boolean, label: string): Promise<void> {
    if (!await makePrimary(device.deviceId)) {
        toast(REASONS.unreachable, 'bad');
        return;
    }
    if (isThis) {
        rememberPrimary(true);
        // Now, rather than on the next tick: until it lands, followers are
        // still being told wherever the last primary was.
        void pushMyAnchorNow();
    }
    toast(isThis ? 'This device now shares your time.' : `${label} now shares your time.`, 'good');
    await syncNow();
}

async function removeFromAccount(device: LinkedDevice, isThis: boolean, label: string): Promise<void> {
    const question = isThis
        ? 'Unlink this device? It will stop showing your people. Your other devices keep them.'
        : `Remove ${label}? It will stop showing your people.`
            + (device.primary ? ' It shares your time now, so until you choose another device, the people who follow you will see it getting older.' : '');
    if (!window.confirm(question)) return;

    const result = await removeDevice(device.deviceId);
    if (result === 'last') {
        toast('This is your only device. To leave entirely, delete your sharing data below.', 'bad');
        return;
    }
    if (result === 'failed') {
        toast('Could not reach the server, so nothing changed.', 'bad');
        return;
    }
    if (isThis) {
        forgetCredential();
        persistFollowedPeople([]);
        toast('Unlinked. This device no longer shows your people.', 'good');
    } else {
        toast(`Removed ${label}.`, 'good');
    }
    await syncNow();
    renderFollowing();
    renderMode();
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
    // Follow links open the app; a browser never gets one to handle.
    if (!normalised || !card || isBrowser()) return;
    await follow(normalised);
}

export function initPairing(): void {
    card = document.getElementById('sharing-card')!;
    if (!card) return;

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
    introEl = document.getElementById('sharing-intro')!;
    profileEl = document.getElementById('sharing-profile')!;
    joinButton = document.getElementById('sharing-join') as HTMLButtonElement;
    joinPanel = document.getElementById('sharing-join-panel')!;
    joinStatus = document.getElementById('sharing-join-status')!;
    joinForm = document.getElementById('sharing-join-form')!;
    joinInput = document.getElementById('sharing-join-input') as HTMLInputElement;
    joinError = document.getElementById('sharing-join-error')!;
    joinConfirm = document.getElementById('sharing-join-confirm')!;
    linkPanel = document.getElementById('sharing-link-panel')!;
    linkWaiting = document.getElementById('sharing-link-waiting')!;
    linkCodeEl = document.getElementById('sharing-link-code')!;
    linkNote = document.getElementById('sharing-link-note')!;
    linkAsk = document.getElementById('sharing-link-ask')!;
    linkQuestion = document.getElementById('sharing-link-question')!;
    linkCancel = document.getElementById('sharing-link-cancel')!;
    devicesEl = document.getElementById('sharing-devices')!;
    deviceList = document.getElementById('sharing-device-list')!;
    noPrimaryEl = document.getElementById('sharing-no-primary')!;

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

    joinButton.addEventListener('click', startJoin);
    joinConfirm.addEventListener('click', () => { void confirmJoin(); });
    document.getElementById('sharing-join-cancel')!.addEventListener('click', cancelJoin);
    joinInput.addEventListener('input', (event) => {
        if ((event as InputEvent).isComposing) return;
        const shaped = shapeCodeField(joinInput.value);
        if (shaped !== joinInput.value) joinInput.value = shaped;
    });
    joinInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void confirmJoin(); }
    });
    document.getElementById('sharing-link-device')!.addEventListener('click', () => { void startLink(); });
    document.getElementById('sharing-link-yes')!.addEventListener('click', () => { void answerClaim(true); });
    document.getElementById('sharing-link-no')!.addEventListener('click', () => { void answerClaim(false); });
    linkCancel.addEventListener('click', () => {
        watchGeneration++;
        askingAbout = null;
        show(null);
    });

    // Shaped as it is typed or pasted into, rather than only checked on Follow:
    // see shapeCodeField. Not mid-composition, which would fight the keyboard.
    codeInput.addEventListener('input', (event) => {
        if ((event as InputEvent).isComposing) return;
        const shaped = shapeCodeField(codeInput.value);
        if (shaped !== codeInput.value) codeInput.value = shaped;
    });
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

    // Somebody may have redeemed a code, or deleted their data, since this list
    // was drawn. It refreshed only on returning to the app, so with the app left
    // open a follower who had gone stayed listed. Now on every sync — the same
    // beat as the people you follow: returning to the app, and the five-minute
    // tick.
    document.addEventListener('anchorsynced', () => {
        void refreshFollowers();
        // Closed while waiting to be approved: carry on waiting.
        if (currentMe()?.status === 'pending' && !joining) void waitForApproval();
        renderMode();
        refreshSharingCard();
    });

    // Another device changed the name or the switch. See adoptProfile.
    document.addEventListener('shareprefschanged', () => {
        myNameInput.value = state.shareName ?? '';
        exactBox.checked = state.shareExact;
        refreshSharingCard();
    });

    // Removed from another device, or the account deleted elsewhere. A claim
    // turned down says so in its own words; see waitForApproval.
    document.addEventListener('anchorsignedout', () => {
        if (!joining) toast('This device is no longer linked to your account.', 'bad');
        show(null);
        renderFollowing();
        void refreshFollowers();
    });
}
