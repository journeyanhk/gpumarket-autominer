// 取 Gate PEARL 充值地址（只读）。会断言币种身份，避免拿到 Perle(SOL) 的地址。
import fs from 'node:fs';
import crypto from 'node:crypto';
const env = Object.fromEntries(fs.readFileSync('/data/prl-automine/.secrets/gate.env','utf8').trim().split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
const get = async (path, query='') => {
  const t = Math.floor(Date.now()/1000);
  const bh = crypto.createHash('sha512').update('').digest('hex');
  const sg = crypto.createHmac('sha512', env.GATE_API_SECRET).update(`GET\n${path}\n${query}\n${bh}\n${t}`).digest('hex');
  const r = await fetch('https://api.gateio.ws'+path+(query?'?'+query:''), { headers:{KEY:env.GATE_API_KEY,SIGN:sg,Timestamp:String(t),Accept:'application/json'} });
  const txt = await r.text();
  return { status: r.status, body: txt };
};
const cur = JSON.parse((await get('/api/v4/spot/currencies/PEARL')).body);
if (cur.name !== 'Pearl' || !(cur.chains||[]).some(c=>c.name==='PEARL')) { console.error('币种身份不符，拒绝继续:', cur.name, cur.chain); process.exit(2); }
const res = await get('/api/v4/wallet/deposit_address', 'currency=PEARL');
const d = JSON.parse(res.body);
const pearlChain = (d.multichain_addresses||[]).find(a=>a.chain==='PEARL' && a.address);
const addr = pearlChain?.address || (typeof d.address==='string' && d.address.startsWith('prl1') ? d.address : null);
if (!addr) { console.log('尚未生成：', d.address || JSON.stringify(d).slice(0,120)); process.exit(3); }
const memoTag = pearlChain?.memo || pearlChain?.payment_id || d.memo || '';
console.log(JSON.stringify({ currency: 'PEARL', chain: 'PEARL', address: addr, memo: memoTag || null, valid_prl: /^prl1[0-9a-z]{20,}$/.test(addr) }, null, 2));
