// SecureStore-backed storage adapter for the Supabase auth client.
//
// Supabase previously stored the session (JWT + refresh token) in
// AsyncStorage, which is unencrypted on-disk storage — readable on a
// rooted/jailbroken device without needing the OS keychain. expo-secure-store
// uses the OS Keychain (iOS) / Keystore-backed EncryptedSharedPreferences
// (Android) instead, so the tokens are encrypted at rest.
//
// SecureStore enforces a ~2048-byte limit per item on Android, but a
// Supabase session (access + refresh token + user object) is comfortably
// larger than that. This adapter transparently splits a value across
// multiple SecureStore keys ("<key>__0", "<key>__1", ...) and reassembles it
// on read, so it's a drop-in replacement for Supabase's `storage` option.
import * as SecureStore from "expo-secure-store";

// Conservative chunk size in UTF-16 characters, leaving headroom under the
// ~2048-byte Android limit even for keys whose value is mostly multi-byte
// UTF-8 (e.g. non-Latin display names in the JWT payload).
const CHUNK_SIZE = 1800;

function chunkCountKey(key: string): string {
  return `${key}__n`;
}

function chunkKey(key: string, index: number): string {
  return `${key}__${index}`;
}

async function getItem(key: string): Promise<string | null> {
  const countRaw = await SecureStore.getItemAsync(chunkCountKey(key));
  if (countRaw === null) return null;
  const count = parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count <= 0) return null;

  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = await SecureStore.getItemAsync(chunkKey(key, i));
    if (part === null) return null; // Corrupt/partial write — treat as missing.
    parts.push(part);
  }
  return parts.join("");
}

async function setItem(key: string, value: string): Promise<void> {
  // Clear any previous (possibly differently-sized) chunk set first so a
  // shrinking value doesn't leave stale trailing chunks behind.
  await removeItem(key);

  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(value.slice(i, i + CHUNK_SIZE));
  }
  if (chunks.length === 0) chunks.push(""); // Preserve empty-string writes.

  await Promise.all(chunks.map((part, i) => SecureStore.setItemAsync(chunkKey(key, i), part)));
  await SecureStore.setItemAsync(chunkCountKey(key), String(chunks.length));
}

async function removeItem(key: string): Promise<void> {
  const countRaw = await SecureStore.getItemAsync(chunkCountKey(key));
  const count = countRaw ? parseInt(countRaw, 10) : 0;
  const deletes: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    deletes.push(SecureStore.deleteItemAsync(chunkKey(key, i)));
  }
  deletes.push(SecureStore.deleteItemAsync(chunkCountKey(key)));
  await Promise.all(deletes);
}

export const secureStorageAdapter = { getItem, setItem, removeItem };
