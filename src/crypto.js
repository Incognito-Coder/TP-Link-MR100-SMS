import crypto from 'node:crypto';

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function exponentBytes(hex) {
  const clean = hex.length % 2 ? `0${hex}` : hex;
  return Buffer.from(clean, 'hex');
}

export function createRouterPublicKey(modulusHex, exponentHex) {
  return crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: base64Url(Buffer.from(modulusHex, 'hex')),
      e: base64Url(exponentBytes(exponentHex)),
    },
    format: 'jwk',
  });
}

export function rsaNoPaddingEncrypt(chunk, publicKey, byteLength) {
  const input = Buffer.alloc(byteLength);
  const bytes = Buffer.from(chunk, 'utf8');
  if (bytes.length > byteLength) throw new Error('RSA signature chunk is too large');
  bytes.copy(input);
  return crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_NO_PADDING }, input).toString('hex').padStart(byteLength * 2, '0');
}

export class Mr100Cipher {
  constructor({ modulus, exponent, sequence, username, password, key, iv }) {
    this.modulus = modulus;
    this.exponent = exponent;
    this.sequence = Number(sequence);
    this.username = username;
    this.passwordHash = crypto.createHash('md5').update(`${username}${password}`).digest('hex');
    const timestamp = String(Date.now());
    const randomDigits = () => String(crypto.randomInt(100000000, 1000000000));
    this.key = key ?? `${timestamp}${randomDigits()}`.slice(0, 16);
    this.iv = iv ?? `${timestamp}${randomDigits()}`.slice(0, 16);
    this.publicKey = createRouterPublicKey(modulus, exponent);
    this.rsaByteLength = modulus.length / 2;
  }

  setSequence(sequence) {
    this.sequence = Number(sequence);
  }

  encrypt(plaintext) {
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(this.key), Buffer.from(this.iv));
    return Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]).toString('base64');
  }

  decrypt(ciphertext) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(this.key), Buffer.from(this.iv));
    return Buffer.concat([decipher.update(String(ciphertext).trim(), 'base64'), decipher.final()]).toString('utf8');
  }

  signature(encryptedLength, login = false) {
    const sequence = this.sequence + encryptedLength;
    const value = login
      ? `key=${this.key}&iv=${this.iv}&h=${this.passwordHash}&s=${sequence}`
      : `h=${this.passwordHash}&s=${sequence}`;
    let signature = '';
    for (let offset = 0; offset < value.length; offset += this.rsaByteLength) {
      signature += rsaNoPaddingEncrypt(value.slice(offset, offset + this.rsaByteLength), this.publicKey, this.rsaByteLength);
    }
    return signature;
  }

  wrap(plaintext, login = false) {
    const data = this.encrypt(plaintext);
    return { data, sign: this.signature(data.length, login) };
  }
}
