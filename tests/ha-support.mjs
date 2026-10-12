import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EtcdClient } from '../src/ha-etcd.mjs';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  throw new Error('Timed out waiting for HA state');
}
export async function port() {
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
export async function cluster(binary) {
  const dir = await mkdtemp(join(tmpdir(), '27g-etcd-ha-'));
  const members = await Promise.all([0, 1, 2].map(async index => ({ index, client: await port(), peer: await port(), process: null })));
  const initial = members.map(member => `voter${member.index}=http://127.0.0.1:${member.peer}`).join(',');
  const start = async member => {
    const child = spawn(binary, [
      `--name=voter${member.index}`, `--data-dir=${join(dir, String(member.index))}`,
      `--listen-client-urls=http://127.0.0.1:${member.client}`, `--advertise-client-urls=http://127.0.0.1:${member.client}`,
      `--listen-peer-urls=http://127.0.0.1:${member.peer}`, `--initial-advertise-peer-urls=http://127.0.0.1:${member.peer}`,
      `--initial-cluster=${initial}`, '--initial-cluster-token=27g-ha-test', '--initial-cluster-state=new',
      '--heartbeat-interval=50', '--election-timeout=500', '--log-level=error', '--max-request-bytes=16777216',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {}); member.process = child;
    child.on('error', error => { member.error = error; });
  };
  const stop = async member => {
    const child = member.process; member.process = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  };
  const endpoints = members.map(member => `http://127.0.0.1:${member.client}`);
  const close = async () => { await Promise.all(members.map(stop)); await rm(dir, { recursive: true, force: true }); };
  try {
    await Promise.all(members.map(start));
    const client = new EtcdClient({ endpoints, timeoutMs: 300 });
    await until(async () => {
      const error = members.find(member => member.error)?.error; if (error) throw error;
      try { await client.read(['/ready']); return true; } catch { return false; }
    });
    return { dir, members, endpoints, client, start, stop, close };
  } catch (error) { await close(); throw error; }
}
export async function proxy(endpoint) {
  const connections = new Set(); const state = { blocked: false };
  const server = http.createServer((req, res) => {
    if (state.blocked) { res.writeHead(503); res.end(); return; }
    const request = http.request(endpoint + req.url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    request.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); }); req.pipe(request);
  });
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, set blocked(value) { state.blocked = value; if (value) for (const socket of connections) socket.destroy(); },
    close: () => new Promise(resolve => { for (const socket of connections) socket.destroy(); server.close(resolve); }) };
}
