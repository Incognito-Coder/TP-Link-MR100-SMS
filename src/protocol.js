export const ACT = Object.freeze({
  GET: 1,
  SET: 2,
  ADD: 3,
  DELETE: 4,
  GET_LIST: 5,
  GET_STATUS: 6,
  OPERATE: 7,
  CGI: 8,
});

export const ZERO_STACK = '0,0,0,0,0,0';

export function action(type, oid, attributes = [], stack = ZERO_STACK, parentStack = ZERO_STACK) {
  return { type, oid, attributes, stack, parentStack };
}

export function buildRequest(actions) {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('At least one router action is required');
  const types = actions.map((item) => item.type).join('&');
  const body = actions.map((item, index) => {
    const attributes = item.attributes ?? [];
    return `[${item.oid}#${item.stack ?? ZERO_STACK}#${item.parentStack ?? ZERO_STACK}]${index},${attributes.length}\r\n${attributes.join('\r\n')}\r\n`;
  }).join('');
  return `${types}\r\n${body}`;
}

export function parseResponse(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    const header = /^\[([^\]]+)](\d+)$/.exec(line);
    if (header) {
      current = {
        stack: header[1],
        responseIndex: Number(header[2]),
        fields: {},
        kind: header[1] === 'error' ? 'error' : header[1] === 'cgi' ? 'cgi' : 'data',
      };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator !== -1) current.fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const errorCodes = blocks.filter((block) => block.kind === 'error').map((block) => block.responseIndex);
  return {
    blocks,
    errorCodes,
    success: errorCodes.length > 0 && errorCodes.every((code) => code === 0),
  };
}

export function responseData(parsed, responseIndex = null) {
  return parsed.blocks.filter((block) => block.kind === 'data'
    && (responseIndex == null || block.responseIndex === responseIndex));
}

export function normalizeMessageContent(value = '') {
  return String(value).replace(/\u0012/g, '\n').replace(/\u0011/g, '\r');
}

export function encodeMessageContent(value = '') {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\u0012');
}

const GSM_BASIC = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(''));
const GSM_EXTENDED = new Set('^{}\\[~]|€'.split(''));

export function smsMetrics(value = '') {
  let gsm = true;
  let units = 0;
  for (const character of String(value)) {
    if (GSM_BASIC.has(character)) units += 1;
    else if (GSM_EXTENDED.has(character)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) units = [...String(value)].length;
  const singlePart = gsm ? 160 : 70;
  const multipart = gsm ? 153 : 67;
  const segments = units <= singlePart ? 1 : Math.ceil(units / multipart);
  return { gsm, units, segments, maximum: multipart * 5 };
}

export function assertRouterSuccess(parsed, operation = 'Router request') {
  if (!parsed.success) {
    const codes = parsed.errorCodes.length ? parsed.errorCodes.join(', ') : 'missing';
    const error = new Error(`${operation} failed (router error ${codes})`);
    error.code = 'ROUTER_OPERATION_FAILED';
    error.status = 502;
    error.routerCodes = parsed.errorCodes;
    throw error;
  }
}
