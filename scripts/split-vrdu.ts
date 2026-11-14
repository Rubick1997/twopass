import { mkdirSync, writeFileSync } from 'node:fs';
import { ensureVrdu, loadVrduDocuments } from '../src/datasets/vrdu.ts';
import { splitVrdu } from '../src/datasets/vrdu-split.ts';

const docs = loadVrduDocuments(await ensureVrdu('data', console.log));
const split = splitVrdu(docs);
mkdirSync('bench/vrdu', { recursive: true });
writeFileSync('bench/vrdu/splits.json', JSON.stringify(split, null, 2) + '\n');
console.log(JSON.stringify({ sizes: split.sizes, templates: split.templates }, null, 2));
