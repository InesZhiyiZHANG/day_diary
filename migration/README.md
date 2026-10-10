# Encrypted diary migration

`shared-diary.enc.json` contains only the shared diary state. It does not contain member accounts, password hashes, sessions, or invite codes. The file is encrypted with AES-256-GCM and a random 256-bit key.

The owner must share the key with the deployment administrator through a private channel. Never add the key to GitHub or send it in a public issue.

## Decrypt on Windows

Install Node.js 18 or later, then run PowerShell from the repository directory:

```powershell
$env:MEIHAO_BACKUP_KEY = '<key shared privately by the owner>'
node migration/decrypt-backup.js migration/shared-diary.enc.json data/import-from-owner.json
Remove-Item Env:MEIHAO_BACKUP_KEY
```

The output is a normal diary backup JSON. Start the app on the server, create the first member account, log in, and use the **Shared diary ? Import backup** action to merge it into the server database. Keep the decrypted file out of Git and delete it after import. The server must keep `data/shared-diary.sqlite3` on persistent storage and back it up separately.

To encrypt a new JSON backup, run `node migration/encrypt-backup.js <input.json> <output.enc.json>` and store the printed key privately.
