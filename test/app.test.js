import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A small DOM stub for testing the actual app's asynchronous folder transitions.
// Browser checks cover layout separately; these tests do not contact a router.
class Element {
  children = [];
  dataset = {};
  hidden = false;
  disabled = false;
  textContent = '';
  value = '';
  listeners = new Map();
  classList = { add() {}, remove() {}, toggle() {} };
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute() {}
}

async function createApp() {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const requests = [];
  const folders = ['inbox', 'sent', 'drafts'].map((box) => {
    const element = new Element();
    element.dataset.box = box;
    return element;
  });
  const context = vm.createContext({
    document: {
      querySelector: get,
      querySelectorAll: (selector) => selector === '.folder-button' ? folders : [],
      createElement: () => new Element(),
      documentElement: { dataset: { theme: 'light' } },
    },
    localStorage: { setItem() {} },
    Headers,
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: (path) => {
      if (path === '/api/session') return Promise.resolve({ ok: true, json: async () => ({ connected: false }) });
      return new Promise((resolve) => requests.push({
        path,
        respond: (data, status = 200) => resolve({ ok: status === 200, status, json: async () => data }),
      }));
    },
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  await flush();
  run(`showApp({ csrf: 'test-token', router: { host: 'http://127.0.0.1', info: {} } })`);
  return { get, requests, run };
}

function messages(box, { page = 1, total = 1 } = {}) {
  return {
    box, page, pageSize: 10, total, pages: Math.max(1, Math.ceil(total / 10)),
    messages: total ? [{ stack: '1,0,0,0,0,0', index: '1', address: 'Test recipient', content: `${box} message`, time: null, unread: false }] : [],
  };
}

test('a Sent click during an Inbox load fetches Sent without displaying Inbox data', async () => {
  const app = await createApp();
  app.run(`switchFolder('sent')`);
  assert.equal(app.requests.length, 1, 'router reads must remain sequential');
  app.requests[0].respond(messages('inbox'));
  await flush();
  assert.match(app.requests[1].path, /box=sent&page=1/);
  assert.equal(app.get('#messageList').children.length, 0);
  assert.equal(app.get('#listSkeleton').hidden, false);
  app.requests[1].respond(messages('sent'));
  await flush();
  assert.equal(app.get('#folderTitle').textContent, 'Sent');
  assert.equal(app.get('#sentCount').textContent, 1);
  assert.equal(app.get('#messageList').children.length, 1);
  assert.equal(app.get('#messageList').hidden, false);
  assert.equal(app.get('#refreshButton').disabled, false);
  assert.equal(app.run('state.data.box'), 'sent');
});

test('rapid folder changes keep the latest Drafts choice and discard stale errors', async () => {
  const app = await createApp();
  app.run(`switchFolder('sent'); switchFolder('drafts')`);
  app.requests[0].respond({ error: { message: 'Old inbox error' } }, 502);
  await flush();
  assert.equal(app.requests.length, 2);
  assert.match(app.requests[1].path, /box=drafts&page=1/);
  assert.equal(app.get('#toast').innerHTML, undefined);
  app.requests[1].respond(messages('drafts'));
  await flush();
  assert.equal(app.run('state.data.box'), 'drafts');
  assert.equal(app.get('#draftsCount').textContent, 1);
  assert.equal(app.get('#folderTitle').textContent, 'Drafts');
});

test('an empty folder displays an explicit empty state', async () => {
  const app = await createApp();
  app.requests[0].respond(messages('inbox', { total: 0 }));
  await flush();
  app.run(`switchFolder('drafts')`);
  app.requests[1].respond(messages('drafts', { total: 0 }));
  await flush();
  assert.equal(app.get('#emptyState').hidden, false);
  assert.equal(app.get('#emptyState h3').textContent, 'No messages in Drafts');
  assert.equal(app.get('#messageList').hidden, true);
  assert.equal(app.get('#selectPage').disabled, true);
  assert.equal(app.get('#paginationFooter').hidden, true);
});

test('a folder load failure is visible and refresh recovers with the normalized page', async () => {
  const app = await createApp();
  app.requests[0].respond({ error: { message: 'Router unavailable' } }, 502);
  await flush();
  assert.equal(app.get('#emptyState').hidden, false);
  assert.equal(app.get('#emptyState h3').textContent, 'Could not load Inbox');
  assert.match(app.get('#emptyState p').textContent, /Router unavailable/);
  assert.equal(app.get('#refreshButton').disabled, false);
  app.run('state.page = 99; loadMessages()');
  app.requests[1].respond(messages('inbox', { page: 2, total: 12 }));
  await flush();
  assert.equal(app.run('state.page'), 2);
  assert.equal(app.get('#emptyState').hidden, true);
  assert.equal(app.get('#messageList').hidden, false);
  assert.equal(app.get('#paginationFooter').hidden, false);
});

test('disconnect invalidates the pending message response', async () => {
  const app = await createApp();
  app.run(`switchFolder('sent'); showLogin()`);
  app.requests[0].respond(messages('inbox'));
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.run('state.data'), null);
  assert.equal(app.get('#appView').hidden, true);
  assert.equal(app.run('state.loading'), false);
});
