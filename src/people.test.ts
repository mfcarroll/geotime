import test from 'node:test';
import assert from 'node:assert/strict';

import {
    anchorForWidget,
    describeAge,
    describeInvitation,
    mergeFollowed,
    migrateFollowedPeople,
    personSubLabel,
    type FollowedPerson,
} from './people';
import type { Anchor } from './anchor';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_788_800_000_000;

const dad = (over: Partial<FollowedPerson> = {}): FollowedPerson => ({
    shareId: 'share-1',
    name: 'Dad',
    anchor: { kind: 'zone', tz: 'America/Vancouver' },
    updatedAt: NOW - HOUR,
    ...over,
});

test('the followed list, coming back off disk', async (t) => {
    await t.test('survives a round trip', () => {
        assert.deepEqual(migrateFollowedPeople([dad()]), [dad()]);
    });

    await t.test('keeps the row when only the anchor is unusable', () => {
        // You still know you follow them. Losing the whole row because their
        // last known time went bad would be the worse of the two failures.
        const [person] = migrateFollowedPeople([dad({
            anchor: { kind: 'zone', tz: 'America/Atlantis' } as never,
        })]);
        assert.equal(person.name, 'Dad');
        assert.equal(person.anchor, null);
        assert.equal(person.updatedAt, null, 'and the stamp goes with it');
    });

    await t.test('drops a row with nothing to call it', () => {
        assert.deepEqual(migrateFollowedPeople([dad({ name: '   ' })]), []);
        assert.deepEqual(migrateFollowedPeople([dad({ shareId: '' })]), []);
    });

    await t.test('keeps one row per share, first one winning', () => {
        const rows = migrateFollowedPeople([dad(), dad({ name: 'Father' })]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, 'Dad');
    });

    await t.test('junk is not an error', () => {
        assert.deepEqual(migrateFollowedPeople(null), []);
        assert.deepEqual(migrateFollowedPeople([null, 42, 'Dad']), []);
    });
});

test('what the row says underneath', async (t) => {
    await t.test('what the anchor says, while the answer is fresh', () => {
        assert.equal(personSubLabel(dad(), 'Timezone: Vancouver', NOW), 'Timezone: Vancouver');
    });

    await t.test('and how old it is once it is not', () => {
        const stale = dad({ updatedAt: NOW - 3 * DAY });
        assert.equal(personSubLabel(stale, 'Timezone: Vancouver', NOW),
                     'Timezone: Vancouver · 3 days ago');
    });

    await t.test('says so when they have never shared', () => {
        // A pairing that worked but whose other end has not opened their app is
        // a real state, and a row that says so beats a row that is missing.
        assert.equal(personSubLabel(dad({ anchor: null, updatedAt: null }), null, NOW),
                     'Not shared yet');
    });

    await t.test('is never empty, however old — a row is never hidden for age', () => {
        for (const age of [0, HOUR, DAY, 30 * DAY, 400 * DAY]) {
            const line = personSubLabel(dad({ updatedAt: NOW - age }), 'Timezone: Vancouver', NOW);
            assert.ok(line.length > 0, `${age}ms gave an empty line`);
        }
    });
});

test('how long ago, in terms that are honest', async (t) => {
    // Coarse on purpose: the relay only hears when a device has signal, so
    // "51 hours ago" would imply a precision nobody has.
    await t.test('hours, then yesterday, then days, then weeks', () => {
        assert.equal(describeAge(2 * HOUR), '2 hours ago');
        assert.equal(describeAge(25 * HOUR), 'yesterday');
        assert.equal(describeAge(3 * DAY), '3 days ago');
        assert.equal(describeAge(21 * DAY), '3 weeks ago');
    });

    await t.test('never says "0 hours ago"', () => {
        assert.equal(describeAge(0), '1 hours ago');
        assert.equal(describeAge(60_000), '1 hours ago');
    });
});

test('folding in what the relay says', async (t) => {
    const incoming = (over = {}) => ([{
        shareId: 'share-1',
        anchor: { kind: 'ship' as const, offsetMinutes: -240, name: 'Wonder of the Seas' },
        updatedAt: NOW,
        ...over,
    }]);

    await t.test('the name is yours and the anchor is theirs', () => {
        const { people } = mergeFollowed([dad()], incoming());
        assert.equal(people[0].name, 'Dad', 'the relay has never heard of this');
        assert.deepEqual(people[0].anchor,
                         { kind: 'ship', offsetMinutes: -240, name: 'Wonder of the Seas' });
        assert.equal(people[0].updatedAt, NOW);
    });

    await t.test('a share the relay no longer lists is gone', () => {
        // Revoked from either end. The list follows the relay on who, and only
        // on who.
        const { people } = mergeFollowed([dad()], []);
        assert.deepEqual(people, []);
    });

    await t.test('a share with nobody named yet is reported, not invented', () => {
        const { people, unnamed } = mergeFollowed([], incoming());
        assert.deepEqual(people, []);
        assert.deepEqual(unnamed, ['share-1']);
    });

    await t.test('a share we have asked to end is neither kept nor reported', () => {
        // The removal already happened locally; the relay just has not been told
        // yet, or was told and did not hear. Reporting it as unnamed is what
        // brought the row back calling itself "Someone".
        const { people, unnamed } = mergeFollowed([], incoming(), new Set(['share-1']));
        assert.deepEqual(people, []);
        assert.deepEqual(unnamed, [], 'and not resurrected under a made-up name');
    });

    await t.test('an anchor that has gone missing leaves the last one standing', () => {
        // The relay saying nothing about somebody is not the relay saying they
        // have no time. Better an old answer, ageing visibly, than none.
        const { people } = mergeFollowed([dad()], incoming({ anchor: null, updatedAt: null }));
        assert.deepEqual(people[0].anchor, dad().anchor);
        assert.equal(people[0].updatedAt, dad().updatedAt);
    });
});

test('a code you handed out, from your side of it', async (t) => {
    const invitation = (over = {}) => ({
        code: null as string | null,
        createdAt: NOW - 3 * DAY,
        redeemedAt: null as number | null,
        ...over,
    });

    await t.test('still live, and says so with the code itself', () => {
        // Shown again rather than reminted: somebody who lost the slip of paper
        // should not end up with two live codes for one intent.
        const { text, code } = describeInvitation(invitation({ code: 'K7M29QRT' }), NOW);
        assert.equal(code, 'K7M29QRT');
        assert.match(text, /waiting/i);
    });

    await t.test('taken up, and ages like everything else', () => {
        const { text, code } = describeInvitation(
            invitation({ redeemedAt: NOW - DAY }), NOW);
        assert.equal(code, null, 'a redeemed code is spent and must never be shown again');
        assert.equal(text, 'Following you · shared 3 days ago');
    });

    await t.test('says nothing about WHO, because nothing about who comes back', () => {
        // The asymmetry is the feature: you name the people you follow, and
        // the people who follow you stay anonymous to you.
        const { text } = describeInvitation(invitation({ redeemedAt: NOW }), NOW);
        assert.doesNotMatch(text, /[A-Z][a-z]+ [A-Z]/, 'no name can appear here');
    });

    await t.test('expired with nobody using it is its own state, not a live one', () => {
        const { text, code } = describeInvitation(invitation(), NOW);
        assert.equal(code, null);
        assert.match(text, /expired/i);
    });
});

test('a followed person, on the way to a home-screen widget', async (t) => {
    await t.test('a zone sends its id and no offset', () => {
        // The phone works the offset out from the id, which is the whole
        // reason an id is what travels.
        assert.deepEqual(anchorForWidget({ kind: 'zone', tz: 'Asia/Tokyo' }),
                         { tz: 'Asia/Tokyo', offsetMinutes: 0, short: '' });
    });

    await t.test('a ship sends her offset and her short name', () => {
        assert.deepEqual(
            anchorForWidget({ kind: 'ship', offsetMinutes: -240, name: 'Wonder of the Seas', short: 'Wonder' }),
            { tz: '', offsetMinutes: -240, short: 'Wonder' });
    });

    await t.test('an OFFSET sends its offset — not zero, which is UTC', () => {
        // The regression this test exists for. Two independent ternaries —
        // "zone ? tz : ''" and "ship ? offset : 0" — were correct until a third
        // kind of anchor matched neither, fell through both, and put every
        // followed person on the widget at UTC. In the default sharing mode.
        assert.deepEqual(anchorForWidget({ kind: 'offset', offsetMinutes: 540 }),
                         { tz: '', offsetMinutes: 540, short: '' });
    });

    await t.test('no anchor of any kind arrives as a bare UTC clock', () => {
        // Stated as a property rather than three cases, so a fourth kind that
        // forgets to carry its clock fails here as well as at the compiler.
        const anchors: Anchor[] = [
            { kind: 'zone', tz: 'Europe/London' },
            { kind: 'ship', offsetMinutes: 330, name: 'Anthem of the Seas' },
            { kind: 'offset', offsetMinutes: -420 },
        ];
        for (const anchor of anchors) {
            const { tz, offsetMinutes } = anchorForWidget(anchor);
            assert.ok(tz !== '' || offsetMinutes !== 0,
                      `${anchor.kind} would be drawn at UTC`);
        }
    });
});
