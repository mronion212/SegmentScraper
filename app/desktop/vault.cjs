const { readFile, writeFile, mkdir, rename } = require('node:fs/promises');
const path = require('node:path');

// Only ciphertext is persisted. Decryption and provider requests stay in the main process.
class CredentialVault {
  constructor(file, encryption) { this.file = file; this.encryption = encryption; this.pending = Promise.resolve(); }
  async read() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Opgeslagen accounts konden niet worden gelezen.'); }
  }
  async list() { return Object.keys(await this.read()).filter(key => ['torbox', 'real-debrid'].includes(key)); }
  async get(provider) {
    const cipher = (await this.read())[provider];
    if (!cipher) throw new Error('Geen opgeslagen account.');
    return this.encryption.decrypt(Buffer.from(cipher, 'base64'));
  }
  update(provider, token) {
    const operation = this.pending.catch(() => {}).then(async () => {
      if (!['torbox', 'real-debrid'].includes(provider)) throw new Error('Onbekende provider.');
      const records = await this.read();
      if (token === null) delete records[provider];
      else records[provider] = (await this.encryption.encrypt(token)).toString('base64');
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify(records), { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    });
    this.pending = operation; return operation;
  }
  save(provider, token) { return this.update(provider, token); }
  remove(provider) { return this.update(provider, null); }
}
module.exports = { CredentialVault };
