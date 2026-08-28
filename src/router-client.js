import { setTimeout as delay } from 'node:timers/promises';
import { Mr100Cipher } from './crypto.js';
import { CookieJar } from './cookie-jar.js';
import {
  ACT,
  action,
  assertRouterSuccess,
  buildRequest,
  encodeMessageContent,
  normalizeMessageContent,
  parseResponse,
  responseData,
  smsMetrics,
} from './protocol.js';

const BOXES = Object.freeze({
  inbox: {
    box: 'LTE_SMS_RECVMSGBOX',
    entry: 'LTE_SMS_RECVMSGENTRY',
    fields: ['index', 'from', 'content', 'receivedTime', 'unread'],
    addressField: 'from',
    timeField: 'receivedTime',
  },
  sent: {
    box: 'LTE_SMS_SENDMSGBOX',
    entry: 'LTE_SMS_SENDMSGENTRY',
    fields: ['index', 'to', 'content', 'sendTime'],
    addressField: 'to',
    timeField: 'sendTime',
  },
  drafts: {
    box: 'LTE_SMS_DRAFTMSGBOX',
    entry: 'LTE_SMS_DRAFTMSGENTRY',
    fields: ['index', 'to', 'content'],
    addressField: 'to',
    timeField: null,
  },
});

function parseAssignedValue(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:var\\s+)?${escaped}\\s*=\\s*["']?([^;"'\\s]+)`).exec(text);
  return match?.[1] ?? null;
}

function routerError(message, code = 'ROUTER_ERROR', status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function normalizeRouterUrl(input) {
  let value = String(input ?? '').trim();
  if (!value) value = 'http://192.168.0.1';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  if (url.protocol !== 'http:') throw routerError('This app supports the MR100 local HTTP interface only', 'INVALID_ROUTER_URL', 400);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw routerError('Enter only the router address, for example 192.168.0.1', 'INVALID_ROUTER_URL', 400);
  }
  const host = url.hostname.toLowerCase();
  const privateHost = host === 'localhost'
    || host === 'tplinkmodem.net'
    || host === 'tplinkwifi.net'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || (() => {
      const match = /^172\.(\d+)\./.exec(host);
      return match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
    })();
  if (!privateHost) throw routerError('Router address must be on your private network', 'INVALID_ROUTER_URL', 400);
  return url.origin;
}

export class Mr100RouterClient {
  constructor({ host, username = 'admin', password, timeoutMs = 10000 }) {
    if (!password) throw routerError('Router password is required', 'INVALID_CREDENTIALS', 400);
    this.host = normalizeRouterUrl(host);
    this.username = String(username || 'admin');
    this.password = String(password);
    this.timeoutMs = timeoutMs;
    this.cookies = new CookieJar();
    this.cipher = null;
    this.token = null;
    this.connected = false;
    this.info = null;
  }

  async fetch(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    headers.set('Accept', '*/*');
    headers.set('Referer', `${this.host}/`);
    headers.set('User-Agent', 'MR100-SMS-Manager/1.0');
    if (this.cookies.header()) headers.set('Cookie', this.cookies.header());
    if (this.token) headers.set('TokenID', this.token);
    const response = await fetch(`${this.host}${path}`, {
      ...options,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error) => {
      if (error.name === 'TimeoutError') throw routerError('The router did not respond in time', 'ROUTER_TIMEOUT', 504);
      throw routerError(`Cannot reach the router at ${this.host}`, 'ROUTER_UNREACHABLE', 502);
    });
    this.cookies.capture(response.headers);
    return response;
  }

  async fetchText(path, options = {}) {
    const response = await this.fetch(path, options);
    const text = await response.text();
    if (!response.ok) throw routerError(`Router returned HTTP ${response.status}`, 'ROUTER_HTTP_ERROR', 502);
    return text;
  }

  async getParameters() {
    const text = await this.fetchText(`/cgi/getParm?_=${Date.now()}`, { method: 'POST' });
    const modulus = parseAssignedValue(text, 'nn');
    const exponent = parseAssignedValue(text, 'ee');
    const sequence = parseAssignedValue(text, 'seq');
    if (!modulus || !exponent || !sequence) throw routerError('This router did not return the expected MR100 encryption parameters', 'UNSUPPORTED_ROUTER');
    return { modulus, exponent, sequence: Number(sequence) };
  }

  async login() {
    this.cookies.clear();
    this.token = null;
    this.connected = false;
    await this.fetchText('/', { method: 'GET' });
    const parameters = await this.getParameters();
    await this.fetchText(`/cgi/getBusy?_=${Date.now()}`, { method: 'POST' }).catch(() => '');
    this.cipher = new Mr100Cipher({
      ...parameters,
      username: this.username,
      password: this.password,
    });
    const loginPayload = this.cipher.wrap(`${this.username}\n${this.password}`, true);
    const query = new URLSearchParams({
      data: loginPayload.data,
      sign: loginPayload.sign,
      Action: '1',
      LoginStatus: '0',
      isMobile: '0',
      _: String(Date.now()),
    });
    const loginText = await this.fetchText(`/cgi/login?${query}`, { method: 'POST' });
    const resultValue = parseAssignedValue(loginText, '$.ret') ?? parseAssignedValue(loginText, 'ret');
    if (resultValue == null) throw routerError('The router returned an unexpected login response', 'LOGIN_FAILED', 401);
    const result = Number(resultValue);
    if (result !== 0) {
      if (result === 71233) throw routerError('Incorrect router username or password', 'LOGIN_FAILED', 401);
      if (result === 71234) throw routerError('The router rejected the login request', 'LOGIN_FAILED', 401);
      throw routerError(`Router login failed (${result})`, 'LOGIN_FAILED', 401);
    }
    const home = await this.fetchText('/', { method: 'GET' });
    this.token = /var\s+token=["']([^"']+)["']/.exec(home)?.[1] ?? null;
    if (!this.token) throw routerError('Login succeeded but the router token was not found', 'TOKEN_MISSING');
    const refreshed = await this.getParameters().catch(() => null);
    if (refreshed) this.cipher.setSequence(refreshed.sequence);
    this.connected = true;
    this.info = await this.getRouterInfo().catch(() => ({ modelName: 'TP-Link MR100' }));
    return { host: this.host, username: this.username, info: this.info };
  }

  async encryptedRequest(actions, operation = 'Router request') {
    if (!this.connected || !this.cipher || !this.token) throw routerError('Router session is not connected', 'NOT_CONNECTED', 401);
    const plaintext = buildRequest(actions);
    const payload = this.cipher.wrap(plaintext, false);
    const body = `sign=${payload.sign}\r\ndata=${payload.data}\r\n`;
    const encrypted = await this.fetchText(`/cgi_gdpr?_=${Date.now()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: this.host,
      },
      body,
    });
    let decrypted;
    try {
      decrypted = this.cipher.decrypt(encrypted);
    } catch {
      throw routerError('The router session expired or returned an unreadable response', 'SESSION_EXPIRED', 401);
    }
    const parsed = parseResponse(decrypted);
    assertRouterSuccess(parsed, operation);
    return parsed;
  }

  async getRouterInfo() {
    const parsed = await this.encryptedRequest([
      action(ACT.GET, 'IGD_DEV_INFO', ['modelName', 'hardwareVersion', 'softwareVersion']),
    ], 'Reading router information');
    return responseData(parsed, 0)[0]?.fields ?? { modelName: 'TP-Link MR100' };
  }

  async getMessages(boxName = 'inbox', page = 1) {
    const box = BOXES[boxName];
    if (!box) throw routerError('Unknown SMS folder', 'INVALID_FOLDER', 400);
    const targetPageSize = 10;
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);

    // The MR100 initializes every folder's total with page zero, not just Inbox.
    await this.encryptedRequest([
      action(ACT.SET, box.box, ['PageNumber=0']),
    ], `Synchronizing ${boxName}`);

    const totalResponse = await this.encryptedRequest([
      action(ACT.GET, box.box, ['totalNumber']),
    ], `Reading ${boxName} total`);
    const total = Number(responseData(totalResponse, 0)[0]?.fields.totalNumber ?? 0);
    const pages = Math.max(1, Math.ceil(total / targetPageSize));
    const normalizedPage = Math.min(safePage, pages);

    if (total === 0) {
      return { box: boxName, page: 1, pageSize: targetPageSize, total: 0, pages: 1, messages: [] };
    }

    const startIndex = (normalizedPage - 1) * targetPageSize;
    const endIndex = Math.min(startIndex + targetPageSize, total);

    const startRouterPage = Math.floor(startIndex / 8) + 1;
    const endRouterPage = Math.floor((endIndex - 1) / 8) + 1;

    const collectedMessages = [];
    for (let rPage = startRouterPage; rPage <= endRouterPage; rPage += 1) {
      const listResponse = await this.encryptedRequest([
        action(ACT.SET, box.box, [`PageNumber=${rPage}`]),
        action(ACT.GET_LIST, box.entry, box.fields),
      ], `Reading ${boxName}`);
      const pageMsgs = responseData(listResponse, 1).map((block) => ({
        stack: block.stack,
        index: block.fields.index ?? null,
        address: block.fields[box.addressField] ?? '',
        content: normalizeMessageContent(block.fields.content ?? ''),
        time: box.timeField ? block.fields[box.timeField] ?? null : null,
        unread: block.fields.unread === '1',
      }));
      collectedMessages.push(...pageMsgs);
    }

    const offsetInCollected = startIndex - (startRouterPage - 1) * 8;
    const messages = collectedMessages.slice(offsetInCollected, offsetInCollected + (endIndex - startIndex));

    return {
      box: boxName,
      page: normalizedPage,
      pageSize: targetPageSize,
      total,
      pages,
      messages,
    };
  }

  async sendSms(to, content) {
    const recipient = String(to ?? '').trim();
    const message = String(content ?? '');
    if (!/^[+0-9][0-9\s()-]{2,30}$/.test(recipient)) throw routerError('Enter a valid recipient number', 'INVALID_RECIPIENT', 400);
    if (!message.trim()) throw routerError('Message cannot be empty', 'INVALID_MESSAGE', 400);
    const metrics = smsMetrics(message);
    if (metrics.segments > 5) throw routerError(`Message is longer than the router maximum of ${metrics.maximum} ${metrics.gsm ? 'GSM-7' : 'Unicode'} characters`, 'MESSAGE_TOO_LONG', 400);
    await this.encryptedRequest([
      action(ACT.SET, 'LTE_SMS_SENDNEWMSG', ['index=1', `to=${recipient}`, `textContent=${encodeMessageContent(message)}`]),
    ], 'Sending SMS');
    const statusCodes = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (attempt > 0) await delay(900);
      const result = await this.encryptedRequest([
        action(ACT.GET, 'LTE_SMS_SENDNEWMSG', ['sendResult']),
      ], 'Checking SMS status');
      const code = Number(responseData(result, 0)[0]?.fields.sendResult ?? 0);
      statusCodes.push(code);
      if (code === 1) return { accepted: true, confirmed: true, status: 'success', statusCodes };
      if (code === 2) return { accepted: true, confirmed: false, status: 'busy', statusCodes };
      if (code === 0 && statusCodes.includes(3)) return { accepted: true, confirmed: false, status: 'completed', statusCodes };
      if (code !== 3 && code !== 0) return { accepted: true, confirmed: false, status: 'unknown', statusCodes };
    }
    return { accepted: true, confirmed: false, status: 'timeout', statusCodes };
  }

  async saveDraft(to, content) {
    const recipient = String(to ?? '').trim();
    const message = String(content ?? '');
    if (!recipient && !message.trim()) throw routerError('Enter a recipient or message before saving', 'EMPTY_DRAFT', 400);
    if (recipient && !/^[+0-9][0-9\s()-]{2,30}$/.test(recipient)) throw routerError('Enter a valid recipient number', 'INVALID_RECIPIENT', 400);
    const metrics = smsMetrics(message);
    if (metrics.segments > 5) throw routerError(`Draft is longer than the router maximum of ${metrics.maximum} ${metrics.gsm ? 'GSM-7' : 'Unicode'} characters`, 'MESSAGE_TOO_LONG', 400);
    await this.encryptedRequest([
      action(ACT.SET, 'LTE_SMS_SENDNEWMSG', ['index=2', `to=${recipient}`, `textContent=${encodeMessageContent(message)}`]),
    ], 'Saving draft');
    return { saved: true };
  }

  async markRead(stack) {
    const safeStack = this.validateStack(stack);
    await this.encryptedRequest([
      action(ACT.SET, 'LTE_SMS_RECVMSGENTRY', ['unread=0'], safeStack),
    ], 'Marking SMS as read');
    return { updated: true };
  }

  async deleteMessage(boxName, stack) {
    const result = await this.deleteMessages(boxName, [stack]);
    return { deleted: result.deleted === 1 };
  }

  async deleteMessages(boxName, stacks) {
    const box = BOXES[boxName];
    if (!box) throw routerError('Unknown SMS folder', 'INVALID_FOLDER', 400);
    if (!Array.isArray(stacks) || stacks.length === 0) throw routerError('Select at least one message', 'NO_MESSAGES_SELECTED', 400);
    const safeStacks = [...new Set(stacks.map((stack) => this.validateStack(stack)))];
    if (safeStacks.length > 32) throw routerError('Delete messages in batches of 32 or fewer', 'BATCH_TOO_LARGE', 400);

    let deleted = 0;
    try {
      await this.encryptedRequest(
        safeStacks.map((stack) => action(ACT.DELETE, box.entry, [], stack)),
        `Deleting ${safeStacks.length} SMS ${safeStacks.length === 1 ? 'message' : 'messages'}`,
      );
      deleted = safeStacks.length;
    } catch (err) {
      // Fallback: If batch request fails (e.g. router error 9805), delete stacks sequentially
      for (const stack of safeStacks) {
        try {
          await this.encryptedRequest(
            [action(ACT.DELETE, box.entry, [], stack)],
            'Deleting SMS message',
          );
          deleted += 1;
          await delay(80);
        } catch {
          // continue attempting remaining stacks
        }
      }
      if (deleted === 0) throw err;
    }
    await this.clearBusy().catch(() => {});
    return { deleted };
  }

  async deleteAllInbox() {
    let deleted = 0;
    for (let round = 0; round < 500; round += 1) {
      const page = await this.getMessages('inbox', 1);
      if (page.total === 0) return { deleted, remaining: 0 };
      if (page.messages.length === 0) throw routerError('The router reported messages but returned an empty page', 'DELETE_ALL_STALLED');
      const result = await this.deleteMessages('inbox', page.messages.map((message) => message.stack));
      deleted += result.deleted;
      await delay(120);
    }
    throw routerError('Delete all stopped before the inbox was empty', 'DELETE_ALL_LIMIT');
  }

  validateStack(stack) {
    const value = String(stack ?? '');
    if (!/^\d+(?:,\d+){5}$/.test(value)) throw routerError('Invalid router message stack', 'INVALID_STACK', 400);
    return value;
  }

  async clearBusy() {
    return this.encryptedRequest([action(ACT.CGI, '/cgi/clearBusy')], 'Clearing router busy state');
  }

  async logout() {
    if (this.connected) {
      await this.clearBusy().catch(() => {});
      await this.encryptedRequest([action(ACT.CGI, '/cgi/logout')], 'Router logout').catch(() => {});
    }
    this.connected = false;
    this.token = null;
    this.password = '';
    this.cipher = null;
    this.cookies.clear();
  }
}
