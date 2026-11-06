import { ensureBanking77 } from '../src/datasets/banking77.ts';

const paths = await ensureBanking77('data', console.log);
console.log(`ready: ${paths.train}, ${paths.test}`);
