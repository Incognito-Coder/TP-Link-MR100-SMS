import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Mr100Cipher } from '../src/crypto.js';
import { ACT, action, buildRequest, normalizeMessageContent, parseResponse, responseData, smsMetrics } from '../src/protocol.js';

test('builds the observed MR100 send request exactly', () => {
  const result = buildRequest([
    action(ACT.SET, 'LTE_SMS_SENDNEWMSG', ['index=1', 'to=09350000000', 'textContent=Hello']),
  ]);
  assert.equal(result, '2\r\n[LTE_SMS_SENDNEWMSG#0,0,0,0,0,0#0,0,0,0,0,0]0,3\r\nindex=1\r\nto=09350000000\r\ntextContent=Hello\r\n');
});

test('parses message list responses and values containing equals signs', () => {
  const parsed = parseResponse('[1,0,0,0,0,0]1\nindex=12\nfrom=Example\ncontent=a=b\nreceivedTime=2026-08-27 10:00:00\nunread=1\n[error]0\n');
  assert.equal(parsed.success, true);
  assert.equal(responseData(parsed, 1)[0].fields.content, 'a=b');
  assert.equal(normalizeMessageContent('line 1\u0012line 2'), 'line 1\nline 2');
});

test('AES round-trip and RSA login signature match the router format', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 512, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = Buffer.from(jwk.n, 'base64url').toString('hex');
  const exponent = Buffer.from(jwk.e, 'base64url').toString('hex');
  const cipher = new Mr100Cipher({
    modulus,
    exponent,
    sequence: 1000,
    username: 'admin',
    password: 'secret',
    key: '1234567890123456',
    iv: '6543210987654321',
  });
  const wrapped = cipher.wrap('admin\nsecret', true);
  assert.equal(cipher.decrypt(wrapped.data), 'admin\nsecret');
  let signatureText = '';
  for (let offset = 0; offset < wrapped.sign.length; offset += modulus.length) {
    const decrypted = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(wrapped.sign.slice(offset, offset + modulus.length), 'hex'));
    signatureText += decrypted.toString('utf8').replace(/\0+$/, '');
  }
  assert.match(signatureText, /^key=1234567890123456&iv=6543210987654321&h=[a-f0-9]{32}&s=\d+$/);
});

test('counts GSM-7 and Unicode multipart messages', () => {
  assert.deepEqual(smsMetrics('Hello'), { gsm: true, units: 5, segments: 1, maximum: 765 });
  assert.equal(smsMetrics('^').units, 2);
  assert.deepEqual(smsMetrics('س'.repeat(71)), { gsm: false, units: 71, segments: 2, maximum: 335 });
});
