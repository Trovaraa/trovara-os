// Node 25 can expose an incomplete process-level localStorage when no backing
// file is configured. That object shadows jsdom's Storage implementation in
// test workers, so install a small standards-shaped fallback before test
// modules import the app. Browsers never load this test-only file.
if (typeof globalThis.localStorage?.getItem !== 'function') {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key) { return values.get(String(key)) ?? null },
    key(index) { return [...values.keys()][index] ?? null },
    removeItem(key) { values.delete(String(key)) },
    setItem(key, value) { values.set(String(key), String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
}
