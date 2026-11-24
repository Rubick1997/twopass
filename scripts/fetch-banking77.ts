import { ensureBanking77 } from '../src/datasets/banking77.ts';

// --train-only: the eval gate's CI needs the train split only and never downloads the test split.
const trainOnly = process.argv.includes('--train-only');
const paths = await ensureBanking77('data', console.log, trainOnly ? ['train'] : ['test', 'train']);
console.log(trainOnly ? `ready: ${paths.train}` : `ready: ${paths.train}, ${paths.test}`);
