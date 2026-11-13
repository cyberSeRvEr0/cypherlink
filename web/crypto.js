/**
 * Cypherlink — AES-256-GCM encryption using WebCrypto API.
 * The group key is derived from the invite key via HKDF.
 */

export class CypherlinkCrypto {
  constructor(inviteKey) {
    this._key = null;
    this._deriveKey(inviteKey);
  }

  async _deriveKey(inviteKey) {
    // HKDF-SHA256 to derive a 256-bit AES key from the invite key
    const ikm = new TextEncoder().encode(inviteKey);
    const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    this._key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('cypherlink-v1') },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encrypt(plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit nonce
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this._key,
      new TextEncoder().encode(plaintext)
    );
    return { iv: btoa(String.fromCharCode(...iv)), ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))) };
  }

  async decrypt(ivB64, ctB64) {
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this._key,
      ct
    );
    return new TextDecoder().decode(pt);
  }
}   