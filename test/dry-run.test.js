import test from 'node:test';
import assert from 'node:assert/strict';

const forbiddenCalls = [];
let dryRunEnabled = true;
const forbidden = name => async () => {
  forbiddenCalls.push(name);
  throw new Error(`${name} must not be called during a dry run`);
};

globalThis.fetch = forbidden('fetch');
globalThis.browser = {
  runtime: {
    getManifest: () => ({ name: 'ThunderSub' }),
    onMessage: { addListener() {} },
    sendMessage: forbidden('runtime.sendMessage')
  },
  storage: {
    local: {
      get: async key => key === 'dryRun' ? { dryRun: dryRunEnabled } : {},
      set: forbidden('storage.local.set'),
      remove: forbidden('storage.local.remove')
    }
  },
  accounts: { list: forbidden('accounts.list') },
  identities: { list: forbidden('identities.list') },
  compose: {
    beginNew: forbidden('compose.beginNew'),
    sendMessage: forbidden('compose.sendMessage')
  },
  windows: { openDefaultBrowser: forbidden('windows.openDefaultBrowser') },
  messages: {
    delete: forbidden('messages.delete'),
    move: forbidden('messages.move'),
    update: forbidden('messages.update'),
    onMoved: {
      addListener: forbidden('messages.onMoved.addListener'),
      removeListener: forbidden('messages.onMoved.removeListener')
    }
  },
  folders: {
    get: forbidden('folders.get'),
    getSubFolders: forbidden('folders.getSubFolders')
  }
};

const { handleRuntimeMessage } = await import('../background.js');

const messageGroups = [{
  accountName: 'Personal',
  folderName: 'Inbox',
  folderId: 'inbox',
  messageIds: [11, 12, 13]
}];

const baseRequest = {
  senderEmail: 'news@example.com',
  recipientAddress: 'reader@example.net',
  messageGroups
};

test('dry run blocks every unsubscribe transport', async t => {
  const cases = [
    ['unsubOneClick', 'one-click', 'https://example.com/one-click'],
    ['unsubMail', 'email', 'mailto:unsubscribe@example.com'],
    ['unsubWeb', 'browser', 'https://example.com/unsubscribe'],
    ['unsubEmbedded', 'embedded link', 'https://example.com/email/unsubscribe']
  ];

  for (const [command, type, url] of cases) {
    await t.test(command, async () => {
      const result = await handleRuntimeMessage({ command, url, ...baseRequest });
      assert.deepEqual(result, { ok: true, dryRun: true, type, url });
    });
  }

  assert.deepEqual(forbiddenCalls, []);
});

test('dry run blocks junk, delete, and move operations', async t => {
  await t.test('junkEmails', async () => {
    const result = await handleRuntimeMessage({ command: 'junkEmails', ...baseRequest });
    assert.deepEqual(result, {
      junked: 3,
      movedToSpam: 3,
      deleted: 0,
      dryRun: true
    });
  });

  await t.test('deleteEmails', async () => {
    const result = await handleRuntimeMessage({ command: 'deleteEmails', ...baseRequest });
    assert.deepEqual(result, { deleted: 3, dryRun: true });
  });

  await t.test('moveEmails', async () => {
    const result = await handleRuntimeMessage({
      command: 'moveEmails',
      ...baseRequest,
      destinationFolderId: 'archive',
      destination: { id: 'archive', label: 'Archive' }
    });
    assert.deepEqual(result, { moved: 3, dryRun: true });
  });

  assert.deepEqual(forbiddenCalls, []);
});

test('one-click requests reject redirects, omit credentials, and limit error responses', async () => {
  dryRunEnabled = false;
  let fetchOptions;
  globalThis.fetch = async (_url, options) => {
    fetchOptions = options;
    return new Response('x'.repeat(5000), {
      status: 422,
      statusText: 'Unprocessable Content'
    });
  };

  try {
    const result = await handleRuntimeMessage({
      command: 'unsubOneClick',
      url: 'https://example.com/unsubscribe',
      ...baseRequest
    });

    assert.equal(fetchOptions.redirect, 'error');
    assert.equal(fetchOptions.credentials, 'omit');
    assert.equal(result.message.length, 1000);
    assert.match(result.message, /… \[response truncated\]$/);
  } finally {
    dryRunEnabled = true;
    globalThis.fetch = forbidden('fetch');
  }
});
