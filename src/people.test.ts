import test from 'node:test';
import assert from 'node:assert/strict';

import {
    describeAge,
    mergeFollowed,
    migrateFollowedPeople,
    personSubLabel,
    type FollowedPerson,
} from './people';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_788_800_000_000;

const dad = (over: Partial<FollowedPerson> = {}): FollowedPerson => ({
    shareId: 'share-1',
    name: 'Dad',
    anchor: { kind: 'zone', tz: 'America/Vancouver', place: 'Nelson' },
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
    await t.test('where they are, while the answer is fresh', () => {
        assert.equal(personSubLabel(dad(), 'Nelson', NOW), 'Nelson');
    });

    await t.test('and how old it is once it is not', () => {
        const stale = dad({ updatedAt: NOW - 3 * DAY });
        assert.equal(personSubLabel(stale, 'Nelson', NOW), 'Nelson · 3 days ago');
    });

    await t.test('says so when they have never shared', () => {
        // A pairing that worked but whose other end has not opened their app is
        // a real state, and a row that says so beats a row that is missing.
        assert.equal(personSubLabel(dad({ anchor: null, updatedAt: null }), null, NOW),
                     'Not shared yet');
    });

    await t.test('is never empty, however old — a row is never hidden for age', () => {
        for (const age of [0, HOUR, DAY, 30 * DAY, 400 * DAY]) {
            const line = personSubLabel(dad({ updatedAt: NOW - age }), 'Nelson', NOW);
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

    await t.test('an anchor that has gone missing leaves the last one standing', () => {
        // The relay saying nothing about somebody is not the relay saying they
        // have no time. Better an old answer, ageing visibly, than none.
        const { people } = mergeFollowed([dad()], incoming({ anchor: null, updatedAt: null }));
        assert.deepEqual(people[0].anchor, dad().anchor);
        assert.equal(people[0].updatedAt, dad().updatedAt);
    });
});
