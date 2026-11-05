// Empties src/data/ before the converters run, so a route whose source file was
// removed can't linger as a stale generated JSON (and show up in the app).
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data'), { recursive: true, force: true });
