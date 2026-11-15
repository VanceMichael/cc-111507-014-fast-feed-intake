function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { return { format: 'FAST', sourceBytes: bytes.length, firstPresenceMap: bytes.length ? bytes[0] : null }; }
