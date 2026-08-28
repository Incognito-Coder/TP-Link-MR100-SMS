import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { Mr100RouterClient } from '../src/router-client.js';

function privateDecryptSignature(hex, privateKey, modulusHexLength) {
  let result = '';
  for (let offset = 0; offset < hex.length; offset += modulusHexLength) {
    const block = Buffer.from(hex.slice(offset, offset + modulusHexLength), 'hex');
    result += crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, block).toString('utf8').replace(/\0+$/, '');
  }
  return result;
}

function decryptAes(data, key, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([decipher.update(data, 'base64'), decipher.final()]).toString('utf8');
}

function encryptAes(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('base64');
}

async function requestBody(request) {
  let value = '';
  for await (const chunk of request) value += chunk;
  return value;
}

async function createMockRouter() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 512, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = Buffer.from(jwk.n, 'base64url').toString('hex');
  const exponent = Buffer.from(jwk.e, 'base64url').toString('hex');
  const state = {
    key: null,
    iv: null,
    token: 'mock-token-123',
    sendPoll: 0,
    deleted: false,
    totals: {},
    requests: [],
    sent: [],
    drafts: [],
    inbox: [
      { stack: '1,0,0,0,0,0', index: '2', from: 'Example', content: 'Hello\u0012World', receivedTime: '2026-08-27 10:00:00', unread: '1' },
      { stack: '2,0,0,0,0,0', index: '1', from: '+989000000000', content: 'Second', receivedTime: '2026-08-26 09:00:00', unread: '0' },
    ],
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Set-Cookie', 'loginErrorShow=1; Path=/');
      response.end(`<script>var token="${state.token}";</script>`);
      return;
    }
    if (url.pathname === '/cgi/getParm') {
      response.end(`var ee="${exponent}";var nn="${modulus}";var seq="100000";$.ret=0;`);
      return;
    }
    if (url.pathname === '/cgi/getBusy') {
      response.end('var isBusy=0;');
      return;
    }
    if (url.pathname === '/cgi/login') {
      const signature = privateDecryptSignature(url.searchParams.get('sign'), privateKey, modulus.length);
      state.key = /key=([^&]+)/.exec(signature)?.[1];
      state.iv = /iv=([^&]+)/.exec(signature)?.[1];
      const login = decryptAes(url.searchParams.get('data'), state.key, state.iv);
      response.setHeader('Set-Cookie', 'JSESSIONID=mock-session; Path=/');
      response.end(login === 'admin\nsecret' ? '$.ret=0;' : '$.ret=71233;');
      return;
    }
    if (url.pathname === '/cgi_gdpr') {
      const body = await requestBody(request);
      const fields = Object.fromEntries(body.trim().split(/\r?\n/).map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }));
      const plain = decryptAes(fields.data, state.key, state.iv);
      state.requests.push(plain);
      const folder = plain.includes('LTE_SMS_SENDMSG') ? 'sent'
        : plain.includes('LTE_SMS_DRAFTMSG') ? 'drafts' : 'inbox';
      let output = '[error]0\n';
      if (plain.includes('IGD_DEV_INFO')) {
        output = '[0,0,0,0,0,0]0\nmodelName=TL-MR100\nhardwareVersion=V1\nsoftwareVersion=1.0\n[error]0\n';
      } else if (plain.includes('PageNumber=0')) {
        // Firmware initializes each folder's total when page zero is selected.
        state.totals[folder] = state[folder].length;
      } else if (plain.includes('totalNumber')) {
        output = `[0,0,0,0,0,0]0\ntotalNumber=${state.totals[folder] ?? 0}\n[error]0\n`;
      } else if (plain.startsWith('2&5') && /LTE_SMS_(RECV|SEND|DRAFT)MSGENTRY/.test(plain)) {
        const page = Number(/PageNumber=(\d+)/.exec(plain)[1]);
        output = state[folder].slice((page - 1) * 8, page * 8).map(({ stack, ...fields }) => (
          `[${stack}]1\n${Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join('')}`
        )).join('') + '[error]0\n';
      } else if (plain.startsWith('4') && plain.includes('LTE_SMS_RECVMSGENTRY')) {
        const stacks = [...plain.matchAll(/\[LTE_SMS_RECVMSGENTRY#([^#]+)#/g)].map((match) => match[1]);
        state.inbox = state.inbox.filter((message) => !stacks.includes(message.stack));
      } else if (plain.startsWith('2') && plain.includes('LTE_SMS_SENDNEWMSG') && plain.includes('index=1')) {
        state.sendPoll = 0;
      } else if (plain.startsWith('1') && plain.includes('LTE_SMS_SENDNEWMSG')) {
        state.sendPoll += 1;
        output = `[0,0,0,0,0,0]0\nsendResult=${state.sendPoll === 1 ? 3 : 1}\n[error]0\n`;
      }
      response.end(encryptAes(output, state.key, state.iv));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, state, url: `http://127.0.0.1:${address.port}` };
}

test('logs in and manages SMS through the encrypted router protocol', async (context) => {
  const mock = await createMockRouter();
  context.after(() => new Promise((resolve) => mock.server.close(resolve)));
  const client = new Mr100RouterClient({ host: mock.url, username: 'admin', password: 'secret' });
  const session = await client.login();
  assert.equal(session.info.modelName, 'TL-MR100');
  const inbox = await client.getMessages('inbox', 1);
  assert.equal(inbox.total, 2);
  assert.equal(inbox.messages[0].content, 'Hello\nWorld');
  assert.equal(inbox.messages[0].unread, true);
  const sent = await client.sendSms('09350000000', 'Hello');
  assert.equal(sent.confirmed, true);
  assert.deepEqual(sent.statusCodes, [3, 1]);
  const deleted = await client.deleteMessages('inbox', ['1,0,0,0,0,0']);
  assert.equal(deleted.deleted, 1);
  const after = await client.getMessages('inbox', 1);
  assert.equal(after.total, 1);
  const emptied = await client.deleteAllInbox();
  assert.equal(emptied.deleted, 1);
  assert.equal(emptied.remaining, 0);
});

for (const [folder, oid] of [['sent', 'SEND'], ['drafts', 'DRAFT']]) {
  test(`synchronizes and paginates ${folder} before reading the total`, async (context) => {
    const mock = await createMockRouter();
    context.after(() => new Promise((resolve) => mock.server.close(resolve)));
    mock.state[folder] = Array.from({ length: 19 }, (_, index) => ({
      stack: `${index + 1},0,0,0,0,0`,
      index: String(index),
      to: '+12025550100',
      content: `${folder} ${index}\u0012Second line`,
      ...(folder === 'sent' ? { sendTime: '2026-08-28 10:00:00' } : {}),
    }));
    const client = new Mr100RouterClient({ host: mock.url, password: 'secret' });
    await client.login();
    mock.state.requests.length = 0;

    const first = await client.getMessages(folder, 1);
    assert.equal(first.total, 19);
    assert.equal(first.messages.length, 10);
    assert.equal(first.messages[0].address, '+12025550100');
    assert.equal(first.messages[0].content, `${folder} 0\nSecond line`);
    assert.equal(first.messages[0].time, folder === 'sent' ? '2026-08-28 10:00:00' : null);
    assert.equal(first.messages[0].unread, false);
    assert.match(mock.state.requests[0], new RegExp(`LTE_SMS_${oid}MSGBOX`));
    assert.match(mock.state.requests[0], /PageNumber=0/);
    assert.match(mock.state.requests[1], /totalNumber/);

    const second = await client.getMessages(folder, 2);
    assert.equal(second.page, 2);
    assert.equal(second.pages, 2);
    assert.deepEqual(second.messages.map((message) => message.index),
      Array.from({ length: 9 }, (_, index) => String(index + 10)));

    mock.state[folder].pop();
    const refreshed = await client.getMessages(folder, 99);
    assert.equal(refreshed.total, 18);
    assert.equal(refreshed.page, 2);
    assert.equal(refreshed.messages.length, 8);

    mock.state[folder] = [];
    const empty = await client.getMessages(folder, 1);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.messages, []);
  });
}
