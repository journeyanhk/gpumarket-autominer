// PRL × vast.ai 自动租卡挖矿 —— 本地网页控制台
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);

// Node 版本检查（原来写在 bat 里，被杀毒软件当成可疑脚本，挪到这里）
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 22) {
  console.error(`\n  Node.js 版本太旧（当前 ${process.versions.node}），需要 22 或以上。\n  Windows 双击「一键启动.bat」、Mac/Linux 运行 ./start.sh 会自动下载便携版；也可以到 https://nodejs.org 安装最新 LTS 版\n`);
  process.exit(1);
}

// 启动后用系统默认浏览器打开控制台（原来写在 bat 里，同上挪到这里）
function openBrowser(url) {
  if (process.env.PRL_NO_BROWSER) return;
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { const c = spawn(cmd, [url], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch {}
}

const { loadConfig } = await import('./src/store.js');

// 配了代理：用 Node 自带的环境变量代理（Node ≥ 22.21 / 24.5 支持 NODE_USE_ENV_PROXY）重启自己
const boot = loadConfig();
if (boot.proxy && !process.env.PRL_PROXY_APPLIED) {
  const env = { ...process.env, PRL_PROXY_APPLIED: '1', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: boot.proxy, HTTP_PROXY: boot.proxy, NO_PROXY: '127.0.0.1,localhost' };
  const child = spawn(process.execPath, process.argv.slice(1), { env, stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
} else {
  const { Engine } = await import('./src/engine.js');
  const engine = new Engine();
  engine.start();

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const body = req => new Promise((ok, bad) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('请求格式错误')); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      // 只接受本机访问，防止局域网其他人操作你的账户
      const ra = req.socket.remoteAddress || '';
      if (!/^(::1|127\.|::ffff:127\.)/.test(ra)) return send(res, 403, { error: '仅允许本机访问' });

      if (p === '/api/state' && req.method === 'GET') return send(res, 200, engine.snapshot());
      if (p === '/api/settings' && req.method === 'POST') return send(res, 200, { ok: true, ...engine.updateConfig(await body(req)) });
      if (p === '/api/scan' && req.method === 'POST') { await engine.scan(true); return send(res, 200, { ok: true }); }
      let m;
      if ((m = p.match(/^\/api\/rent\/(\d+)$/)) && req.method === 'POST') {
        const offer = engine.offers.find(o => String(o.id) === m[1]);
        if (!offer) return send(res, 404, { error: '这个机器已不在最新扫描结果里，刷新后再试' });
        const id = await engine.rent(offer, 'manual');
        return send(res, 200, { ok: true, id });
      }
      if ((m = p.match(/^\/api\/instances\/(\d+)\/destroy$/)) && req.method === 'POST') {
        await engine.destroy(m[1], '手动退租');
        return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/instances\/(\d+)\/logs$/)) && req.method === 'GET') {
        const v = await engine.fetchLogs(m[1], true);
        return send(res, 200, { ok: true, t: v.t, text: v.text, hint: engine.logHint(m[1]) });
      }
      if ((m = p.match(/^\/api\/instances\/(\d+)\/reboot$/)) && req.method === 'POST') {
        await engine.reboot(m[1]);
        return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/instances\/(\d+)\/pool$/)) && req.method === 'POST') {
        const b = await body(req);
        await engine.setPool(m[1], String(b.pool || ''));
        return send(res, 200, { ok: true });
      }
      if (p === '/api/pools/switch-all' && req.method === 'POST') {
        const b = await body(req);
        return send(res, 200, { ok: true, ...(await engine.switchAll(String(b.to || ''), b.from ? String(b.from) : null)) });
      }
      if ((m = p.match(/^\/api\/instances\/(\d+)\/pin$/)) && req.method === 'POST') {
        const b = await body(req);
        return send(res, 200, { ok: true, ...engine.setPinned(m[1], b.pinned !== false) });
      }
      if ((m = p.match(/^\/api\/instances\/(\d+)\/alias$/)) && req.method === 'POST') {
        const b = await body(req);
        engine.setAlias(m[1], (b.worker || '').trim());
        return send(res, 200, { ok: true });
      }
      if (p.startsWith('/api/')) return send(res, 404, { error: '接口不存在' });

      const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : path.normalize(p).replace(/^([/\\])+/, ''));
      if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });

  const port = engine.cfg.port || 8290;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.error(`\n端口 ${port} 被占用：程序可能已经在运行，已帮你打开 http://127.0.0.1:${port}\n`); openBrowser(`http://127.0.0.1:${port}`); }
    else console.error(e);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  PRL 自动租卡挖矿控制台已启动： http://127.0.0.1:${port}\n  关闭这个窗口即停止程序（已租的机器不会被销毁）\n`);
    openBrowser(`http://127.0.0.1:${port}`);
  });
}
