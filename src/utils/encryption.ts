// backend/src/utils/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "dotenv";
config()
const ENC_KEY_B64 = process.env.TOKEN_ENCRYPTION_KEY!;

/**
 * Encrypt plain token → "iv.ct.tag"
 * Uses AES-256-GCM with 96-bit IV and 128-bit auth tag
 */
export function encryptToken(
    plain: string,
    keyBase64: string = ENC_KEY_B64
): string {
    const key = Buffer.from(keyBase64, "base64");

    if (key.length !== 32) {
        throw new Error("TOKEN_ENCRYPTION_KEY must be 32 raw bytes (base64-encoded)");
    }

    // Generate random 96-bit (12 byte) IV
    const iv = randomBytes(12);

    // Create cipher
    const cipher = createCipheriv("aes-256-gcm", key, iv);

    // Encrypt
    const encrypted = Buffer.concat([
        cipher.update(plain, "utf8"),
        cipher.final(),
    ]);

    // Get auth tag (16 bytes)
    const tag = cipher.getAuthTag();

    // Return as "iv.ciphertext.tag" (all base64)
    const ivB64 = iv.toString("base64");
    const ctB64 = encrypted.toString("base64");
    const tagB64 = tag.toString("base64");

    return `${ivB64}.${ctB64}.${tagB64}`;
}

/**
 * Decrypts a token encrypted with AES-GCM (IV.CIPHERTEXT.AUTH_TAG)
 */
export function decryptToken(
    enc: string,
    keyBase64: string = ENC_KEY_B64
): string {
    const parts = enc.split(".");
    if (parts.length !== 3) {
        throw new Error("Invalid encrypted token format");
    }

    const [ivB64, ctB64, tagB64] = parts;

    const key = Buffer.from(keyBase64, "base64");
    const iv = Buffer.from(ivB64, "base64");
    const ciphertext = Buffer.from(ctB64, "base64");
    const authTag = Buffer.from(tagB64, "base64");

    if (key.length !== 32) {
        throw new Error("TOKEN_ENCRYPTION_KEY must be 32 raw bytes (base64-encoded)");
    }

    // Create decipher
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    return decrypted.toString("utf8");
}