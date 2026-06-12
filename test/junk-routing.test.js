import test from 'node:test';
import assert from 'node:assert/strict';

import { junkFolderForGroup } from '../junk-routing.js';

const accounts = [
  { id: 'account-a', name: 'Personal' },
  { id: 'account-b', name: 'Personal' }
];
const junkFolders = {
  'account-a': 'junk-a',
  'account-b': 'junk-b'
};

test('routes by source folder account when account display names collide', async () => {
  const getFolder = async folderId => {
    assert.equal(folderId, 'inbox-b');
    return { id: folderId, accountId: 'account-b' };
  };

  const destination = await junkFolderForGroup(
    { folderId: 'inbox-b', accountName: 'Personal' }, accounts, junkFolders, getFolder);

  assert.equal(destination, 'junk-b');
});

test('falls back to account name when the source folder no longer exists', async () => {
  const getFolder = async () => {
    throw new Error('folder not found');
  };

  const destination = await junkFolderForGroup(
    { folderId: 'missing', accountName: 'Personal' }, [accounts[0]], junkFolders, getFolder);

  assert.equal(destination, 'junk-a');
});

test('returns no destination when neither folder nor account name resolves', async () => {
  const destination = await junkFolderForGroup(
    { folderId: null, accountName: 'Unknown' }, accounts, junkFolders, async () => null);

  assert.equal(destination, null);
});
