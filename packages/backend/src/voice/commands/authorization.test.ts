import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControlAccess, type ControlGroupSource } from './authorization.js';
import { parseControlGroups, parseControlGroupsUpdate } from '../../utils/app-settings.js';

const GROUPS = [
  { id: 7, name: 'Newcomer' },
  { id: 999, name: 'Music Bot Controllers' },
  { id: 101, name: 'Server Admin' },
  { id: 102, name: 'Moderators' },
];

function source(members: Record<number, number[]>, calls = { groupList: 0, client: 0 }): ControlGroupSource & { calls: typeof calls } {
  return {
    calls,
    clientGroups: async (_c, _s, clid) => { calls.client++; if (!(clid in members)) throw new Error('client not found'); return members[clid]; },
    serverGroups: async () => { calls.groupList++; return GROUPS; },
  };
}

const set = (...groups: string[]) => async () => groups;
const allowed = async (a: ControlAccess, clid: number) => (await a.check(1, 1, clid)).allowed;

describe('control group', () => {
  it('reads the stored setting, ignoring damaged values', () => {
    assert.deepEqual(parseControlGroups(undefined), []);
    assert.deepEqual(parseControlGroups('not json'), []);
    assert.deepEqual(parseControlGroups('{"a":1}'), []);
    assert.deepEqual(parseControlGroups('[" Music Bot Controllers ", 7, "", "999"]'), ['Music Bot Controllers', '999']);
  });

  it('validates what the panel sends', () => {
    assert.deepEqual(parseControlGroupsUpdate([' A ', 'a', '', 'B']), { ok: true, groups: ['A', 'B'] });
    assert.deepEqual(parseControlGroupsUpdate([]), { ok: true, groups: [] });
    assert.equal(parseControlGroupsUpdate('A').ok, false);
    assert.equal(parseControlGroupsUpdate([1]).ok, false);
    assert.equal(parseControlGroupsUpdate(['x'.repeat(101)]).ok, false);
    assert.equal(parseControlGroupsUpdate(Array.from({ length: 21 }, (_, i) => `g${i}`)).ok, false);
  });

  it('lets everybody in when no group is configured, without asking TeamSpeak', async () => {
    const src = source({});
    const access = new ControlAccess(set(), src);
    const decision = await access.check(1, 1, 99);
    assert.deepEqual([decision.restricted, decision.allowed], [false, true]);
    assert.equal(src.calls.client, 0);
  });

  it('allows a member and refuses everybody else', async () => {
    const access = new ControlAccess(set('Music Bot Controllers'), source({ 2: [7, 999], 3: [7], 4: [101] }));
    assert.equal(await allowed(access, 2), true);
    assert.equal(await allowed(access, 3), false);
    assert.equal(await allowed(access, 4), false, 'even a server admin needs the group');
  });

  it('matches the group name without regard to case, and also accepts an id', async () => {
    assert.equal(await allowed(new ControlAccess(set('music bot controllers'), source({ 2: [999] })), 2), true);
    assert.equal(await allowed(new ControlAccess(set('999'), source({ 2: [999] })), 2), true);
    assert.equal(await allowed(new ControlAccess(set('999'), source({ 2: [7] })), 2), false);
  });

  it('accepts a member of any one of several groups', async () => {
    const access = new ControlAccess(set('Music Bot Controllers', 'Moderators'), source({ 2: [999], 3: [102], 4: [7] }), undefined);
    assert.equal(await allowed(access, 2), true);
    assert.equal(await allowed(new ControlAccess(set('Music Bot Controllers', '102'), source({ 3: [102] })), 3), true);
    assert.equal(await allowed(access, 4), false);
  });

  it('refuses everybody when the configured group does not exist', async () => {
    const access = new ControlAccess(set('Missing Group'), source({ 2: [7, 999, 101] }));
    assert.equal(await allowed(access, 2), false);
  });

  it('refuses when TeamSpeak cannot be asked', async () => {
    const access = new ControlAccess(set('Music Bot Controllers'), source({}));
    assert.equal(await allowed(access, 55), false);
    const down: ControlGroupSource = { clientGroups: async () => { throw new Error('unreachable'); }, serverGroups: async () => GROUPS };
    assert.equal(await allowed(new ControlAccess(set('Music Bot Controllers'), down), 2), false);
  });

  it('refuses when the setting itself cannot be read', async () => {
    const access = new ControlAccess(async () => { throw new Error('database locked'); }, source({ 2: [999] }));
    const decision = await access.check(1, 1, 2);
    assert.deepEqual([decision.restricted, decision.allowed], [true, false]);
  });

  it('follows an edit of the setting at once, with no restart', async () => {
    let groups = ['Music Bot Controllers'];
    const access = new ControlAccess(async () => groups, source({ 2: [999], 3: [102] }));
    assert.equal(await allowed(access, 3), false);
    groups = ['102'];
    assert.equal(await allowed(access, 3), true);
    assert.equal(await allowed(access, 2), false);
    groups = [];
    assert.equal(await allowed(access, 2), true, 'cleared: everybody');
  });

  it('reads the groups of the sender on every command but the group list only once a minute', async () => {
    let now = 1_000;
    const src = source({ 2: [999] });
    const access = new ControlAccess(set('Music Bot Controllers'), src, () => now);
    await access.check(1, 1, 2);
    await access.check(1, 1, 2);
    assert.equal(src.calls.client, 2, 'a revoked group must stop working at once');
    assert.equal(src.calls.groupList, 1);
    now += 61_000;
    await access.check(1, 1, 2);
    assert.equal(src.calls.groupList, 2);
  });

  it('tells a refused user at most once every 30 seconds, and names the group', () => {
    let now = 5_000;
    const access = new ControlAccess(set('Music Bot Controllers'), source({}), () => now);
    assert.equal(access.deniedMessage(['Music Bot Controllers']), 'You don\'t have permission to use the music bot: you need the group "Music Bot Controllers".');
    assert.equal(access.deniedMessage(['A', 'B']), 'You don\'t have permission to use the music bot: you need the group "A" or "B".');
    assert.equal(access.shouldNotifyDenied(1, 7), true);
    assert.equal(access.shouldNotifyDenied(1, 7), false);
    assert.equal(access.shouldNotifyDenied(1, 8), true, 'another user is told separately');
    now += 30_001;
    assert.equal(access.shouldNotifyDenied(1, 7), true);
  });

  it('warns about a mistyped id, like a mistyped name, once per entry', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      // 998 and "Missing Group" match nothing, 999 does: the member is still let in.
      const access = new ControlAccess(set('999', '998', 'Missing Group'), source({ 2: [999], 3: [7] }));
      assert.equal(await allowed(access, 2), true);
      assert.equal(await allowed(access, 3), false);
      assert.equal(warnings.filter((w) => w.includes('"998"')).length, 1);
      assert.equal(warnings.filter((w) => w.includes('"Missing Group"')).length, 1);
      assert.equal(warnings.filter((w) => w.includes('"999"')).length, 0);
      assert.equal(warnings.filter((w) => w.includes('nobody can use the bot')).length, 0);

      // A lone mistyped id locks everybody out, and says so.
      warnings.length = 0;
      const lockedOut = new ControlAccess(set('998'), source({ 2: [999] }));
      assert.equal(await allowed(lockedOut, 2), false);
      await allowed(lockedOut, 2);
      assert.equal(warnings.filter((w) => w.includes('"998" matches no server group')).length, 1);
      assert.equal(warnings.filter((w) => w.includes('nobody can use the bot')).length, 1);

      // Two entries that name the same group are both fine.
      warnings.length = 0;
      assert.equal(await allowed(new ControlAccess(set('999', 'music bot controllers'), source({ 2: [999] })), 2), true);
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = original;
    }
  });
});
