const crypto = require('node:crypto');
const fs = require('node:fs');

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node migration/encrypt-backup.js <input.json> <output.enc.json>');
  process.exit(2);
}

const plaintext = fs.readFileSync(inputPath);
const key = crypto.randomBytes(32);
const nonce = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const envelope = {
  format: 'meihao-diary-aes-256-gcm-v1',
  nonce: nonce.toString('base64'),
  tag: cipher.getAuthTag().toString('base64'),
  ciphertext: ciphertext.toString('base64'),
};
fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx' });
console.log(`Decryption key (save privately; never commit it): ${key.toString('hex')}`);
