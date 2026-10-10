const crypto = require('node:crypto');
const fs = require('node:fs');

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node migration/decrypt-backup.js <input.enc.json> <output.json>');
  process.exit(2);
}

const keyHex = process.env.MEIHAO_BACKUP_KEY || '';
if (!/^[\da-fA-F]{64}$/.test(keyHex)) {
  console.error('Set MEIHAO_BACKUP_KEY to the 64-character key shared privately by the owner.');
  process.exit(2);
}

try {
  const envelope = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (envelope.format !== 'meihao-diary-aes-256-gcm-v1') throw new Error('Unsupported encrypted backup format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(envelope.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  fs.writeFileSync(outputPath, plaintext, { flag: 'wx' });
  console.log(`Decrypted backup written to ${outputPath}`);
} catch (error) {
  console.error(`Could not decrypt backup: ${error.message}`);
  process.exit(1);
}
