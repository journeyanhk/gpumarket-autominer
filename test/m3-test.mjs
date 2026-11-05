// M3 测试：接口契约 + 20 条决策快照 + 三条"免疫记忆"的 meta-test
//
// 时间盒判据（用户 2026-11-05）：vast 与 clore 两个 adapter 喂同一套 allocator，
// 同一条报价序列回放出同一个决策 + 同一个原因码。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] || process.cwd();
const U = p => pathToFileURL(path.join(root, p)).href;

const { decide } = await import(U('src/m3/allocator.js'));
const { REASONS, assertMarket, assertCoin, assertNormalized, MARKET_METHODS, COIN_METHODS } = await import(U('src/m3/contract.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const FIX = path.join(root, 'src', 'm3', 'fixtures');
const files = fs.readdirSync(FIX).filter(f => f.endsWith('.json')).sort();

// 三条"免疫记忆"：各自对应一次真实亏损/误判，缺一条就该红
const IMMUNE = {
  'frac=null 但 45 TH（下限池）': '09-vast-2080ti-frac-null-45th.json',
  'thSource=spec（不得参与便宜判定）': '05-vast-3080-th-spec.json',
  'mrl=720h（不算现货）': '07-clore-3080-mrl-720.json',
};

console.log('— 接口契约（只有签名，实现留给 adapter）');
{
  const stubMarket = Object.fromEntries(MARKET_METHODS.map(m => [m, () => {}]));
  const stubCoin = Object.fromEntries(COIN_METHODS.map(m => [m, () => {}]));
  ok(assertMarket(stubMarket), 'Market 四方法齐全即通过');
  let threw = null; try { assertMarket({ listOffers: () => {} }); } catch (e) { threw = e.message; }
  ok(/缺 normalizeOffer/.test(threw || ''), `缺方法会被点名：${(threw || '未抛错').slice(0, 40)}`);
  ok(assertCoin(stubCoin), 'Coin 三方法齐全即通过');
  let threw2 = null; try { assertCoin({ specOf: () => {} }); } catch (e) { threw2 = e.message; }
  ok(/缺 revenuePerUnit/.test(threw2 || ''), 'Coin 缺方法会被点名');
  let threw3 = null; try { assertNormalized({ id: 1, market: 'vast' }); } catch (e) { threw3 = e.message; }
  ok(/归一化缺字段/.test(threw3 || ''), '归一化缺字段会被拦（缓存少字段那类 bug 的入口）');
}

console.log(`— 20 条决策快照（fixtures: ${files.length}）`);
{
  let mismatch = 0;
  for (const f of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    assertNormalized(fx.offer, f);
    const got = decide(fx.offer, fx.ctx);
    if (got.reasonCode !== fx.expect) {
      mismatch++;
      console.log(`  ✗ ${f}：期望 ${fx.expect}，实际 ${got.action}/${got.reasonCode}`);
    }
  }
  ok(mismatch === 0, `${files.length} 条快照全部复现（不一致 ${mismatch} 条）`);
  ok(files.length >= 20, `快照数 ${files.length} ≥ 20`);
}

console.log('— 免疫记忆：删掉 fixture，测试必须变红');
{
  // meta-test：在临时副本里删掉一条免疫 fixture，覆盖率检查必须失败
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-meta-'));
  fs.cpSync(FIX, tmp, { recursive: true });
  const checkCoverage = (dir) => {
    const names = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.json')));
    const missing = Object.entries(IMMUNE).filter(([, file]) => !names.has(file)).map(([tag]) => tag);
    if (missing.length) throw new Error(`免疫记忆缺失：${missing.join('；')}`);
    return true;
  };
  ok(checkCoverage(tmp) === true, '三条免疫记忆齐全');
  fs.unlinkSync(path.join(tmp, IMMUNE['mrl=720h（不算现货）']));
  let threw = null; try { checkCoverage(tmp); } catch (e) { threw = e.message; }
  ok(/免疫记忆缺失/.test(threw || ''), `删掉 mrl=720h 后覆盖率检查变红：${(threw || '未抛错').slice(0, 34)}`);

  // 再验证语义：那条 fixture 若被误判成 rent，等价于把 30 天锁仓当现货
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, IMMUNE['mrl=720h（不算现货）']), 'utf8'));
  const got = decide(fx.offer, fx.ctx);
  ok(got.reasonCode === REASONS.leaseTooLong, `mrl=720h 的原因码是 ${got.reasonCode}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('— 两个 adapter 同一 allocator（vast vs clore 同价同算力 → 同决策）');
{
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, '16-clore-3090-rent.json'), 'utf8'));
  const asVast = { ...fx.offer, market: 'vast' };
  const a = decide(fx.offer, fx.ctx), b = decide(asVast, fx.ctx);
  ok(a.action === b.action && a.reasonCode === b.reasonCode && a.expRoi === b.expRoi,
    `同一报价换场所不改结论（${a.action}/${a.reasonCode} expRoi ${a.expRoi}）`);
}

console.log(fail ? `\nM3 测试失败：${fail} 项` : `\nM3 测试通过（${pass} 项）`);
process.exit(fail ? 1 : 0);