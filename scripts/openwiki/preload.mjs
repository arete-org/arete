import { createTransport } from './transport.mjs';

// The pinned ChatOpenRouter client uses global fetch. Preload before OpenWiki
// installs its diagnostic wrapper so every provider attempt obeys our limits.
// Creating it here also starts the run deadline when the OpenWiki process starts.
globalThis.fetch = createTransport({ fetch: globalThis.fetch });
