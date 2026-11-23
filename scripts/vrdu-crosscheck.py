"""Cross-check of TwoPass scoring against VRDU's own evaluator (google-research/vrdu, Apache 2.0).

Usage: python3 -I scripts/vrdu-crosscheck.py <dir holding the vrdu/ package> <dir holding main/dataset.jsonl and main/meta.json> <twopass repo> <benchId>
Calls vrdu.benchmark_utils.evaluate on the test runs' enriched-fields.csv and prints micro precision, recall and F1
next to the same counts from our scorer, plus every slot where the two disagree. No model calls.
"""
import sys, json, csv, types, collections
evaldir, base, twopass, bench = sys.argv[1:5]
# editdistance is only used by Address/Price matching, which the registration-form fields don't use.
stub = types.ModuleType('editdistance')
def _no(*a, **k): raise RuntimeError('editdistance stub called')
stub.eval = _no
sys.modules['editdistance'] = stub
sys.path.insert(0, evaldir)
from vrdu import benchmark_utils as bu
csv.field_size_limit(10**9)
b = json.load(open(f'{twopass}/runs/{bench}/bench.json'))
fn = {}
for l in open(f'{twopass}/data/vrdu/documents.jsonl'):
    d = json.loads(l); fn[d['docId']] = d['filename']
gt = bu.DataUtils(base + '/main/')
BOX = (0, 0.0, 0.0, 0.0, 0.0)
out = {}
for name in ('baseline', 'normal'):
    rows = list(csv.DictReader(open(f"{twopass}/runs/{b['testRuns'][name]}/enriched-fields.csv")))
    docs = sorted({r['doc_id'] for r in rows})
    gt.test_filenames = [fn[d] for d in docs]; gt.train_filenames = []; gt.valid_filenames = []
    res = collections.defaultdict(list)
    for r in rows:
        if r['value'] != '': res[fn[r['doc_id']]].append((r['field'], (r['value'], BOX, [])))
    off = bu.evaluate({'meta': {}, 'results': dict(res)}, gt)
    # our scorer, same counting
    ext = sum(r['value'] != '' for r in rows); g = sum(r['gold'] != '' for r in rows)
    tp = sum(r['value'] != '' and r['gold'] != '' and r['correct'] == 'true' for r in rows)
    p, rc = tp / ext, tp / g
    ours = {'precision': p, 'recall': rc, 'f1': 2 * p * rc / (p + rc)}
    # slot-level disagreement where both sides have a value
    ann = {f: dict(gt.annotations[f]) for f in gt.test_filenames}
    dis = collections.Counter(); ex = collections.defaultdict(list); n = 0
    for r in rows:
        cands = ann[fn[r['doc_id']]].get(r['field'])
        if r['value'] == '' or not cands: continue
        n += 1
        o = gt.entity_name_to_match_func[r['field']].match((r['value'], BOX, []), cands)
        m = r['correct'] == 'true'
        if o != m:
            k = (r['field'], 'official yes, ours no' if o else 'ours yes, official no'); dis[k] += 1
            if len(ex[k]) < 4: ex[k].append((r['value'][:60], [c[0][:60] for c in cands][:2]))
    acc_off = None
    out[name] = dict(docs=len(docs), slots=len(rows), official={k: off[k] for k in ('micro_precision','micro_recall','micro_f1','macro_f1')}, ours=ours, compared=n,
                     disagreements={' | '.join(k): v for k, v in dis.items()}, examples={' | '.join(k): v for k, v in ex.items()},
                     per_field_official_f1={f: off[f + '_f1'] for f in ('file_date','foreign_principle_name','registrant_name','registration_num','signer_name','signer_title')})
print(json.dumps(out, indent=1, ensure_ascii=False))
