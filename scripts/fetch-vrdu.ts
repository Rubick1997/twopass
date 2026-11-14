import { ensureVrdu } from '../src/datasets/vrdu.ts';

const path = await ensureVrdu('data', console.log);
console.log(`ready: ${path}`);
